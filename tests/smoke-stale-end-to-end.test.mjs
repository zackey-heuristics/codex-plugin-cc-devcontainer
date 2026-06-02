// End-to-end smoke for Issue #11: fabricate a stale-tagged job against a real
// per-workspace state directory, then exercise the user-visible surfaces
// (/codex:status, /codex:cancel --all-stale, SessionStart hook) by spawning
// the same scripts the slash commands invoke. Asserts the operator-facing
// strings AND the round-trip (stale → cancel → clean) so a regression in
// rendering or batch exit semantics fails CI even when the underlying
// reconciler unit tests stay green.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  readPidStartTime,
  resolveJobFile,
  writeJobFileForTest
} from "../plugins/codex/scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SCRIPT = path.join(REPO_ROOT, "plugins/codex/scripts/codex-companion.mjs");
const HOOK_SCRIPT = path.join(REPO_ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");

function smokeEnv(extra = {}) {
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
  // Keep the batch interrupt fast: there is no real broker in this smoke,
  // so the disposable client's connect failure should bubble up quickly
  // and the timeout race should not dominate wall-clock.
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS")) {
    env.CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS = "200";
  }
  return env;
}

function runCompanion(args, workspace, extraEnv = {}) {
  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: workspace,
    env: smokeEnv(extraEnv),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runSessionStart(workspace) {
  const input = {
    hook_event_name: "SessionStart",
    session_id: "smoke-session",
    cwd: workspace
  };
  const result = spawnSync(process.execPath, [HOOK_SCRIPT, "SessionStart"], {
    cwd: REPO_ROOT,
    env: smokeEnv(),
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
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

async function spawnSleeper(t) {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: REPO_ROOT,
    stdio: "ignore"
  });
  t.after(() => stopChild(sleeper));
  const pidStartTime = await waitForPidStartTime(sleeper.pid);
  return { pid: sleeper.pid, pidStartTime };
}

function plantLiveStaleJob(workspace, jobId, pid, pidStartTime) {
  const timestamp = new Date().toISOString();
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    kind: "task",
    status: "running",
    phase: "working",
    pid,
    pidStartTime,
    startedAt: timestamp,
    // 6+ min past the 5 min PROGRESS_TIMEOUT_MS default so the reconciler
    // tags it as progress-stalled rather than fresh.
    progressUpdatedAt: new Date(Date.now() - 400_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function readStoredJob(workspace, jobId) {
  return JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
}

test("smoke: /codex:status renders a stale job, then /codex:cancel --all-stale clears it", async (t) => {
  const workspace = makeTempDir("codex-smoke-status-");
  const jobId = "smoke-status-stale";
  const { pid, pidStartTime } = await spawnSleeper(t);
  plantLiveStaleJob(workspace, jobId, pid, pidStartTime);

  // Phase 1 — /codex:status surfaces the stale row.
  const statusBefore = runCompanion(["status"], workspace);
  assert.equal(statusBefore.status, 0, statusBefore.stderr);
  // The Active table renders a human label for `progress-stalled`. Match the
  // canonical label whitelist from render.mjs (`STALE_REASON_LABELS`).
  assert.match(
    statusBefore.stdout,
    /progress stalled/i,
    `expected the stale reason in status output:\n${statusBefore.stdout}`
  );
  assert.match(
    statusBefore.stdout,
    new RegExp(jobId),
    "expected the planted job id in the active table"
  );
  // Operator-visible "Stale: N (see rows)" summary should count the row.
  assert.match(statusBefore.stdout, /Stale jobs: 1/);

  // Phase 2 — /codex:cancel --all-stale clears it.
  const cancelResult = runCompanion(["cancel", "--all-stale"], workspace);
  assert.equal(
    cancelResult.status,
    0,
    `cancel --all-stale exited non-zero:\nstdout=${cancelResult.stdout}\nstderr=${cancelResult.stderr}`
  );
  assert.match(
    cancelResult.stdout + cancelResult.stderr,
    new RegExp(jobId),
    "expected the cancelled job id in cancel output"
  );

  // Phase 3 — on-disk record is now terminal.
  const finalRecord = readStoredJob(workspace, jobId);
  assert.ok(
    ["cancelled", "failed"].includes(finalRecord.status),
    `expected terminal status after cancel, got ${finalRecord.status}`
  );

  // Phase 4 — subsequent /codex:status no longer counts the row as stale.
  const statusAfter = runCompanion(["status"], workspace);
  assert.equal(statusAfter.status, 0, statusAfter.stderr);
  assert.doesNotMatch(
    statusAfter.stdout,
    /Stale jobs: [1-9]/,
    `expected no stale-active rows after cancel:\n${statusAfter.stdout}`
  );
});

test("smoke: SessionStart hook tags a stale job and /codex:cancel --all-stale finishes the round-trip", async (t) => {
  const workspace = makeTempDir("codex-smoke-hook-");
  const jobId = "smoke-hook-stale";
  const { pid, pidStartTime } = await spawnSleeper(t);
  plantLiveStaleJob(workspace, jobId, pid, pidStartTime);

  // Phase 1 — SessionStart hook tags the job stale and prints the operator
  // hint pointing at /codex:cancel --all-stale.
  const sessionStart = runSessionStart(workspace);
  assert.equal(sessionStart.status, 0, sessionStart.stderr);
  assert.match(
    sessionStart.stderr,
    /session-start: tagged 1 stale jobs \(run \/codex:cancel --all-stale to clear\)/,
    `expected the tagged-stale hint in SessionStart stderr:\n${sessionStart.stderr}`
  );
  assert.doesNotMatch(
    sessionStart.stderr,
    /session-start: reaped/,
    "alive PID must NOT be reaped — only tagged"
  );

  // The on-disk record should be tagged stale but still active (worker is
  // alive; the hook never kills live workers).
  const tagged = readStoredJob(workspace, jobId);
  assert.equal(tagged.status, "running");
  assert.ok(
    tagged.staleness?.reasons?.includes("progress-stalled"),
    `expected staleness tagged, got ${JSON.stringify(tagged.staleness)}`
  );

  // Phase 2 — /codex:cancel --all-stale completes the round-trip.
  const cancelResult = runCompanion(["cancel", "--all-stale"], workspace);
  assert.equal(
    cancelResult.status,
    0,
    `cancel --all-stale exited non-zero:\nstdout=${cancelResult.stdout}\nstderr=${cancelResult.stderr}`
  );

  const finalRecord = readStoredJob(workspace, jobId);
  assert.ok(
    ["cancelled", "failed"].includes(finalRecord.status),
    `expected terminal status after cancel, got ${finalRecord.status}`
  );
});
