import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { runCommand } from "../plugins/codex/scripts/lib/process.mjs";
import { listJobs, readPidStartTime, resolveJobFile, resolveStateDir, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForPidGone(pid, options = {}) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return true;
      }
      throw error;
    }
  }, options);
}

function runCompanionWithDeadline(args, { cwd, env = process.env, timeoutMs = 1000 } = {}) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd,
    env
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 200).unref?.();
    }, timeoutMs);

    child.on("exit", (status, signal) => {
      clearTimeout(killTimer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function seedRuntimeJob(workspace, patch) {
  return upsertJob(workspace, {
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    startedAt: new Date().toISOString(),
    progressUpdatedAt: new Date().toISOString(),
    pid: null,
    pidStartTime: null,
    ...patch
  });
}

function installNeverRespondingCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex fake");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(0);
}

if (process.env.CODEX_TEST_APP_SERVER_PID_FILE) {
  fs.writeFileSync(process.env.CODEX_TEST_APP_SERVER_PID_FILE, String(process.pid), "utf8");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "turn/interrupt") {
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
}

function installInterruptThenCloseHangingCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex fake");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(0);
}

if (process.env.CODEX_TEST_APP_SERVER_PID_FILE) {
  fs.writeFileSync(process.env.CODEX_TEST_APP_SERVER_PID_FILE, String(process.pid), "utf8");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
}

function installPreflightHangingCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.on("SIGTERM", () => {});
if (args[0] === "--version" || (args[0] === "app-server" && args[1] === "--help")) {
  if (process.env.CODEX_TEST_PREFLIGHT_MARKER) {
    fs.writeFileSync(process.env.CODEX_TEST_PREFLIGHT_MARKER, args.join(" "), "utf8");
  }
  process.stdin.resume();
  setInterval(() => {}, 1000);
  return;
}
if (args[0] === "app-server") {
  console.error("fake app-server reached after preflight bypass");
  process.exit(42);
}
process.exit(0);
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
}

function installSuccessfulInterruptCodex(binDir, sigtermMarker) {
  const scriptPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const marker = ${JSON.stringify(sigtermMarker)};

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex fake");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(0);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
}

function writeCancelAllStaleMutationPreload(workspace) {
  const preloadPath = path.join(workspace, `cancel-all-stale-preload-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.CODEX_TEST_MUTATE_JOB_FILE
  ? path.resolve(process.env.CODEX_TEST_MUTATE_JOB_FILE)
  : null;
const mode = process.env.CODEX_TEST_MUTATE_JOB_MODE;
const readyFile = process.env.CODEX_TEST_MUTATE_READY_FILE
  ? path.resolve(process.env.CODEX_TEST_MUTATE_READY_FILE)
  : null;
const continueFile = process.env.CODEX_TEST_MUTATE_CONTINUE_FILE
  ? path.resolve(process.env.CODEX_TEST_MUTATE_CONTINUE_FILE)
  : null;
const skipStaleReads = Number(process.env.CODEX_TEST_MUTATE_SKIP_STALE_READS || "0");
let mutated = false;
let staleReadCount = 0;

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalUnlinkSync = fs.unlinkSync.bind(fs);
const originalMkdirSync = fs.mkdirSync.bind(fs);

function normalizeFile(file) {
  if (typeof file === "string") {
    return file;
  }
  if (file instanceof URL) {
    return fileURLToPath(file);
  }
  return null;
}

function waitForContinueFile() {
  if (readyFile) {
    originalWriteFileSync(readyFile, "ready\\n", "utf8");
  }
  if (!continueFile) {
    return;
  }
  const sleepView = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(continueFile)) {
    Atomics.wait(sleepView, 0, 0, 10);
  }
}

fs.readFileSync = function (file, ...args) {
  const result = originalReadFileSync(file, ...args);
  const filePath = normalizeFile(file);
  if (!mutated && target && filePath && path.resolve(filePath) === target) {
    try {
      const record = JSON.parse(String(result));
      const staleReasons = record?.staleness?.reasons;
      if ((record?.status === "queued" || record?.status === "running") && Array.isArray(staleReasons) && staleReasons.length > 0) {
        staleReadCount += 1;
        if (staleReadCount <= skipStaleReads) {
          return result;
        }
        mutated = true;
        if (mode === "terminalize") {
          const timestamp = new Date().toISOString();
          originalWriteFileSync(
            target,
            JSON.stringify(
              {
                ...record,
                status: "completed",
                phase: "done",
                completedAt: timestamp,
                updatedAt: timestamp,
                staleness: null
              },
              null,
              2
            ) + "\\n",
            "utf8"
          );
        } else if (mode === "refresh-progress") {
          const timestamp = new Date().toISOString();
          originalWriteFileSync(
            target,
            JSON.stringify(
              {
                ...record,
                progressUpdatedAt: timestamp,
                updatedAt: timestamp,
                staleness: null
              },
              null,
              2
            ) + "\\n",
            "utf8"
          );
        } else if (mode === "replace-with-directory") {
          originalUnlinkSync(target);
          originalMkdirSync(target);
        } else if (mode === "pause-on-stale-read") {
          waitForContinueFile();
        }
      }
    } catch {
      // Leave unrelated reads alone.
    }
  }
  return result;
};
`,
    "utf8"
  );
  return preloadPath;
}

function writeCancelAllStaleSignalFailurePreload(workspace, pid) {
  const preloadPath = path.join(workspace, `cancel-all-stale-signal-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
const targetPid = ${JSON.stringify(pid)};
const originalKill = process.kill.bind(process);

process.kill = function (pid, signal) {
  const numericPid = Number(pid);
  if (signal === "SIGTERM" && Math.abs(numericPid) === targetPid) {
    const error = new Error("forced SIGTERM failure for test");
    error.code = "EPERM";
    throw error;
  }
  return originalKill(pid, signal);
};
`,
    "utf8"
  );
  return preloadPath;
}

function writePlatformOverridePreload(workspace, platform) {
  const preloadPath = path.join(workspace, `platform-override-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
Object.defineProperty(process, "platform", {
  value: ${JSON.stringify(platform)},
  configurable: true
});
`,
    "utf8"
  );
  return preloadPath;
}

function writeCancelAllStaleIdentityDriftPreload(workspace, pid, signalMarker, deadOnCheck = 3) {
  const preloadPath = path.join(workspace, `cancel-all-stale-identity-drift-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
import fs from "node:fs";

const targetPid = ${JSON.stringify(pid)};
const marker = ${JSON.stringify(signalMarker)};
const deadOnCheck = ${JSON.stringify(deadOnCheck)};
const originalKill = process.kill.bind(process);
let identityChecks = 0;

process.kill = function (pid, signal) {
  const numericPid = Number(pid);
  if (Math.abs(numericPid) === targetPid && signal === 0) {
    identityChecks += 1;
    if (identityChecks >= deadOnCheck) {
      const error = new Error("simulated process exit before signal");
      error.code = "ESRCH";
      throw error;
    }
    return true;
  }
  if (Math.abs(numericPid) === targetPid && signal === "SIGTERM") {
    fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  }
  return originalKill(pid, signal);
};
`,
    "utf8"
  );
  return preloadPath;
}

function writeCancelAllStaleUnreadableStartTimePreload(workspace, pid) {
  const preloadPath = path.join(workspace, `cancel-all-stale-unreadable-start-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
import fs from "node:fs";

const target = ${JSON.stringify(`/proc/${pid}/stat`)};
const originalReadFileSync = fs.readFileSync.bind(fs);
let statReads = 0;

fs.readFileSync = function (file, ...args) {
  if (String(file) === target) {
    statReads += 1;
    if (statReads >= 3) {
      const error = new Error("simulated unreadable pid start time");
      error.code = "ENOENT";
      throw error;
    }
  }
  return originalReadFileSync(file, ...args);
};
`,
    "utf8"
  );
  return preloadPath;
}

function writeCancelAllStaleMismatchedStartTimePreload(workspace, pid, mismatchOnRead = 2) {
  const preloadPath = path.join(workspace, `cancel-all-stale-mismatch-start-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    preloadPath,
    `
import fs from "node:fs";

const target = ${JSON.stringify(`/proc/${pid}/stat`)};
const mismatchOnRead = ${JSON.stringify(mismatchOnRead)};
const originalReadFileSync = fs.readFileSync.bind(fs);
let statReads = 0;

function withDifferentStartTime(stat) {
  const text = String(stat);
  const commEnd = text.lastIndexOf(")");
  if (commEnd === -1) {
    return stat;
  }
  const fields = text.slice(commEnd + 1).split(/\\s+/);
  fields[20] = String(Number(fields[20] || "0") + 1);
  return text.slice(0, commEnd + 1) + fields.join(" ");
}

fs.readFileSync = function (file, ...args) {
  const result = originalReadFileSync(file, ...args);
  if (String(file) === target) {
    statReads += 1;
    if (statReads >= mismatchOnRead) {
      return withDifferentStartTime(result);
    }
  }
  return result;
};
`,
    "utf8"
  );
  return preloadPath;
}

function envWithNodeImport(env, preloadPath) {
  const importOption = `--import=${pathToFileURL(preloadPath).href}`;
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, importOption].filter(Boolean).join(" ")
  };
}

function installSlowInterruptCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex fake");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(0);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "turn/interrupt") {
    const delayMs = Number(process.env.CODEX_TEST_INTERRUPT_DELAY_MS || "150");
    setTimeout(() => send({ id: message.id, result: {} }), delayMs);
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 10));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
}

test("runCommand timeoutMs option times out and reports failure", () => {
  const result = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 50
  });

  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
});

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = fs.readFileSync(listJobs(repo)[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id and plugin data dir for later commands", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = fs.readFileSync(listJobs(repo)[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = fs.readFileSync(listJobs(repo)[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task ignores unrelated buffered collab receiver metadata", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-unrelated-buffered-collab");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "handle the current task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");

  const log = fs.readFileSync(listJobs(repo)[0].logFile, "utf8");
  assert.doesNotMatch(log, /unrelated-intruder/);
  assert.doesNotMatch(log, /UNRELATED SUBAGENT OUTPUT SHOULD NOT APPEAR/);
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        threadId: "thr_done",
        summary: "Review main...HEAD",
        createdAt: "2026-03-18T15:10:00.000Z",
        startedAt: "2026-03-18T15:10:05.000Z",
        completedAt: "2026-03-18T15:11:10.000Z",
        updatedAt: "2026-03-18T15:11:10.000Z",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Invoker \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| unknown \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| unknown \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-current",
        threadId: "thr_current",
        summary: "Current session review",
        createdAt: "2026-03-18T15:10:00.000Z",
        updatedAt: "2026-03-18T15:11:00.000Z",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Old session review",
        createdAt: "2026-03-18T15:20:00.000Z",
        updatedAt: "2026-03-18T15:21:00.000Z",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        pid: sleeper.pid,
        pidStartTime: readPidStartTime(sleeper.pid),
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            pidStartTime: readPidStartTime(sleeper.pid),
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const cancelled = listJobs(workspace).find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  assert.equal(listJobs(workspace)[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  assert.equal(listJobs(workspace)[0].status, "cancelled");
});

test("cancel --all-stale cancels multiple stale active jobs and leaves fresh active jobs alone", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-stale-a",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-stale-b",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-fresh",
    startedAt: new Date().toISOString(),
    progressUpdatedAt: new Date().toISOString()
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cancelled 2 stale jobs\./);
  assert.match(result.stdout, /task-stale-a -> cancelled/);
  assert.match(result.stdout, /task-stale-b -> cancelled/);
  assert.doesNotMatch(result.stdout, /task-fresh -> cancelled/);

  const jobs = new Map(listJobs(workspace).map((job) => [job.id, job]));
  assert.equal(jobs.get("task-stale-a").status, "cancelled");
  assert.equal(jobs.get("task-stale-b").status, "cancelled");
  assert.equal(jobs.get("task-fresh").status, "running");
});

test("cancel --all-stale includes stale jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-other-session",
    sessionId: "sess-other",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "all-stale");
  assert.deepEqual(payload.cancelled.map((job) => job.jobId), ["task-other-session"]);
  assert.equal(listJobs(workspace).find((job) => job.id === "task-other-session").status, "cancelled");
});

test("cancel --all-stale with no stale jobs exits successfully with a friendly message", () => {
  const workspace = makeTempDir();
  seedRuntimeJob(workspace, {
    id: "task-fresh"
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "No stale jobs to cancel.\n");
  assert.equal(listJobs(workspace).find((job) => job.id === "task-fresh").status, "running");
});

test("cancel --all-stale rejects an explicit job id", () => {
  const workspace = makeTempDir();

  const result = run("node", [SCRIPT, "cancel", "task-live", "--all-stale"], {
    cwd: workspace
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass either a job id or --all-stale, not both\./);
});

test("cancel --all-stale --json reports counts and result arrays", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-json-a",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-json-b",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "all-stale");
  assert.deepEqual(payload.counts, { cancelled: 2, skipped: 0, errors: 0 });
  assert.deepEqual(payload.cancelled.map((job) => job.jobId).sort(), ["task-json-a", "task-json-b"]);
  assert.deepEqual(payload.skipped, []);
  assert.deepEqual(payload.errors, []);
});

test("cancel --all-stale is idempotent after stale jobs are cancelled", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-idempotent",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const first = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).counts.cancelled, 1);

  const second = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });
  assert.equal(second.status, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.deepEqual(payload.counts, { cancelled: 0, skipped: 0, errors: 0 });
  assert.deepEqual(payload.errors, []);
});

test("cancel --all-stale skips unverifiable stale jobs without force", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  seedRuntimeJob(workspace, {
    id: "task-unverifiable",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime: null
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 0, skipped: 1, errors: 0 });
  assert.equal(payload.cancelled.length, 0);
  assert.equal(payload.skipped[0].jobId, "task-unverifiable");
  assert.match(payload.skipped[0].reason, /PID identity unverifiable/);
  assert.match(payload.skipped[0].reason, /\/codex:cancel --all-stale --force/);
  assert.match(payload.skipped[0].reason, /\/codex:cancel --force task-unverifiable/);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const record = listJobs(workspace).find((job) => job.id === "task-unverifiable");
  assert.equal(record.status, "running");
  assert.equal(record.pid, sleeper.pid);
  assert.equal(record.pidStartTime, null);
});

test("cancel --all-stale signals platform-unverifiable stale jobs without force", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const signalMarker = path.join(workspace, "platform-unverifiable-sigterm");
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  seedRuntimeJob(workspace, {
    id: "task-platform-unverifiable",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime: null
  });

  const preloadPath = writePlatformOverridePreload(workspace, "darwin");
  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: envWithNodeImport({ ...process.env }, preloadPath)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 0 });
  assert.deepEqual(payload.cancelled.map((job) => job.jobId), ["task-platform-unverifiable"]);
  assert.deepEqual(payload.skipped, []);
  assert.deepEqual(payload.errors, []);
  await waitFor(() => fs.existsSync(signalMarker), { timeoutMs: 3000, intervalMs: 25 });
  assert.equal(fs.readFileSync(signalMarker, "utf8"), "SIGTERM\n");
  const record = listJobs(workspace).find((job) => job.id === "task-platform-unverifiable");
  assert.equal(record.status, "cancelled");
  assert.equal(record.pid, null);
});

test("cancel --all-stale --force signals and cancels unverifiable stale jobs", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const signalMarker = path.join(workspace, "sleeper-sigterm");
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  seedRuntimeJob(workspace, {
    id: "task-unverifiable-force",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime: null
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--force", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 0 });
  assert.deepEqual(payload.cancelled.map((job) => job.jobId), ["task-unverifiable-force"]);
  await waitFor(() => fs.existsSync(signalMarker), { timeoutMs: 3000, intervalMs: 25 });
  const record = listJobs(workspace).find((job) => job.id === "task-unverifiable-force");
  assert.equal(record.status, "cancelled");
  assert.equal(record.pid, null);
});

test("cancel --all-stale skips job that refreshes progress after reconcile but before tombstone, and sends no signal", async (t) => {
  const workspace = makeTempDir();
  const startedAt = new Date().toISOString();
  const staleProgressAt = new Date(Date.now() - 400_000).toISOString();
  const signalMarker = path.join(workspace, "refreshed-job-sigterm");
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-refreshed-race",
    startedAt,
    progressUpdatedAt: staleProgressAt,
    pid: sleeper.pid,
    pidStartTime
  });

  const preloadPath = writeCancelAllStaleMutationPreload(workspace);
  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: envWithNodeImport(
      {
        ...process.env,
        CODEX_TEST_MUTATE_JOB_FILE: resolveJobFile(workspace, "task-refreshed-race"),
        CODEX_TEST_MUTATE_JOB_MODE: "refresh-progress"
      },
      preloadPath
    )
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 0, skipped: 1, errors: 0 });
  assert.equal(payload.skipped[0].jobId, "task-refreshed-race");
  assert.match(payload.skipped[0].reason, /no longer stale/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(signalMarker), false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const record = listJobs(workspace).find((job) => job.id === "task-refreshed-race");
  assert.equal(record.status, "running");
  assert.equal(record.pid, sleeper.pid);
  assert.equal(record.staleness, null);
});

test("cancel --all-stale skips job that terminalizes between reconcile and tombstone, and sends no signal", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const signalMarker = path.join(workspace, "terminalized-job-sigterm");
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-terminalized-race",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime
  });

  const preloadPath = writeCancelAllStaleMutationPreload(workspace);
  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: envWithNodeImport(
      {
        ...process.env,
        CODEX_TEST_MUTATE_JOB_FILE: resolveJobFile(workspace, "task-terminalized-race"),
        CODEX_TEST_MUTATE_JOB_MODE: "terminalize"
      },
      preloadPath
    )
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 0, skipped: 1, errors: 0 });
  assert.equal(payload.skipped[0].jobId, "task-terminalized-race");
  assert.match(payload.skipped[0].reason, /already completed/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(signalMarker), false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.equal(listJobs(workspace).find((job) => job.id === "task-terminalized-race").status, "completed");
});

test("cancel --all-stale writes cancelled tombstone BEFORE sending SIGTERM", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const signalMarker = path.join(workspace, "tombstone-before-sigterm");
  const jobFile = resolveJobFile(workspace, "task-tombstone-before-signal");
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
const jobFile = ${JSON.stringify(jobFile)};
process.on("SIGTERM", () => {
  const record = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  fs.writeFileSync(marker, record.status + "\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-tombstone-before-signal",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 0 });
  await waitFor(() => fs.existsSync(signalMarker), { timeoutMs: 3000, intervalMs: 25 });
  assert.equal(fs.readFileSync(signalMarker, "utf8").trim(), "cancelled");
  assert.equal(listJobs(workspace).find((job) => job.id === "task-tombstone-before-signal").status, "cancelled");
});

test("cancel --all-stale tombstone survives a late worker completed update", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-late-completed-after-cancel",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.cancelled.map((job) => job.jobId), ["task-late-completed-after-cancel"]);
  const cancelledAt = listJobs(workspace).find((job) => job.id === "task-late-completed-after-cancel").cancelledAt;
  upsertJob(workspace, {
    id: "task-late-completed-after-cancel",
    status: "completed",
    phase: "done",
    completedAt: new Date().toISOString(),
    result: { summary: "worker finished after cancel" },
    rendered: "worker finished after cancel",
    pid: 123456,
    pidStartTime: "late-worker"
  });
  const record = listJobs(workspace).find((job) => job.id === "task-late-completed-after-cancel");
  assert.equal(record.status, "cancelled");
  assert.equal(record.phase, "cancelled");
  assert.equal(record.cancelledAt, cancelledAt);
  assert.equal(record.pid, null);
});

test("cancel --all-stale concurrent runs cancel a job once; the second run sees the terminal state and skips", async () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-concurrent-once",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const firstPreload = writeCancelAllStaleMutationPreload(workspace);
  const secondPreload = writeCancelAllStaleMutationPreload(workspace);
  const firstReady = path.join(workspace, "first-ready");
  const firstContinue = path.join(workspace, "first-continue");
  const secondReady = path.join(workspace, "second-ready");
  const secondContinue = path.join(workspace, "second-continue");

  function spawnCancel(preloadPath, readyFile, continueFile, extraEnv = {}) {
    const child = spawn(process.execPath, [SCRIPT, "cancel", "--all-stale", "--json"], {
      cwd: workspace,
      env: envWithNodeImport(
        {
          ...process.env,
          CODEX_TEST_MUTATE_JOB_FILE: resolveJobFile(workspace, "task-concurrent-once"),
          CODEX_TEST_MUTATE_JOB_MODE: "pause-on-stale-read",
          CODEX_TEST_MUTATE_READY_FILE: readyFile,
          CODEX_TEST_MUTATE_CONTINUE_FILE: continueFile,
          ...extraEnv
        },
        preloadPath
      )
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return {
      child,
      done: new Promise((resolve) => {
        child.on("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
      })
    };
  }

  const first = spawnCancel(firstPreload, firstReady, firstContinue);
  await waitFor(() => fs.existsSync(firstReady), { timeoutMs: 3000, intervalMs: 25 });
  const second = spawnCancel(secondPreload, secondReady, secondContinue, {
    CODEX_TEST_MUTATE_SKIP_STALE_READS: "2"
  });
  await waitFor(() => fs.existsSync(secondReady), { timeoutMs: 3000, intervalMs: 25 });
  fs.writeFileSync(firstContinue, "go\n", "utf8");
  const firstResult = await first.done;
  fs.writeFileSync(secondContinue, "go\n", "utf8");
  const secondResult = await second.done;

  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  const firstPayload = JSON.parse(firstResult.stdout);
  const secondPayload = JSON.parse(secondResult.stdout);
  assert.equal(firstPayload.counts.cancelled, 1);
  assert.deepEqual(secondPayload.counts, { cancelled: 0, skipped: 1, errors: 0 });
  assert.equal(secondPayload.skipped[0].jobId, "task-concurrent-once");
  assert.match(secondPayload.skipped[0].reason, /already cancelled/);
  assert.equal(listJobs(workspace).find((job) => job.id === "task-concurrent-once").status, "cancelled");
});

test("cancel --all-stale reports reconcile errors and exits non-zero", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "jobs"), "not a directory\n", "utf8");

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "all-stale");
  assert.deepEqual(payload.counts, { cancelled: 0, skipped: 0, errors: 1 });
  assert.equal(payload.errors[0].jobId, null);
  assert.match(payload.errors[0].message, /ENOTDIR|not a directory/i);
});

test("cancel --all-stale phase-two signal failure is reported in errors and batch continues to next job and exits non-zero", async (t) => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-after-signal-failure",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-signal-failure",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime
  });

  const preloadPath = writeCancelAllStaleSignalFailurePreload(workspace, sleeper.pid);
  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: envWithNodeImport({ ...process.env }, preloadPath)
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 2, skipped: 0, errors: 1 });
  assert.deepEqual(payload.cancelled.map((job) => job.jobId).sort(), [
    "task-after-signal-failure",
    "task-signal-failure"
  ]);
  assert.equal(payload.errors[0].jobId, "task-signal-failure");
  assert.match(payload.errors[0].message, /forced SIGTERM failure/);
  const jobs = new Map(listJobs(workspace).map((job) => [job.id, job]));
  assert.equal(jobs.get("task-signal-failure").status, "cancelled");
  assert.equal(jobs.get("task-after-signal-failure").status, "cancelled");
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test("cancel --all-stale exits within bounded wall-clock time when app-server ignores SIGTERM", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const appServerPidFile = path.join(workspace, "app-server.pid");
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  installNeverRespondingCodex(binDir);

  t.after(() => {
    if (!fs.existsSync(appServerPidFile)) {
      return;
    }
    const pid = Number(fs.readFileSync(appServerPidFile, "utf8"));
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  seedRuntimeJob(workspace, {
    id: "task-app-server-ignores-sigterm",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    threadId: "thread-ignores-sigterm",
    turnId: "turn-ignores-sigterm"
  });

  const result = await runCompanionWithDeadline(["cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS: "50",
      CODEX_TEST_APP_SERVER_PID_FILE: appServerPidFile
    },
    timeoutMs: 5000
  });

  assert.equal(result.timedOut, false, result.stderr);
  assert.ok(result.durationMs < 3000, `expected bounded exit, got ${result.durationMs}ms`);
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 1 });
  assert.equal(payload.errors[0].jobId, "task-app-server-ignores-sigterm");
  assert.match(payload.errors[0].message, /interrupt timed out after 50ms; sent SIGTERM \(no PID recorded\)/);
  assert.doesNotMatch(payload.errors[0].message, /PID null/);
  const appServerPid = Number(fs.readFileSync(appServerPidFile, "utf8"));
  await waitForPidGone(appServerPid, { timeoutMs: 1500, intervalMs: 25 });
});

test("cancel --all-stale completes promptly when interrupt succeeds but app-server ignores EOF and SIGTERM on close", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const appServerPidFile = path.join(workspace, "app-server-success-close-hang.pid");
  const signalMarker = path.join(workspace, "success-close-sigterm");
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  installInterruptThenCloseHangingCodex(binDir);

  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
    if (!fs.existsSync(appServerPidFile)) {
      return;
    }
    const pid = Number(fs.readFileSync(appServerPidFile, "utf8"));
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-successful-interrupt-close-hangs",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime,
    threadId: "thread-success-close-hang",
    turnId: "turn-success-close-hang"
  });

  const result = await runCompanionWithDeadline(["cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      CODEX_TEST_APP_SERVER_PID_FILE: appServerPidFile
    },
    timeoutMs: 5000
  });

  assert.equal(result.timedOut, false, result.stderr);
  assert.ok(result.durationMs < 1000, `expected bounded close cleanup, got ${result.durationMs}ms`);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 0 });
  assert.equal(payload.cancelled[0].jobId, "task-successful-interrupt-close-hangs");
  assert.equal(payload.cancelled[0].turnInterrupted, true);
  await waitFor(() => fs.existsSync(signalMarker), { timeoutMs: 3000, intervalMs: 25 });
  const appServerPid = Number(fs.readFileSync(appServerPidFile, "utf8"));
  await waitForPidGone(appServerPid, { timeoutMs: 1500, intervalMs: 25 });
});

test("cancel --all-stale exits promptly when codex preflight ignores SIGTERM", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const preflightMarker = path.join(workspace, "preflight-invoked");
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  installPreflightHangingCodex(binDir);
  seedRuntimeJob(workspace, {
    id: "task-preflight-ignores-sigterm",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    threadId: "thread-preflight",
    turnId: "turn-preflight"
  });

  const result = await runCompanionWithDeadline(["cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS: "500",
      CODEX_TEST_PREFLIGHT_MARKER: preflightMarker
    },
    timeoutMs: 5000
  });

  assert.equal(result.timedOut, false, result.stderr);
  assert.ok(result.durationMs < 3000, `expected bounded exit, got ${result.durationMs}ms`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(preflightMarker), false, "batch interrupt should not run codex preflight");
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 1 });
  assert.equal(payload.errors[0].jobId, "task-preflight-ignores-sigterm");
  assert.match(payload.errors[0].message, /codex app-server (exited unexpectedly|connection closed)/);
});

test("cancel --all-stale phase-two interrupt timeout is reported in errors, PID signal still attempted, batch continues, exit non-zero", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  const signalMarker = path.join(workspace, "timeout-sigterm");
  installSlowInterruptCodex(binDir);
  const sleeper = spawn(
    process.execPath,
    [
      "-e",
      `
const fs = require("node:fs");
const marker = ${JSON.stringify(signalMarker)};
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "SIGTERM\\n", "utf8");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-after-interrupt-timeout",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-interrupt-timeout",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime,
    threadId: "thread-timeout",
    turnId: "turn-timeout"
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS: "25",
      CODEX_TEST_INTERRUPT_DELAY_MS: "150"
    }
  });

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 2, skipped: 0, errors: 1 });
  assert.equal(payload.errors[0].jobId, "task-interrupt-timeout");
  assert.match(payload.errors[0].message, new RegExp(`interrupt timed out after 25ms; sent SIGTERM to PID ${sleeper.pid}`));
  await waitFor(() => fs.existsSync(signalMarker), { timeoutMs: 3000, intervalMs: 25 });
  const jobs = new Map(listJobs(workspace).map((job) => [job.id, job]));
  assert.equal(jobs.get("task-interrupt-timeout").status, "cancelled");
  assert.equal(jobs.get("task-after-interrupt-timeout").status, "cancelled");
});

test("cancel --all-stale phase-two interrupt timeout honors CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS override", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  installSlowInterruptCodex(binDir);
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const pidStartTime = await waitFor(() => readPidStartTime(sleeper.pid), {
    timeoutMs: 3000,
    intervalMs: 25
  });
  seedRuntimeJob(workspace, {
    id: "task-interrupt-timeout-override",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt,
    pid: sleeper.pid,
    pidStartTime,
    threadId: "thread-timeout-override",
    turnId: "turn-timeout-override"
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS: "75",
      CODEX_TEST_INTERRUPT_DELAY_MS: "200"
    }
  });

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 1 });
  assert.equal(payload.errors[0].jobId, "task-interrupt-timeout-override");
  assert.match(payload.errors[0].message, new RegExp(`interrupt timed out after 75ms; sent SIGTERM to PID ${sleeper.pid}`));
});

test("cancel --all-stale exits non-zero on per-job failure while completing the rest", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-error",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });
  seedRuntimeJob(workspace, {
    id: "task-ok",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const preloadPath = writeCancelAllStaleMutationPreload(workspace);
  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace,
    env: envWithNodeImport(
      {
        ...process.env,
        CODEX_TEST_MUTATE_JOB_FILE: resolveJobFile(workspace, "task-error"),
        CODEX_TEST_MUTATE_JOB_MODE: "replace-with-directory"
      },
      preloadPath
    )
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 1 });
  assert.deepEqual(payload.cancelled.map((job) => job.jobId), ["task-ok"]);
  assert.equal(payload.errors[0].jobId, "task-error");
  assert.match(payload.errors[0].message, /EISDIR|directory/i);
  assert.equal(listJobs(workspace).find((job) => job.id === "task-ok").status, "cancelled");
});

test("cancel --all-stale exits zero for a clean batch", () => {
  const workspace = makeTempDir();
  const staleStartedAt = new Date(Date.now() - 4_000_000).toISOString();
  seedRuntimeJob(workspace, {
    id: "task-clean-exit",
    startedAt: staleStartedAt,
    progressUpdatedAt: staleStartedAt
  });

  const result = run("node", [SCRIPT, "cancel", "--all-stale", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.counts, { cancelled: 1, skipped: 0, errors: 0 });
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const runningJob = await waitFor(() => {
    const job = listJobs(repo).find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end removes terminal jobs and cancels active jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(
    completedJobFile,
    JSON.stringify(
      {
        id: "review-completed",
        status: "completed",
        title: "Codex Review",
        sessionId: "sess-current",
        logFile: completedLog,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:31:00.000Z"
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    otherJobFile,
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        sessionId: "sess-other",
        logFile: otherSessionLog,
        createdAt: "2026-03-18T15:34:00.000Z",
        updatedAt: "2026-03-18T15:35:00.000Z"
      },
      null,
      2
    ),
    "utf8"
  );

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(
    runningJobFile,
    JSON.stringify(
      {
        id: "review-running",
        status: "running",
        title: "Codex Review",
        sessionId: "sess-current",
        pid: sleeper.pid,
        pidStartTime: readPidStartTime(sleeper.pid),
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      },
      null,
      2
    ),
    "utf8"
  );

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            pidStartTime: readPidStartTime(sleeper.pid),
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [
      path.basename(otherJobFile),
      path.basename(otherSessionLog),
      path.basename(runningJobFile),
      path.basename(runningLog)
    ].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const jobs = listJobs(repo);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  assert.deepEqual([...jobsById.keys()].sort(), ["review-other", "review-running"]);
  const runningJob = jobsById.get("review-running");
  assert.equal(runningJob.status, "cancelled");
  assert.equal(runningJob.phase, "cancelled");
  assert.equal(runningJob.pid, null);
  assert.equal(runningJob.errorMessage, "Cancelled by session end.");
  assert.equal(runningJob.logFile, runningLog);
  const otherJob = jobsById.get("review-other");
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});
