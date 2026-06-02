import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  JobLockUnavailableError,
  readPidStartTime,
  resolveJobFile,
  withJobLock,
  writeJobFileForTest
} from "../plugins/codex/scripts/lib/state.mjs";
import { handleSessionStart } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");

function readStoredJob(workspace, jobId) {
  return JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
}

function hookEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "CLAUDE_ENV_FILE",
    "CLAUDE_PLUGIN_DATA",
    "CODEX_COMPANION_SESSION_ID",
    "CODEX_PLUGIN_STALE_TTL_TASK_MS",
    "CODEX_PLUGIN_STALE_TTL_REVIEW_MS",
    "CODEX_PLUGIN_PROGRESS_TIMEOUT_MS"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) {
      delete env[key];
    }
  }
  return env;
}

function runSessionStart(input, env = {}, options = {}) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT, "SessionStart"], {
    cwd: REPO_ROOT,
    env: hookEnv(env),
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    timeout: options.timeoutMs,
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function waitForExit(child, label, timeoutMs = 5000) {
  let timeout;
  return Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort cleanup for a timed-out child.
        }
        reject(new Error(`${label} timed out`));
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

async function getExitedPid() {
  const child = spawn(process.execPath, ["-e", ""], {
    cwd: REPO_ROOT,
    stdio: "ignore"
  });
  const pid = child.pid;
  await waitForExit(child, "exited pid probe");
  return pid;
}

async function waitForPidStartTime(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startTime = readPidStartTime(pid);
    if (startTime != null) {
      return startTime;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for pidStartTime for ${pid}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await waitForExit(child, "child cleanup", 1000);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await waitForExit(child, "child cleanup after SIGKILL", 1000).catch(() => {});
  }
}

async function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = function (chunk, ...args) {
    stderr += String(chunk);
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) {
      callback();
    }
    return true;
  };
  try {
    await fn();
    return stderr;
  } finally {
    process.stderr.write = originalWrite;
  }
}

test("SessionStart reaps dead active jobs and continues", async () => {
  const workspace = makeTempDir();
  const jobId = "lifecycle-dead-job";
  const timestamp = new Date().toISOString();
  const pid = await getExitedPid();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid,
    pidStartTime: "dead-process",
    progressUpdatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const result = runSessionStart({ hook_event_name: "SessionStart", session_id: "session-reap", cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session-start: reaped 1 dead\/stale jobs \(lifecycle-dead-job\)/);
  const record = readStoredJob(workspace, jobId);
  assert.equal(record.status, "failed");
  assert.equal(record.phase, "failed");
  assert.equal(record.pid, null);
  assert.equal(record.progressUpdatedAt, null);
  assert.equal(record.staleness, null);
});

test("SessionStart tags alive stale jobs without terminalizing them", async (t) => {
  const workspace = makeTempDir();
  const jobId = "lifecycle-stale-live-job";
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: REPO_ROOT,
    stdio: "ignore"
  });
  t.after(() => stopChild(sleeper));

  const pidStartTime = await waitForPidStartTime(sleeper.pid);
  const timestamp = new Date().toISOString();
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: sleeper.pid,
    pidStartTime,
    startedAt: timestamp,
    progressUpdatedAt: new Date(Date.now() - 400_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const result = runSessionStart({ hook_event_name: "SessionStart", session_id: "session-stale", cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session-start: tagged 1 stale jobs \(run \/codex:cancel --all-stale to clear\)/);
  assert.doesNotMatch(result.stderr, /session-start: reaped/);
  const record = readStoredJob(workspace, jobId);
  assert.equal(record.status, "running");
  assert.equal(record.pid, sleeper.pid);
  assert.deepEqual(record.staleness.reasons, ["progress-stalled"]);
});

test("SessionStart skips contended reconcile locks quickly and appends env vars", () => {
  const pidStartTime = readPidStartTime(process.pid);
  if (pidStartTime == null) {
    return;
  }

  const workspace = makeTempDir();
  const envFile = path.join(workspace, "claude-env.sh");
  const pluginData = path.join(workspace, "plugin data");
  const jobId = "lifecycle-contended-stale-job";
  const timestamp = new Date().toISOString();
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    writeJobFileForTest(workspace, jobId, {
      id: jobId,
      status: "running",
      phase: "working",
      pid: process.pid,
      pidStartTime,
      startedAt: timestamp,
      progressUpdatedAt: new Date(Date.now() - 400_000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp
    });

    let result = null;
    let elapsedMs = null;
    withJobLock(workspace, jobId, () => {
      const startedAt = Date.now();
      result = runSessionStart(
        { hook_event_name: "SessionStart", session_id: "session-contended", cwd: workspace },
        { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData },
        { timeoutMs: 2000 }
      );
      elapsedMs = Date.now() - startedAt;
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(elapsedMs < 1500, true, `SessionStart took ${elapsedMs}ms`);
    assert.match(result.stderr, /session-start: reconcile warning:/);
    assert.match(result.stderr, /lifecycle-contended-stale-job reconcile-skipped:/);
    assert.doesNotMatch(result.stderr, /session-start: tagged/);

    const envContents = fs.readFileSync(envFile, "utf8");
    assert.match(envContents, /^export CODEX_COMPANION_SESSION_ID='session-contended'$/m);
    assert.match(envContents, new RegExp(`^export CLAUDE_PLUGIN_DATA='${pluginData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));

    const record = readStoredJob(workspace, jobId);
    assert.equal(record.status, "running");
    assert.equal(record.staleness, undefined);
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("SessionStart renders JobLockUnavailableError as a reconcile-skipped warning", async () => {
  const workspace = makeTempDir();

  const stderr = await captureStderr(async () => {
    await assert.doesNotReject(async () =>
      handleSessionStart(
        { hook_event_name: "SessionStart", session_id: "session-lock-unavailable", cwd: workspace },
        (cwd, opts) => {
          assert.equal(cwd, workspace);
          assert.deepEqual(opts, { nonblocking: true });
          throw new JobLockUnavailableError("di-held-job");
        }
      )
    );
  });

  assert.match(stderr, /session-start: reconcile warning: di-held-job reconcile-skipped:/);
  assert.doesNotMatch(stderr, /session-start: reconcile failed:/);
});

test("SessionStart swallows reconcile failures after appending env vars", async () => {
  const workspace = makeTempDir();
  const envFile = path.join(workspace, "claude-env.sh");
  const pluginData = path.join(workspace, "plugin data");
  const previousEnvFile = process.env.CLAUDE_ENV_FILE;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    process.env.CLAUDE_ENV_FILE = envFile;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;

    const stderr = await captureStderr(async () => {
      await assert.doesNotReject(async () =>
        handleSessionStart(
          { hook_event_name: "SessionStart", session_id: "session-failure", cwd: workspace },
          (cwd, opts) => {
            assert.equal(cwd, workspace);
            assert.deepEqual(opts, { nonblocking: true });
            throw new Error("forced reconcile failure");
          }
        )
      );
    });

    assert.match(stderr, /session-start: reconcile failed: forced reconcile failure/);
    const envContents = fs.readFileSync(envFile, "utf8");
    assert.match(envContents, /^export CODEX_COMPANION_SESSION_ID='session-failure'$/m);
    assert.match(envContents, new RegExp(`^export CLAUDE_PLUGIN_DATA='${pluginData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
  } finally {
    if (previousEnvFile === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previousEnvFile;
    }
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});
