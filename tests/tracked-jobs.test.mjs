import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  __resetAppendFileSyncForTest,
  __resetCircuitBreakerForTest,
  __setAppendFileSyncForTest,
  appendLogBlock,
  appendLogLine,
  createJobLogFile,
  safeAppendFileSync
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { resolveJobLogFile } from "../plugins/codex/scripts/lib/state.mjs";

const realAppendFileSync = fs.appendFileSync.bind(fs);

let restoreStderrWrite = null;

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
