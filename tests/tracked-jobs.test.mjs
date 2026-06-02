import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  PROGRESS_UPDATE_THROTTLE_MS,
  __resetAppendFileSyncForTest,
  __resetCircuitBreakerForTest,
  __setAppendFileSyncForTest,
  appendLogBlock,
  appendLogLine,
  createJobLogFile,
  runTrackedJob,
  safeAppendFileSync
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile } from "../plugins/codex/scripts/lib/state.mjs";

const realAppendFileSync = fs.appendFileSync.bind(fs);
const trackedJobsSourceFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/codex/scripts/lib/tracked-jobs.mjs"
);

let restoreStderrWrite = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeError(code) {
  const error = new Error(`${code} fixture`);
  error.code = code;
  return error;
}

function captureStderrWrite() {
  const originalWrite = process.stderr.write;
  const writes = [];
  process.stderr.write = function (chunk, ...args) {
    writes.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function");
    callback?.();
    return true;
  };
  restoreStderrWrite = () => {
    process.stderr.write = originalWrite;
    restoreStderrWrite = null;
  };
  return writes;
}

async function importTrackedJobsWithStateStub() {
  const tempDir = makeTempDir();
  const token = `trackedJobsStateStub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const stub = {
    pidStartTime: "stub-pid-start",
    progressTimeoutMs: 60_000,
    readPidStartTimeCalls: 0,
    resolveProgressTimeoutCalls: 0,
    revalidateCalls: 0,
    upsertCalls: [],
    writes: []
  };
  globalThis[token] = stub;

  fs.writeFileSync(path.join(tempDir, "tracked-jobs.mjs"), fs.readFileSync(trackedJobsSourceFile, "utf8"), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "state.mjs"),
    `
const stub = globalThis[${JSON.stringify(token)}];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function missingFileError() {
  const error = new Error("ENOENT");
  error.code = "ENOENT";
  return error;
}

export function readJobFile(file) {
  if (typeof stub.readJobFile === "function") {
    return clone(stub.readJobFile(file));
  }
  throw missingFileError();
}

export function readPidStartTime() {
  stub.readPidStartTimeCalls += 1;
  return stub.pidStartTime;
}

export function resolveJobFile(cwd, jobId) {
  return String(cwd).replace(/\\/$/, "") + "/" + jobId + ".json";
}

export function resolveJobLogFile(cwd, jobId) {
  return String(cwd).replace(/\\/$/, "") + "/" + jobId + ".log";
}

export function resolveProgressTimeoutMs() {
  stub.resolveProgressTimeoutCalls += 1;
  return stub.progressTimeoutMs;
}

export function upsertJob(cwd, patch) {
  const clonedPatch = clone(patch);
  stub.upsertCalls.push({ cwd, patch: clonedPatch });
  return clonedPatch;
}

export function withJobLock(_cwd, _jobId, fn) {
  return fn(() => {
    stub.revalidateCalls += 1;
  });
}

export function writeJobFileUnlocked(cwd, jobId, payload) {
  const clonedPayload = clone(payload);
  stub.writes.push({ cwd, jobId, payload: clonedPayload });
  return resolveJobFile(cwd, jobId);
}
`,
    "utf8"
  );

  const module = await import(`${pathToFileURL(path.join(tempDir, "tracked-jobs.mjs")).href}?${token}`);
  return {
    module,
    stub,
    cleanup() {
      delete globalThis[token];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test.beforeEach(() => {
  __resetCircuitBreakerForTest();
  __resetAppendFileSyncForTest();
});

test.afterEach(() => {
  __resetCircuitBreakerForTest();
  __resetAppendFileSyncForTest();
  restoreStderrWrite?.();
});

test("safeAppendFileSync recovers from a transient append failure", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "task.log");
  fs.writeFileSync(logFile, "", "utf8");
  let calls = 0;
  __setAppendFileSyncForTest((...args) => {
    calls += 1;
    if (calls === 1) {
      throw makeError("EACCES");
    }
    return realAppendFileSync(...args);
  });

  const result = safeAppendFileSync(logFile, "hello\n");

  assert.deepEqual(
    { ok: result.ok, attempts: result.attempts, error: result.error, circuitOpen: result.circuitOpen },
    { ok: true, attempts: 2, error: null, circuitOpen: false }
  );
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(logFile, "utf8"), "hello\n");
});

test("appendLogLine recovers from a transient append failure without changing its return value", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "task.log");
  fs.writeFileSync(logFile, "", "utf8");
  let calls = 0;
  __setAppendFileSyncForTest((...args) => {
    calls += 1;
    if (calls === 1) {
      throw makeError("EACCES");
    }
    return realAppendFileSync(...args);
  });

  const returned = appendLogLine(logFile, "transient recovery");

  assert.equal(returned, undefined);
  assert.equal(calls, 2);
  assert.match(fs.readFileSync(logFile, "utf8"), /\] transient recovery\n$/);
});

test("safeAppendFileSync opens a circuit after persistent transient failures", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "task.log");
  fs.writeFileSync(logFile, "seed\n", "utf8");
  const stderrWrites = captureStderrWrite();
  let calls = 0;
  __setAppendFileSyncForTest(() => {
    calls += 1;
    throw makeError("EACCES");
  });

  const first = safeAppendFileSync(logFile, "lost\n");
  assert.equal(first.ok, false);
  assert.equal(first.attempts, 3);
  assert.equal(first.error?.code, "EACCES");
  assert.equal(first.circuitOpen, false);
  assert.equal(calls, 3);
  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0], /^\[codex-companion\]/);
  assert.match(stderrWrites[0], /code=EACCES/);
  assert.match(stderrWrites[0], /attempts=3/);

  const startedAt = process.hrtime.bigint();
  const second = safeAppendFileSync(logFile, "skipped\n");
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  assert.deepEqual(second, { ok: false, attempts: 0, error: null, circuitOpen: true });
  assert.equal(calls, 3);
  assert.equal(stderrWrites.length, 1);
  assert.ok(elapsedMs < 25, `expected open-circuit call under 25ms, got ${elapsedMs}ms`);
});

test("safeAppendFileSync opens a circuit after one non-transient failure", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "task.log");
  fs.writeFileSync(logFile, "", "utf8");
  const stderrWrites = captureStderrWrite();
  let calls = 0;
  __setAppendFileSyncForTest(() => {
    calls += 1;
    throw makeError("ENOENT");
  });

  const first = safeAppendFileSync(logFile, "lost\n");
  assert.equal(first.ok, false);
  assert.equal(first.attempts, 1);
  assert.equal(first.error?.code, "ENOENT");
  assert.equal(first.circuitOpen, false);
  assert.equal(calls, 1);
  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0], /code=ENOENT/);
  assert.match(stderrWrites[0], /attempts=1/);

  const second = safeAppendFileSync(logFile, "skipped\n");
  assert.deepEqual(second, { ok: false, attempts: 0, error: null, circuitOpen: true });
  assert.equal(calls, 1);
  assert.equal(stderrWrites.length, 1);
});

test("appendLogLine and appendLogBlock never throw on persistent append failure", () => {
  const tempDir = makeTempDir();
  const lineLogFile = path.join(tempDir, "line.log");
  const blockLogFile = path.join(tempDir, "block.log");
  fs.writeFileSync(lineLogFile, "", "utf8");
  fs.writeFileSync(blockLogFile, "", "utf8");
  captureStderrWrite();
  __setAppendFileSyncForTest(() => {
    throw makeError("EACCES");
  });

  assert.doesNotThrow(() => appendLogLine(lineLogFile, "line write fails"));
  assert.doesNotThrow(() => appendLogBlock(blockLogFile, "Block title", "block write fails"));
});

test("stderr warning is emitted at most once per file across many appendLogLine calls", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "task.log");
  fs.writeFileSync(logFile, "", "utf8");
  const stderrWrites = captureStderrWrite();
  let calls = 0;
  __setAppendFileSyncForTest(() => {
    calls += 1;
    throw makeError("EACCES");
  });

  for (let index = 0; index < 8; index += 1) {
    appendLogLine(logFile, `line ${index}`);
  }

  assert.equal(calls, 3);
  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0], /^\[codex-companion\]/);
});

test("stat failures in the stderr diagnostic are field-safe", () => {
  const tempDir = makeTempDir();
  const logFile = path.join(tempDir, "missing-parent", "task.log");
  const stderrWrites = captureStderrWrite();
  __setAppendFileSyncForTest(() => {
    throw makeError("EACCES");
  });

  assert.doesNotThrow(() => {
    const result = safeAppendFileSync(logFile, "lost\n");
    assert.equal(result.ok, false);
  });

  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0], /unavailable:ENOENT/);
});

test("createJobLogFile still throws on initial-write failure", () => {
  const workspace = makeTempDir();
  const jobId = "initial-write-failure";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.mkdirSync(logFile);

  assert.throws(() => createJobLogFile(workspace, jobId, "Initial write"), {
    code: "EISDIR"
  });
});

test("runTrackedJob writes progress timeout and seeds progress timestamp on the running record", async () => {
  const workspace = makeTempDir();
  const jobId = "tracked-progress-baseline";
  const logFile = resolveJobLogFile(workspace, jobId);
  const createdAt = new Date().toISOString();
  const previousProgressTimeout = process.env.CODEX_PLUGIN_PROGRESS_TIMEOUT_MS;
  process.env.CODEX_PLUGIN_PROGRESS_TIMEOUT_MS = "60000";
  fs.writeFileSync(logFile, "", "utf8");

  let resolveRunnerStarted;
  let releaseRunner;
  const runnerStarted = new Promise((resolve) => {
    resolveRunnerStarted = resolve;
  });
  const runnerCanFinish = new Promise((resolve) => {
    releaseRunner = resolve;
  });

  const runPromise = runTrackedJob(
    {
      id: jobId,
      workspaceRoot: workspace,
      status: "queued",
      phase: "queued",
      createdAt,
      updatedAt: createdAt,
      logFile
    },
    async () => {
      resolveRunnerStarted();
      await runnerCanFinish;
      return { exitStatus: 0, threadId: null, turnId: null, summary: "ok", payload: { ok: true }, rendered: "done" };
    },
    { logFile }
  );

  try {
    await Promise.race([
      runnerStarted,
      sleep(5000).then(() => {
        throw new Error("Timed out waiting for runner to start.");
      })
    ]);

    const running = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(running.status, "running");
    assert.equal(running.phase, "starting");
    assert.equal(running.progressTimeoutMs, 60_000);
    assert.equal(running.progressUpdatedAt, running.startedAt);
  } finally {
    releaseRunner();
    if (previousProgressTimeout === undefined) {
      delete process.env.CODEX_PLUGIN_PROGRESS_TIMEOUT_MS;
    } else {
      process.env.CODEX_PLUGIN_PROGRESS_TIMEOUT_MS = previousProgressTimeout;
    }
  }

  const execution = await runPromise;
  assert.equal(execution.exitStatus, 0);
});

test("createJobProgressUpdater refreshes progressUpdatedAt on same-phase events after the throttle window", async () => {
  const { module, stub, cleanup } = await importTrackedJobsWithStateStub();
  const originalDateNow = Date.now;
  let nowMs = 1_000;
  Date.now = () => nowMs;

  try {
    const updater = module.createJobProgressUpdater("/workspace", "progress-same-phase");
    updater({ phase: "running", threadId: "thread-1", turnId: "turn-1" });
    assert.equal(stub.upsertCalls.length, 1);
    assert.equal(typeof stub.upsertCalls[0].patch.progressUpdatedAt, "string");

    nowMs += PROGRESS_UPDATE_THROTTLE_MS;
    updater({ phase: "running", threadId: "thread-1", turnId: "turn-1" });

    assert.equal(stub.upsertCalls.length, 2);
    const samePhasePatch = stub.upsertCalls[1].patch;
    assert.deepEqual(Object.keys(samePhasePatch).sort(), ["id", "progressUpdatedAt"].sort());
    assert.equal(typeof samePhasePatch.progressUpdatedAt, "string");
  } finally {
    Date.now = originalDateNow;
    cleanup();
  }
});

test("createJobProgressUpdater throttles repeated same-phase progress writes", async () => {
  const { module, stub, cleanup } = await importTrackedJobsWithStateStub();
  const originalDateNow = Date.now;
  Date.now = () => 2_000;

  try {
    const updater = module.createJobProgressUpdater("/workspace", "progress-throttled");
    for (let index = 0; index < 10; index += 1) {
      updater({ phase: "busy", threadId: "thread-1", turnId: "turn-1" });
    }

    assert.equal(stub.upsertCalls.length, 1);
    assert.equal(stub.upsertCalls[0].patch.id, "progress-throttled");
    assert.equal(stub.upsertCalls[0].patch.phase, "busy");
    assert.equal(typeof stub.upsertCalls[0].patch.progressUpdatedAt, "string");
  } finally {
    Date.now = originalDateNow;
    cleanup();
  }
});

test("runTrackedJob terminal upsert patches clear active-only progress fields", async () => {
  const { module, stub, cleanup } = await importTrackedJobsWithStateStub();

  try {
    await module.runTrackedJob(
      { id: "terminal-completed", workspaceRoot: "/workspace", status: "queued", phase: "queued" },
      async () => ({ exitStatus: 0, threadId: null, turnId: null, summary: "ok", payload: { ok: true }, rendered: "done" })
    );

    await assert.rejects(
      module.runTrackedJob(
        { id: "terminal-failed", workspaceRoot: "/workspace", status: "queued", phase: "queued" },
        async () => {
          throw new Error("runner failed");
        }
      ),
      /runner failed/
    );

    const completedPatch = stub.upsertCalls.find((call) => call.patch.id === "terminal-completed")?.patch;
    assert.equal(completedPatch.status, "completed");
    assert.equal(completedPatch.staleness, null);
    assert.equal(completedPatch.progressUpdatedAt, null);

    const failedPatch = stub.upsertCalls.find((call) => call.patch.id === "terminal-failed")?.patch;
    assert.equal(failedPatch.status, "failed");
    assert.equal(failedPatch.staleness, null);
    assert.equal(failedPatch.progressUpdatedAt, null);
    assert.equal(stub.resolveProgressTimeoutCalls, 2);
  } finally {
    cleanup();
  }
});
