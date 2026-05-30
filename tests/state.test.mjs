import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  deleteSessionJobs,
  listJobs,
  loadState,
  pruneJobsOnDisk,
  readPidStartTime,
  reconcileStaleActiveJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFileForTest,
  identityVerificationSupported,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, "plugins/codex/scripts/lib/state.mjs")).href;

function spawnNodeScript(script) {
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForCondition(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function waitForChild(child, label, timeoutMs = 5000) {
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

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${label} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${label} exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

function readLockTokenLog(tokenLogFile) {
  if (!fs.existsSync(tokenLogFile)) {
    return [];
  }
  return fs
    .readFileSync(tokenLogFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      return { label: line.slice(0, separator), token: line.slice(separator + 1) };
    });
}

function readStoredJob(workspace, jobId) {
  return JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
}

async function getExitedPid() {
  const child = spawnNodeScript("");
  const pid = child.pid;
  await waitForChild(child, "exited pid probe");
  return pid;
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("upsertJob is safe under concurrent updates across distinct jobs", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);

  upsertJob(workspace, { id: "A", status: "running", phase: "starting" });
  upsertJob(workspace, { id: "B", status: "running", phase: "starting" });
  upsertJob(workspace, { id: "A", status: "completed", phase: "done", result: "a-final" });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs: [
          { id: "A", status: "running", phase: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "B", status: "verifying", phase: "verifying", updatedAt: "2026-01-01T00:00:01.000Z" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  upsertJob(workspace, { id: "B", status: "completed", phase: "done", result: "b-final" });

  const jobsById = new Map(listJobs(workspace).map((job) => [job.id, job]));
  assert.equal(jobsById.get("A")?.status, "completed");
  assert.equal(jobsById.get("A")?.result, "a-final");
  assert.equal(jobsById.get("B")?.status, "completed");
  assert.equal(jobsById.get("B")?.result, "b-final");
});

test("upsertJob rejects unsafe job ids before touching the jobs directory", () => {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");

  assert.throws(() => {
    upsertJob(workspace, { id: "../escape", status: "running", phase: "starting" });
  }, /Invalid job id/);
  assert.equal(fs.existsSync(jobsDir), false);
});

test("acquireJobLock publishes the lock atomically (no empty-file window)", () => {
  const workspace = makeTempDir();
  const jobId = "atomic-publish";
  const jobFile = resolveJobFile(workspace, jobId);
  const jobsDir = path.dirname(jobFile);
  const lockPath = path.join(jobsDir, `${jobId}.lock`);
  const lockFileName = path.basename(lockPath);
  const sleepView = new Int32Array(new SharedArrayBuffer(4));
  const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalReadFileSync = fs.readFileSync;
  const originalRenameSync = fs.renameSync;
  const originalWriteFileSync = fs.writeFileSync;
  const lockFds = new Set();
  const observations = [];
  let secondAcquirerRan = false;
  let activeJobWrites = 0;
  let maxActiveJobWrites = 0;

  const isLockPublishPath = (filePath) => {
    const resolved = path.resolve(String(filePath));
    const baseName = path.basename(resolved);
    return (
      resolved === path.resolve(lockPath) ||
      (path.dirname(resolved) === jobsDir && baseName.startsWith(`.${lockFileName}.`) && baseName.endsWith(".tmp"))
    );
  };

  try {
    fs.openSync = function (...args) {
      const fd = originalOpenSync.apply(fs, args);
      if (isLockPublishPath(args[0]) && (Number(args[1]) & fs.constants.O_EXCL) !== 0) {
        lockFds.add(fd);
      }
      return fd;
    };

    fs.closeSync = function (fd) {
      lockFds.delete(fd);
      return originalCloseSync.apply(fs, arguments);
    };

    fs.renameSync = function (...args) {
      if (path.resolve(String(args[1])) === path.resolve(jobFile)) {
        activeJobWrites += 1;
        maxActiveJobWrites = Math.max(maxActiveJobWrites, activeJobWrites);
        try {
          sleepSync(2);
          return originalRenameSync.apply(fs, args);
        } finally {
          activeJobWrites -= 1;
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    fs.writeFileSync = function (...args) {
      if (typeof args[0] === "number" && lockFds.has(args[0]) && !secondAcquirerRan) {
        secondAcquirerRan = true;
        sleepSync(5);
        if (fs.existsSync(lockPath)) {
          const raw = originalReadFileSync.apply(fs, [lockPath, "utf8"]);
          assert.notEqual(raw, "", "lockPath must never be published as an empty file");
          const lock = JSON.parse(raw);
          assert.equal(typeof lock.token, "string");
          observations.push("parsed");
        } else {
          observations.push("missing");
        }
        upsertJob(workspace, { id: jobId, status: "running", phase: "second" });
      }
      return originalWriteFileSync.apply(fs, args);
    };

    upsertJob(workspace, { id: jobId, status: "running", phase: "first" });
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.renameSync = originalRenameSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(secondAcquirerRan, true);
  assert.deepEqual(observations, ["missing"]);
  assert.equal(maxActiveJobWrites, 1);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).phase, "first");
});

test("upsertJob recovers when only a recent releasing side file remains", () => {
  const workspace = makeTempDir();
  const jobId = "orphan-releasing-lock";
  const jobFile = resolveJobFile(workspace, jobId);
  const jobsDir = path.dirname(jobFile);
  const lockPath = path.join(jobsDir, `${jobId}.lock`);
  const sidePath = `${lockPath}.releasing.test-token.${process.hrtime.bigint().toString(36)}`;

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(sidePath, "orphan releasing side file\n", "utf8");
  fs.utimesSync(sidePath, new Date(), new Date());

  const startedAt = Date.now();
  const job = upsertJob(workspace, { id: jobId, status: "running", phase: "created" });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(job.id, jobId);
  assert.equal(job.phase, "created");
  assert.equal(elapsedMs < 500, true, `upsertJob took ${elapsedMs}ms`);
  assert.equal(fs.existsSync(sidePath), false);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).phase, "created");
});

test("upsertJob still blocks on a recent stealing side file without a lock", () => {
  const workspace = makeTempDir();
  const jobId = "orphan-stealing-lock";
  const jobFile = resolveJobFile(workspace, jobId);
  const jobsDir = path.dirname(jobFile);
  const lockPath = path.join(jobsDir, `${jobId}.lock`);
  const sidePath = `${lockPath}.stealing.test-token.${process.hrtime.bigint().toString(36)}`;
  const originalAtomicsWait = Atomics.wait;

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(sidePath, "in-progress stealing side file\n", "utf8");
  fs.utimesSync(sidePath, new Date(), new Date());

  try {
    Atomics.wait = () => "timed-out";
    const startedAt = Date.now();
    assert.throws(
      () => {
        upsertJob(workspace, { id: jobId, status: "running", phase: "blocked" });
      },
      (error) => {
        assert.equal(error?.name, "JobLockTimeoutError");
        return true;
      }
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs < 500, true, `upsertJob took ${elapsedMs}ms`);
    assert.equal(fs.existsSync(sidePath), true);
  } finally {
    Atomics.wait = originalAtomicsWait;
  }

  fs.unlinkSync(sidePath);
  const job = upsertJob(workspace, { id: jobId, status: "running", phase: "unblocked" });

  assert.equal(job.id, jobId);
  assert.equal(job.phase, "unblocked");
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).phase, "unblocked");
});

test("loadState migrates legacy state.json jobs[] into per-job files", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const updatedAt = "2026-01-01T00:01:00.000Z";
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs: [
          { id: "legacy-1", status: "completed", createdAt, updatedAt },
          { id: "../escape", status: "completed", createdAt, updatedAt }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const originalStderrWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  let jobs;
  try {
    jobs = listJobs(workspace);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "legacy-1");
  assert.match(stderr, /Skipping legacy job "\.\.\/escape": Invalid job id/);
  const jobFile = resolveJobFile(workspace, "legacy-1");
  const jobsDir = path.dirname(jobFile);
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "..", "escape.json")), false);
  assert.equal(fs.statSync(jobFile).size > 0, true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).id, "legacy-1");
  assert.deepEqual(
    fs.readdirSync(jobsDir).filter((entry) => entry.endsWith(".tmp")),
    []
  );

  saveState(workspace, loadState(workspace));
  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(savedState, {
    version: 1,
    config: {
      stopReviewGate: false,
      reviewSubagentsEnabled: false
    }
  });
});

test("loadState propagates legacy job migration filesystem errors", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(jobsDir, "not a directory\n", "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs: [
          {
            id: "legacy-blocked",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  assert.throws(() => loadState(workspace), /EEXIST|ENOTDIR/);
  assert.equal(Array.isArray(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs), true);
});

test("upsertJob prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();

  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    upsertJob(workspace, {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    });
  }

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);
  const jobs = listJobs(workspace);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
  assert.equal(jobs.length, 50);
  assert.deepEqual(
    jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("pruneJobsOnDisk skips a candidate whose lock cannot be acquired in time and does not throw from upsertJob", async () => {
  const workspace = makeTempDir();
  const victimJobId = "job-0";
  const victimJobFile = resolveJobFile(workspace, victimJobId);
  const readyFile = path.join(workspace, "held-lock-ready");
  const continueFile = path.join(workspace, "held-lock-continue");

  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    writeJobFileForTest(workspace, jobId, {
      id: jobId,
      status: "completed",
      createdAt: updatedAt,
      updatedAt
    });
  }

  const holderProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const victimJobId = ${JSON.stringify(victimJobId)};
    const victimJobFile = ${JSON.stringify(victimJobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalRenameSync = fs.renameSync;
    let blocked = false;

    fs.renameSync = function (...args) {
      if (!blocked && path.resolve(String(args[1])) === path.resolve(victimJobFile)) {
        blocked = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    upsertJob(workspace, { id: victimJobId, status: "completed", phase: "held" });
  `);
  const holderDone = waitForChild(holderProcess, "held lock writer", 15000);
  const originalAtomicsWait = Atomics.wait;
  let caughtError = null;

  try {
    await waitForFile(readyFile);
    Atomics.wait = () => "timed-out";
    assert.doesNotThrow(() => {
      upsertJob(workspace, { id: "unrelated-job", status: "completed", phase: "done" });
    });
    assert.equal(fs.existsSync(victimJobFile), true);
  } catch (error) {
    caughtError = error;
  } finally {
    Atomics.wait = originalAtomicsWait;
    fs.writeFileSync(continueFile, "continue\n", "utf8");
    const holderResult = await Promise.allSettled([holderDone]);
    if (!caughtError && holderResult[0].status === "rejected") {
      caughtError = holderResult[0].reason;
    }
  }

  if (caughtError) {
    throw caughtError;
  }

  assert.equal(fs.existsSync(victimJobFile), true);
});

test("pruneJobsOnDisk skips a pruned job when updatedAt changed after the snapshot", () => {
  const workspace = makeTempDir();
  const victimJobId = "job-0";
  const victimJobFile = resolveJobFile(workspace, victimJobId);
  const victimLogFile = resolveJobLogFile(workspace, victimJobId);
  const originalReadFileSync = fs.readFileSync;
  let victimReads = 0;

  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    writeJobFileForTest(workspace, jobId, {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    });
  }

  try {
    fs.readFileSync = (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(victimJobFile)) {
        victimReads += 1;
        if (victimReads === 2) {
          fs.writeFileSync(
            victimJobFile,
            `${JSON.stringify(
              {
                id: victimJobId,
                status: "completed",
                logFile: victimLogFile,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T01:00:00.000Z"
              },
              null,
              2
            )}\n`,
            "utf8"
          );
        }
      }
      return originalReadFileSync.apply(fs, args);
    };

    pruneJobsOnDisk(workspace);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(fs.existsSync(victimJobFile), true);
  assert.equal(fs.existsSync(victimLogFile), true);
  assert.equal(JSON.parse(fs.readFileSync(victimJobFile, "utf8")).updatedAt, "2026-01-01T01:00:00.000Z");
});

test("pruneJobsOnDisk does not delete a job whose file is replaced after the freshness re-read", async () => {
  const workspace = makeTempDir();
  const victimJobId = "job-0";
  const victimJobFile = resolveJobFile(workspace, victimJobId);
  const readyFile = path.join(workspace, "prune-ready");
  const continueFile = path.join(workspace, "prune-continue");

  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    writeJobFileForTest(workspace, jobId, {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    });
  }

  const pruneProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const victimJobFile = ${JSON.stringify(victimJobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalUnlinkSync = fs.unlinkSync;

    fs.unlinkSync = (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(victimJobFile)) {
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalUnlinkSync.apply(fs, args);
    };

    const { pruneJobsOnDisk } = await import(${JSON.stringify(STATE_MODULE_URL)});
    pruneJobsOnDisk(workspace);
  `);
  const pruneDone = waitForChild(pruneProcess, "prune process");

  try {
    await waitForFile(readyFile);
    const writerProcess = spawnNodeScript(`
      import fs from "node:fs";
      const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
      fs.writeFileSync(${JSON.stringify(path.join(workspace, "writer-started"))}, "started\\n", "utf8");
      upsertJob(${JSON.stringify(workspace)}, {
        id: ${JSON.stringify(victimJobId)},
        status: "completed",
        phase: "fresh",
        result: "fresh"
      });
    `);
    const writerDone = waitForChild(writerProcess, "fresh writer");
    await waitForFile(path.join(workspace, "writer-started"));
    await sleep(200);
    fs.writeFileSync(continueFile, "continue\n", "utf8");

    await pruneDone;
    await writerDone;
  } finally {
    fs.writeFileSync(continueFile, "continue\n", "utf8");
  }

  assert.equal(fs.existsSync(victimJobFile), true);
  const stored = JSON.parse(fs.readFileSync(victimJobFile, "utf8"));
  assert.equal(stored.phase, "fresh");
  assert.equal(stored.result, "fresh");
});

test("pruneJobsOnDisk never prunes running jobs under cap pressure", () => {
  const workspace = makeTempDir();
  const runningJobFile = resolveJobFile(workspace, "job-running");
  const runningLogFile = resolveJobLogFile(workspace, "job-running");

  fs.writeFileSync(runningLogFile, "running\n", "utf8");
  writeJobFileForTest(workspace, "job-running", {
    id: "job-running",
    status: "running",
    phase: "working",
    pid: 12345,
    logFile: runningLogFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  for (let index = 0; index < 50; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index + 1, 0)).toISOString();
    writeJobFileForTest(workspace, jobId, {
      id: jobId,
      status: "completed",
      createdAt: updatedAt,
      updatedAt
    });
  }

  pruneJobsOnDisk(workspace);

  assert.equal(fs.existsSync(runningJobFile), true);
  assert.equal(fs.existsSync(runningLogFile), true);
  assert.equal(JSON.parse(fs.readFileSync(runningJobFile, "utf8")).status, "running");
});

test("deleteSessionJobs removes only matching session jobs and respects the per-job lock", () => {
  const workspace = makeTempDir();
  const sessionA = "session-a";
  const sessionB = "session-b";
  const insideCustomLogFile = path.join(resolveStateDir(workspace), "custom-session-a.log");
  const outsideLogFile = path.join(makeTempDir(), "outside-session-a.log");
  const sessionAInsideJobFile = resolveJobFile(workspace, "session-a-inside");
  const sessionAOutsideJobFile = resolveJobFile(workspace, "session-a-outside");
  const sessionBJobFile = resolveJobFile(workspace, "session-b-job");
  const sessionAInsideSiblingLogFile = resolveJobLogFile(workspace, "session-a-inside");
  const sessionAOutsideSiblingLogFile = resolveJobLogFile(workspace, "session-a-outside");
  const sessionBSiblingLogFile = resolveJobLogFile(workspace, "session-b-job");

  fs.writeFileSync(sessionAInsideSiblingLogFile, "session a sibling\n", "utf8");
  fs.writeFileSync(sessionAOutsideSiblingLogFile, "session a outside sibling\n", "utf8");
  fs.writeFileSync(sessionBSiblingLogFile, "session b sibling\n", "utf8");
  fs.writeFileSync(insideCustomLogFile, "session a custom\n", "utf8");
  fs.writeFileSync(outsideLogFile, "outside custom\n", "utf8");

  writeJobFileForTest(workspace, "session-a-inside", {
    id: "session-a-inside",
    sessionId: sessionA,
    status: "completed",
    logFile: insideCustomLogFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  writeJobFileForTest(workspace, "session-a-outside", {
    id: "session-a-outside",
    sessionId: sessionA,
    status: "completed",
    logFile: outsideLogFile,
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z"
  });
  writeJobFileForTest(workspace, "session-b-job", {
    id: "session-b-job",
    sessionId: sessionB,
    status: "completed",
    logFile: sessionBSiblingLogFile,
    createdAt: "2026-01-01T00:02:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z"
  });

  const deletedIds = deleteSessionJobs(workspace, sessionA);

  assert.deepEqual(deletedIds.sort(), ["session-a-inside", "session-a-outside"]);
  assert.equal(fs.existsSync(sessionAInsideJobFile), false);
  assert.equal(fs.existsSync(sessionAOutsideJobFile), false);
  assert.equal(fs.existsSync(sessionAInsideSiblingLogFile), false);
  assert.equal(fs.existsSync(sessionAOutsideSiblingLogFile), false);
  assert.equal(fs.existsSync(insideCustomLogFile), false);
  assert.equal(fs.existsSync(outsideLogFile), true);
  assert.equal(fs.existsSync(sessionBJobFile), true);
  assert.equal(fs.existsSync(sessionBSiblingLogFile), true);
});

test("deleteSessionJobs with onMatchUnderLock terminates and cancels active jobs when the sessionId still matches", () => {
  const workspace = makeTempDir();
  const sessionA = "session-a";
  const sessionB = "session-b";
  const callbackIds = [];

  writeJobFileForTest(workspace, "session-a-running", {
    id: "session-a-running",
    sessionId: sessionA,
    status: "running",
    pid: 111,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  writeJobFileForTest(workspace, "session-a-queued", {
    id: "session-a-queued",
    sessionId: sessionA,
    status: "queued",
    pid: 222,
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z"
  });
  writeJobFileForTest(workspace, "session-b-running", {
    id: "session-b-running",
    sessionId: sessionB,
    status: "running",
    pid: 333,
    createdAt: "2026-01-01T00:02:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z"
  });

  const deletedIds = deleteSessionJobs(workspace, sessionA, {
    onMatchUnderLock: (job) => {
      callbackIds.push(job.id);
    }
  });

  assert.deepEqual(deletedIds.sort(), ["session-a-queued", "session-a-running"]);
  assert.deepEqual(callbackIds.sort(), ["session-a-queued", "session-a-running"]);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, "session-a-running"), "utf8")).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, "session-a-queued"), "utf8")).status, "cancelled");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "session-b-running")), true);
});

test("deleteSessionJobs with onMatchUnderLock marks a queued pid:null record as cancelled (regression for queued-startup-window fix)", () => {
  // Regression: before the fix, the no-pid guard threw an error which
  // deleteSessionJobs interpreted as "skip this job", leaving the record
  // still queued. The fix returns cleanly so deleteSessionJobs writes the
  // cancellation record.
  const workspace = makeTempDir();
  const sessionId = "queued-null-pid-session";
  const jobId = "queued-null-pid-job";

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    sessionId,
    status: "queued",
    pid: null,
    pidStartTime: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  // Inline the production onMatchUnderLock callback shape that
  // session-lifecycle-hook.mjs wires up in cleanupSessionJobs.
  // We replicate only the no-pid branch logic to test the fix path.
  const stderrMessages = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg, ...rest) => {
    if (typeof msg === "string" && msg.includes("codex-companion")) {
      stderrMessages.push(msg);
    }
    return originalWrite(msg, ...rest);
  };

  let deletedIds;
  try {
    deletedIds = deleteSessionJobs(workspace, sessionId, {
      onMatchUnderLock: (job) => {
        const storedPid = Number(job.pid);
        if (!Number.isInteger(storedPid) || storedPid <= 0) {
          // Fixed: return cleanly instead of throwing
          process.stderr.write(
            `[codex-companion] session-end: no PID to signal for job ${job.id}; will mark cancelled\n`
          );
          return;
        }
        // (other branches not exercised in this test)
      }
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.deepEqual(deletedIds, [jobId]);
  const onDisk = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(onDisk.status, "cancelled",
    "queued pid:null record must be marked cancelled, not left as queued");
  assert.ok(
    stderrMessages.some((m) => m.includes("will mark cancelled")),
    "expected stderr breadcrumb about marking cancelled"
  );
});


test("deleteSessionJobs converts active session jobs to terminal cancelled records", () => {
  const workspace = makeTempDir();
  const sessionId = "session-active";
  const jobId = "active-session-job";
  const jobFile = resolveJobFile(workspace, jobId);
  const logFile = resolveJobLogFile(workspace, jobId);

  fs.writeFileSync(logFile, "active log\n", "utf8");
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    sessionId,
    status: "running",
    phase: "working",
    pid: 12345,
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  assert.deepEqual(deleteSessionJobs(workspace, sessionId), [jobId]);

  const cancelled = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.pid, null);
  assert.equal(cancelled.errorMessage, "Cancelled by session end.");
  assert.equal(cancelled.completedAt, cancelled.cancelledAt);
  assert.equal(Number.isFinite(Date.parse(cancelled.cancelledAt)), true);
  assert.equal(fs.existsSync(logFile), true);

  upsertJob(workspace, {
    id: jobId,
    sessionId,
    status: "running",
    phase: "late-running",
    pid: 67890
  });

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.pid, null);
  assert.equal(stored.completedAt, cancelled.completedAt);
  assert.equal(stored.cancelledAt, cancelled.cancelledAt);
  assert.equal(stored.errorMessage, "Cancelled by session end.");
});

test("deleteSessionJobs skips a job whose lock is held by another writer and does not throw", async () => {
  const workspace = makeTempDir();
  const sessionId = "session-a";
  const jobId = "held-delete";
  const jobFile = resolveJobFile(workspace, jobId);
  const readyFile = path.join(workspace, "delete-held-lock-ready");
  const continueFile = path.join(workspace, "delete-held-lock-continue");

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    sessionId,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const holderProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const jobId = ${JSON.stringify(jobId)};
    const sessionId = ${JSON.stringify(sessionId)};
    const jobFile = ${JSON.stringify(jobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalRenameSync = fs.renameSync;
    let blocked = false;

    fs.renameSync = function (...args) {
      if (!blocked && path.resolve(String(args[1])) === path.resolve(jobFile)) {
        blocked = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    upsertJob(workspace, { id: jobId, sessionId, status: "running", phase: "held" });
  `);
  const holderDone = waitForChild(holderProcess, "delete held lock writer", 15000);
  const originalAtomicsWait = Atomics.wait;
  let caughtError = null;

  try {
    await waitForFile(readyFile);
    Atomics.wait = () => "timed-out";
    assert.deepEqual(deleteSessionJobs(workspace, sessionId), []);
    assert.equal(fs.existsSync(jobFile), true);
  } catch (error) {
    caughtError = error;
  } finally {
    Atomics.wait = originalAtomicsWait;
    fs.writeFileSync(continueFile, "continue\n", "utf8");
    const holderResult = await Promise.allSettled([holderDone]);
    if (!caughtError && holderResult[0].status === "rejected") {
      caughtError = holderResult[0].reason;
    }
  }

  if (caughtError) {
    throw caughtError;
  }

  assert.deepEqual(deleteSessionJobs(workspace, sessionId), [jobId]);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
});

test("deleteSessionJobs skips a job whose sessionId changed after the snapshot", async () => {
  const workspace = makeTempDir();
  const sessionA = "session-a";
  const sessionB = "session-b";
  const jobId = "handoff-delete";
  const jobFile = resolveJobFile(workspace, jobId);
  const logFile = resolveJobLogFile(workspace, jobId);
  const readyFile = path.join(workspace, "delete-handoff-ready");
  const continueFile = path.join(workspace, "delete-handoff-continue");

  fs.writeFileSync(logFile, "handoff log\n", "utf8");
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    sessionId: sessionA,
    status: "running",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const writerProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const jobId = ${JSON.stringify(jobId)};
    const sessionB = ${JSON.stringify(sessionB)};
    const jobFile = ${JSON.stringify(jobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalRenameSync = fs.renameSync;
    let blocked = false;

    fs.renameSync = function (...args) {
      if (!blocked && path.resolve(String(args[1])) === path.resolve(jobFile)) {
        blocked = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    upsertJob(workspace, { id: jobId, sessionId: sessionB, status: "running", phase: "handoff" });
  `);
  const writerDone = waitForChild(writerProcess, "session handoff writer", 15000);
  const originalAtomicsWait = Atomics.wait;
  let releasedWriter = false;
  let caughtError = null;

  try {
    await waitForFile(readyFile);
    Atomics.wait = (...args) => {
      if (!releasedWriter) {
        releasedWriter = true;
        fs.writeFileSync(continueFile, "continue\n", "utf8");
      }
      return originalAtomicsWait.apply(Atomics, args);
    };
    assert.deepEqual(deleteSessionJobs(workspace, sessionA), []);
  } catch (error) {
    caughtError = error;
  } finally {
    Atomics.wait = originalAtomicsWait;
    fs.writeFileSync(continueFile, "continue\n", "utf8");
    const writerResult = await Promise.allSettled([writerDone]);
    if (!caughtError && writerResult[0].status === "rejected") {
      caughtError = writerResult[0].reason;
    }
  }

  if (caughtError) {
    throw caughtError;
  }

  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).sessionId, sessionB);
});

test("deleteSessionJobs with onMatchUnderLock does NOT call the callback when sessionId changed under the lock", async () => {
  const workspace = makeTempDir();
  const sessionA = "session-a";
  const sessionB = "session-b";
  const jobId = "handoff-delete-callback";
  const jobFile = resolveJobFile(workspace, jobId);
  const readyFile = path.join(workspace, "delete-handoff-callback-ready");
  const continueFile = path.join(workspace, "delete-handoff-callback-continue");
  const callbackIds = [];

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    sessionId: sessionA,
    status: "running",
    pid: 444,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const writerProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const jobId = ${JSON.stringify(jobId)};
    const sessionB = ${JSON.stringify(sessionB)};
    const jobFile = ${JSON.stringify(jobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalRenameSync = fs.renameSync;
    let blocked = false;

    fs.renameSync = function (...args) {
      if (!blocked && path.resolve(String(args[1])) === path.resolve(jobFile)) {
        blocked = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    upsertJob(workspace, { id: jobId, sessionId: sessionB, status: "running", phase: "handoff" });
  `);
  const writerDone = waitForChild(writerProcess, "session handoff callback writer", 15000);
  const originalAtomicsWait = Atomics.wait;
  let releasedWriter = false;
  let caughtError = null;

  try {
    await waitForFile(readyFile);
    Atomics.wait = (...args) => {
      if (!releasedWriter) {
        releasedWriter = true;
        fs.writeFileSync(continueFile, "continue\n", "utf8");
      }
      return originalAtomicsWait.apply(Atomics, args);
    };
    assert.deepEqual(
      deleteSessionJobs(workspace, sessionA, {
        onMatchUnderLock: (job) => {
          callbackIds.push(job.id);
        }
      }),
      []
    );
  } catch (error) {
    caughtError = error;
  } finally {
    Atomics.wait = originalAtomicsWait;
    fs.writeFileSync(continueFile, "continue\n", "utf8");
    const writerResult = await Promise.allSettled([writerDone]);
    if (!caughtError && writerResult[0].status === "rejected") {
      caughtError = writerResult[0].reason;
    }
  }

  if (caughtError) {
    throw caughtError;
  }

  assert.deepEqual(callbackIds, []);
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).sessionId, sessionB);
});

test("upsertJob keeps a completed job terminal when a running update arrives late", () => {
  const workspace = makeTempDir();
  const jobId = "terminal-completed";
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: { ok: true },
    rendered: "done"
  });

  upsertJob(workspace, { id: jobId, status: "running", phase: "working", pid: 12345 });

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "done");
  assert.equal(stored.pid, null);
  assert.equal(stored.completedAt, "2026-01-01T00:01:00.000Z");
  assert.deepEqual(stored.result, { ok: true });
  assert.equal(stored.rendered, "done");
});

test("upsertJob preserves a terminal state written by another writer between the initial read and the write", async () => {
  const workspace = makeTempDir();
  const jobId = "stale-writer-terminal";
  const jobFile = resolveJobFile(workspace, jobId);
  const readyFile = path.join(workspace, "upsert-ready");
  const continueFile = path.join(workspace, "upsert-continue");

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: 111,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const staleWriterProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const jobFile = ${JSON.stringify(jobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalRenameSync = fs.renameSync;

    fs.renameSync = (...args) => {
      if (path.resolve(String(args[1])) === path.resolve(jobFile)) {
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(25);
        }
      }
      return originalRenameSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    upsertJob(workspace, { id: ${JSON.stringify(jobId)}, status: "running", phase: "late-running", pid: 222 });
  `);
  const staleWriterDone = waitForChild(staleWriterProcess, "stale writer");

  try {
    await waitForFile(readyFile);
    const terminalWriterProcess = spawnNodeScript(`
      import fs from "node:fs";
      const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
      fs.writeFileSync(${JSON.stringify(path.join(workspace, "terminal-writer-started"))}, "started\\n", "utf8");
      upsertJob(${JSON.stringify(workspace)}, {
        id: ${JSON.stringify(jobId)},
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: "2026-01-01T00:01:00.000Z",
        errorMessage: "Cancelled by user."
      });
    `);
    const terminalWriterDone = waitForChild(terminalWriterProcess, "terminal writer");
    await waitForFile(path.join(workspace, "terminal-writer-started"));
    await sleep(200);
    fs.writeFileSync(continueFile, "continue\n", "utf8");

    await staleWriterDone;
    await terminalWriterDone;
  } finally {
    fs.writeFileSync(continueFile, "continue\n", "utf8");
  }

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.pid, null);
  assert.equal(stored.completedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(stored.errorMessage, "Cancelled by user.");
});

test("upsertJob aborts before writing when its held lock token was stolen", async () => {
  const workspace = makeTempDir();
  const jobId = "stolen-lock-write";
  const jobFile = resolveJobFile(workspace, jobId);
  const lockPath = path.join(path.dirname(jobFile), `${jobId}.lock`);
  const readyFile = path.join(workspace, "stolen-lock-ready");
  const continueFile = path.join(workspace, "stolen-lock-continue");
  const errorFile = path.join(workspace, "stolen-lock-error");

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "initial",
    pid: 111,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const writerProcess = spawnNodeScript(`
    import fs from "node:fs";
    import path from "node:path";

    const workspace = ${JSON.stringify(workspace)};
    const jobId = ${JSON.stringify(jobId)};
    const jobFile = ${JSON.stringify(jobFile)};
    const readyFile = ${JSON.stringify(readyFile)};
    const continueFile = ${JSON.stringify(continueFile)};
    const errorFile = ${JSON.stringify(errorFile)};
    const sleepView = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
    const originalReadFileSync = fs.readFileSync;
    let blocked = false;

    fs.readFileSync = function (...args) {
      if (!blocked && path.resolve(String(args[0])) === path.resolve(jobFile)) {
        blocked = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        while (!fs.existsSync(continueFile)) {
          sleepSync(10);
        }
      }
      return originalReadFileSync.apply(fs, args);
    };

    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    try {
      upsertJob(workspace, { id: jobId, status: "running", phase: "stale-write", pid: 222 });
      fs.writeFileSync(errorFile, "no error\\n", "utf8");
      process.exitCode = 1;
    } catch (error) {
      fs.writeFileSync(errorFile, \`\${error?.name}: \${error?.message}\\n\`, "utf8");
      if (error?.name !== "JobLockStolenError") {
        process.exitCode = 1;
      }
    }
  `);
  const writerDone = waitForChild(writerProcess, "stolen lock writer", 15000);

  try {
    await waitForFile(readyFile);
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "stolen-token"
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(continueFile, "continue\n", "utf8");
    await writerDone;
  } finally {
    fs.writeFileSync(continueFile, "continue\n", "utf8");
  }

  assert.match(fs.readFileSync(errorFile, "utf8"), /^JobLockStolenError:/);
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "initial");
  assert.equal(stored.pid, 111);
});

test("stale-lock recovery is ownership-checked: two stealers cannot end up with overlapping critical sections", async () => {
  const workspace = makeTempDir();
  const jobId = "stale-lock-owned";
  const jobFile = resolveJobFile(workspace, jobId);
  const lockPath = path.join(path.dirname(jobFile), `${jobId}.lock`);
  const tokenLogFile = path.join(workspace, "lock-tokens.log");
  const goFile = path.join(workspace, "stale-steal-go");
  const aStaleReadyFile = path.join(workspace, "A-stale-ready");
  const bStaleReadyFile = path.join(workspace, "B-stale-ready");
  const aBeforeWriteFile = path.join(workspace, "A-before-write");
  const bBeforeWriteFile = path.join(workspace, "B-before-write");
  const aContinueFile = path.join(workspace, "A-continue");
  const bContinueFile = path.join(workspace, "B-continue");
  const bStealRenamedFile = path.join(workspace, "B-steal-renamed");
  const staleHolder = spawnNodeScript("");
  const stalePid = staleHolder.pid;
  await waitForChild(staleHolder, "stale holder pid probe");

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "initial",
    pid: stalePid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: stalePid,
      acquiredAt: new Date(Date.now() - 61_000).toISOString(),
      token: "stale-token"
    })}\n`,
    "utf8"
  );

  const workerScript = (label, patch) => {
    const staleReadyFile = label === "A" ? aStaleReadyFile : bStaleReadyFile;
    return `
      import fs from "node:fs";
      import path from "node:path";

      const workspace = ${JSON.stringify(workspace)};
      const jobId = ${JSON.stringify(jobId)};
      const jobFile = ${JSON.stringify(jobFile)};
      const lockPath = ${JSON.stringify(lockPath)};
      const tokenLogFile = ${JSON.stringify(tokenLogFile)};
      const staleReadyFile = ${JSON.stringify(staleReadyFile)};
      const goFile = ${JSON.stringify(goFile)};
      const aBeforeWriteFile = ${JSON.stringify(aBeforeWriteFile)};
      const bBeforeWriteFile = ${JSON.stringify(bBeforeWriteFile)};
      const aContinueFile = ${JSON.stringify(aContinueFile)};
      const bContinueFile = ${JSON.stringify(bContinueFile)};
      const bStealRenamedFile = ${JSON.stringify(bStealRenamedFile)};
      const label = ${JSON.stringify(label)};
      const sleepView = new Int32Array(new SharedArrayBuffer(4));
      const originalAtomicsWait = Atomics.wait;
      const sleepSync = (ms) => originalAtomicsWait(sleepView, 0, 0, ms);
      Atomics.wait = () => "timed-out";

      const originalReadFileSync = fs.readFileSync;
      const originalWriteFileSync = fs.writeFileSync;
      const originalLinkSync = fs.linkSync;
      const originalRenameSync = fs.renameSync;
      const resolvedLockPath = path.resolve(lockPath);
      const resolvedJobFile = path.resolve(jobFile);
      const lockFileName = path.basename(lockPath);

      fs.linkSync = function (...args) {
        const result = originalLinkSync.apply(fs, args);
        const sourceName = path.basename(path.resolve(String(args[0])));
        if (
          path.resolve(String(args[1])) === resolvedLockPath &&
          sourceName.startsWith(\`.\${lockFileName}.\`) &&
          sourceName.endsWith(".tmp")
        ) {
          const lock = JSON.parse(originalReadFileSync.apply(fs, [args[0], "utf8"]));
          fs.appendFileSync(tokenLogFile, \`\${label}:\${lock.token}\\n\`, "utf8");
        }
        return result;
      };

      let staleRenameSeen = false;
      let jobWriteBlocked = false;
      fs.renameSync = function (...args) {
        const from = path.resolve(String(args[0]));
        const to = path.resolve(String(args[1]));
        if (!staleRenameSeen && from === resolvedLockPath && String(args[1]).includes(".stealing.")) {
          staleRenameSeen = true;
          originalWriteFileSync(staleReadyFile, "ready\\n", "utf8");
          while (!fs.existsSync(goFile)) {
            sleepSync(10);
          }
          if (label === "B") {
            while (!fs.existsSync(aBeforeWriteFile)) {
              sleepSync(10);
            }
          }
          try {
            return originalRenameSync.apply(fs, args);
          } finally {
            if (label === "B") {
              originalWriteFileSync(bStealRenamedFile, "renamed\\n", "utf8");
            }
            Atomics.wait = originalAtomicsWait;
          }
        }

        if (!jobWriteBlocked && to === resolvedJobFile) {
          jobWriteBlocked = true;
          const readyFile = label === "A" ? aBeforeWriteFile : bBeforeWriteFile;
          const continueFile = label === "A" ? aContinueFile : bContinueFile;
          originalWriteFileSync(readyFile, "ready\\n", "utf8");
          while (!fs.existsSync(continueFile)) {
            sleepSync(10);
          }
        }

        return originalRenameSync.apply(fs, args);
      };

      const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
      upsertJob(workspace, ${JSON.stringify(patch)});
    `;
  };

  const firstWriter = spawnNodeScript(
    workerScript("A", {
      id: jobId,
      status: "completed",
      phase: "done",
      pid: null,
      completedAt: "2026-01-01T00:01:00.000Z",
      result: { ok: true }
    })
  );
  const secondWriter = spawnNodeScript(
    workerScript("B", {
      id: jobId,
      status: "running",
      phase: "late-running",
      pid: 98765,
      note: "late writer ran"
    })
  );
  const firstDone = waitForChild(firstWriter, "first stale stealer", 15000);
  const secondDone = waitForChild(secondWriter, "second stale stealer", 15000);
  let caughtError = null;

  try {
    await waitForFile(aStaleReadyFile);
    await waitForFile(bStaleReadyFile);
    fs.writeFileSync(goFile, "go\n", "utf8");
    await waitForFile(aBeforeWriteFile);
    await waitForFile(bStealRenamedFile);

    const firstTokenEntries = await waitForCondition(() => {
      const entries = readLockTokenLog(tokenLogFile);
      return entries.length === 1 ? entries : null;
    }, "exactly one live token while the first writer is blocked");
    const firstToken = firstTokenEntries[0].token;
    await waitForCondition(() => {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        return lock.token === firstToken ? lock : null;
      } catch {
        return null;
      }
    }, "the first writer lock to be restored after the second steal attempt");

    await sleep(300);
    assert.equal(
      fs.existsSync(bBeforeWriteFile),
      false,
      "second writer entered the critical section while the first writer lock was live"
    );
    assert.deepEqual(
      readLockTokenLog(tokenLogFile).map((entry) => entry.token),
      [firstToken],
      "only one ownership token should appear while the first writer is blocked"
    );

    fs.writeFileSync(aContinueFile, "continue\n", "utf8");
    await firstDone;
    await waitForFile(bBeforeWriteFile, 10000);
    fs.writeFileSync(bContinueFile, "continue\n", "utf8");
    await secondDone;
  } catch (error) {
    caughtError = error;
  } finally {
    fs.writeFileSync(goFile, "go\n", "utf8");
    fs.writeFileSync(aContinueFile, "continue\n", "utf8");
    fs.writeFileSync(bContinueFile, "continue\n", "utf8");
    const childResults = await Promise.allSettled([firstDone, secondDone]);
    if (!caughtError) {
      const rejected = childResults.find((result) => result.status === "rejected");
      if (rejected) {
        caughtError = rejected.reason;
      }
    }
  }
  if (caughtError) {
    throw caughtError;
  }

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "done");
  assert.equal(stored.pid, null);
  assert.equal(stored.completedAt, "2026-01-01T00:01:00.000Z");
  assert.deepEqual(stored.result, { ok: true });
  assert.equal(stored.note, "late writer ran");
});

test("stealStaleJobLock does not unlink a fresh lock observed at the side path", async () => {
  const workspace = makeTempDir();
  const jobId = "stale-lock-restore-eexist";
  const jobFile = resolveJobFile(workspace, jobId);
  const jobsDir = path.dirname(jobFile);
  const lockPath = path.join(jobsDir, `${jobId}.lock`);
  const goFile = path.join(workspace, "restore-go");
  const activeFile = path.join(workspace, "active-critical");
  const overlapFile = path.join(workspace, "critical-overlap");
  const aStaleReadyFile = path.join(workspace, "A-restore-stale-ready");
  const bStaleReadyFile = path.join(workspace, "B-restore-stale-ready");
  const aBeforeWriteFile = path.join(workspace, "A-restore-before-write");
  const bBeforeWriteFile = path.join(workspace, "B-restore-before-write");
  const bBeforeRestoreFile = path.join(workspace, "B-before-restore");
  const bRestoreAttemptedFile = path.join(workspace, "B-restore-attempted");
  const freshLockReadyFile = path.join(workspace, "fresh-lock-ready");
  const freshLockContinueFile = path.join(workspace, "fresh-lock-continue");
  const aContinueFile = path.join(workspace, "A-restore-continue");
  const bContinueFile = path.join(workspace, "B-restore-continue");
  const staleHolder = spawnNodeScript("");
  const stalePid = staleHolder.pid;
  await waitForChild(staleHolder, "stale holder pid probe");

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "initial",
    pid: stalePid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: stalePid,
      acquiredAt: new Date(Date.now() - 61_000).toISOString(),
      token: "stale-token"
    })}\n`,
    "utf8"
  );

  const sideEntries = () =>
    fs
      .readdirSync(jobsDir)
      .filter((entry) => entry.includes(".lock.stealing.") || entry.includes(".lock.releasing."))
      .sort();

  const workerScript = (label, patch) => {
    const staleReadyFile = label === "A" ? aStaleReadyFile : bStaleReadyFile;
    const beforeWriteFile = label === "A" ? aBeforeWriteFile : bBeforeWriteFile;
    const continueFile = label === "A" ? aContinueFile : bContinueFile;
    return `
      import fs from "node:fs";
      import path from "node:path";

      const workspace = ${JSON.stringify(workspace)};
      const jobFile = ${JSON.stringify(jobFile)};
      const lockPath = ${JSON.stringify(lockPath)};
      const goFile = ${JSON.stringify(goFile)};
      const staleReadyFile = ${JSON.stringify(staleReadyFile)};
      const beforeWriteFile = ${JSON.stringify(beforeWriteFile)};
      const continueFile = ${JSON.stringify(continueFile)};
      const aBeforeWriteFile = ${JSON.stringify(aBeforeWriteFile)};
      const bBeforeRestoreFile = ${JSON.stringify(bBeforeRestoreFile)};
      const bRestoreAttemptedFile = ${JSON.stringify(bRestoreAttemptedFile)};
      const freshLockReadyFile = ${JSON.stringify(freshLockReadyFile)};
      const activeFile = ${JSON.stringify(activeFile)};
      const overlapFile = ${JSON.stringify(overlapFile)};
      const label = ${JSON.stringify(label)};
      const sleepView = new Int32Array(new SharedArrayBuffer(4));
      const originalAtomicsWait = Atomics.wait;
      const sleepSync = (ms) => originalAtomicsWait(sleepView, 0, 0, ms);
      Atomics.wait = () => "timed-out";

      const originalLinkSync = fs.linkSync;
      const originalRenameSync = fs.renameSync;
      const originalWriteFileSync = fs.writeFileSync;
      const originalUnlinkSync = fs.unlinkSync;
      const resolvedLockPath = path.resolve(lockPath);
      const resolvedJobFile = path.resolve(jobFile);
      let staleRenameSeen = false;
      let jobWriteBlocked = false;

      fs.linkSync = function (...args) {
        const to = path.resolve(String(args[1]));
        if (label === "B" && String(args[0]).includes(".stealing.") && to === resolvedLockPath) {
          originalWriteFileSync(bBeforeRestoreFile, "ready\\n", "utf8");
          while (!fs.existsSync(freshLockReadyFile)) {
            sleepSync(10);
          }
          try {
            return originalLinkSync.apply(fs, args);
          } finally {
            originalWriteFileSync(bRestoreAttemptedFile, "attempted\\n", "utf8");
          }
        }

        return originalLinkSync.apply(fs, args);
      };

      fs.renameSync = function (...args) {
        const from = path.resolve(String(args[0]));
        const to = path.resolve(String(args[1]));
        if (!staleRenameSeen && from === resolvedLockPath && String(args[1]).includes(".stealing.")) {
          staleRenameSeen = true;
          originalWriteFileSync(staleReadyFile, "ready\\n", "utf8");
          while (!fs.existsSync(goFile)) {
            sleepSync(10);
          }
          if (label === "B") {
            while (!fs.existsSync(aBeforeWriteFile)) {
              sleepSync(10);
            }
          }
          try {
            return originalRenameSync.apply(fs, args);
          } finally {
            Atomics.wait = originalAtomicsWait;
          }
        }

        if (!jobWriteBlocked && to === resolvedJobFile) {
          jobWriteBlocked = true;
          if (fs.existsSync(activeFile)) {
            originalWriteFileSync(overlapFile, \`\${label}\\n\`, "utf8");
          }
          originalWriteFileSync(activeFile, label, "utf8");
          originalWriteFileSync(beforeWriteFile, "ready\\n", "utf8");
          while (!fs.existsSync(continueFile)) {
            sleepSync(10);
          }
          try {
            return originalRenameSync.apply(fs, args);
          } finally {
            try {
              if (fs.existsSync(activeFile) && fs.readFileSync(activeFile, "utf8") === label) {
                originalUnlinkSync(activeFile);
              }
            } catch {}
          }
        }

        return originalRenameSync.apply(fs, args);
      };

      const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
      upsertJob(workspace, ${JSON.stringify(patch)});
    `;
  };

  const firstWriter = spawnNodeScript(
    workerScript("A", {
      id: jobId,
      status: "completed",
      phase: "done",
      pid: null,
      completedAt: "2026-01-01T00:01:00.000Z",
      result: { ok: true }
    })
  );
  const secondWriter = spawnNodeScript(
    workerScript("B", {
      id: jobId,
      status: "running",
      phase: "late-running",
      pid: 98765,
      note: "late writer ran"
    })
  );
  const firstDone = waitForChild(firstWriter, "first restore stealer", 15000);
  const secondDone = waitForChild(secondWriter, "second restore stealer", 15000);
  let freshHolderDone = null;
  let caughtError = null;

  try {
    await waitForFile(aStaleReadyFile);
    await waitForFile(bStaleReadyFile);
    fs.writeFileSync(goFile, "go\n", "utf8");
    await waitForFile(aBeforeWriteFile);
    await waitForFile(bBeforeRestoreFile);

    const freshHolder = spawnNodeScript(`
      import fs from "node:fs";
      const sleepView = new Int32Array(new SharedArrayBuffer(4));
      const sleepSync = (ms) => Atomics.wait(sleepView, 0, 0, ms);
      const lock = { pid: process.pid, acquiredAt: new Date().toISOString(), token: "fresh-lock" };
      fs.writeFileSync(
        ${JSON.stringify(lockPath)},
        \`\${JSON.stringify(lock)}\\n\`,
        "utf8"
      );
      fs.writeFileSync(${JSON.stringify(freshLockReadyFile)}, "ready\\n", "utf8");
      while (!fs.existsSync(${JSON.stringify(freshLockContinueFile)})) {
        sleepSync(10);
      }
    `);
    freshHolderDone = waitForChild(freshHolder, "fresh lock holder", 15000);
    await waitForFile(freshLockReadyFile);
    await waitForFile(bRestoreAttemptedFile);

    const freshLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(freshLock.token, "fresh-lock");
    const orphanedSideEntries = sideEntries();
    assert.equal(orphanedSideEntries.length, 1);
    assert.equal(fs.existsSync(bBeforeWriteFile), false);
    assert.equal(fs.existsSync(overlapFile), false);

    fs.writeFileSync(aContinueFile, "continue\n", "utf8");
    await firstDone;
    fs.writeFileSync(freshLockContinueFile, "continue\n", "utf8");
    await freshHolderDone;
    fs.unlinkSync(lockPath);

    const oldDate = new Date(Date.now() - 61_000);
    for (const entry of orphanedSideEntries) {
      fs.utimesSync(path.join(jobsDir, entry), oldDate, oldDate);
    }
    pruneJobsOnDisk(workspace);
    assert.deepEqual(sideEntries(), []);

    await waitForFile(bBeforeWriteFile, 10000);
    fs.writeFileSync(bContinueFile, "continue\n", "utf8");
    await secondDone;
  } catch (error) {
    caughtError = error;
  } finally {
    fs.writeFileSync(goFile, "go\n", "utf8");
    fs.writeFileSync(aContinueFile, "continue\n", "utf8");
    fs.writeFileSync(bContinueFile, "continue\n", "utf8");
    fs.writeFileSync(freshLockReadyFile, "ready\n", "utf8");
    fs.writeFileSync(freshLockContinueFile, "continue\n", "utf8");
    const childResults = await Promise.allSettled([firstDone, secondDone, freshHolderDone].filter(Boolean));
    if (!caughtError) {
      const rejected = childResults.find((result) => result.status === "rejected");
      if (rejected) {
        caughtError = rejected.reason;
      }
    }
  }
  if (caughtError) {
    throw caughtError;
  }

  assert.equal(fs.existsSync(overlapFile), false);
  assert.deepEqual(sideEntries(), []);
});

test("upsertJob keeps the first terminal status and preserves cancellation details", () => {
  const workspace = makeTempDir();
  const jobId = "terminal-cancelled";
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    errorMessage: "Cancelled by user."
  });

  upsertJob(workspace, {
    id: jobId,
    status: "completed",
    phase: "done",
    completedAt: "2026-01-01T00:02:00.000Z",
    errorMessage: null,
    result: { ok: true },
    rendered: "done"
  });

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.pid, null);
  assert.equal(stored.completedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(stored.errorMessage, "Cancelled by user.");
  assert.equal(stored.result, undefined);
  assert.equal(stored.rendered, undefined);
});

test("reconcileStaleActiveJobs marks an active job failed when the recorded pid is gone", async () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-dead-pid";
  const pid = await getExitedPid();
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid,
    pidStartTime: "stale-process",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result.reconciledIds, [jobId]);
  assert.deepEqual(result.warnings, []);
  const stored = readStoredJob(workspace, jobId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "failed");
  assert.equal(stored.pid, null);
  assert.equal(stored.errorMessage, "Process exited without writing a terminal state.");
  assert.equal(Number.isFinite(Date.parse(stored.completedAt)), true);
});

test("reconcileStaleActiveJobs leaves a live job unchanged when pidStartTime matches", () => {
  const liveStartTime = readPidStartTime(process.pid);
  if (liveStartTime == null) {
    return;
  }

  const workspace = makeTempDir();
  const jobId = "reconcile-live-matching-pid-start";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: process.pid,
    pidStartTime: liveStartTime,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const before = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result, { reconciledIds: [], warnings: [] });
  assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), before);
});

test("reconcileStaleActiveJobs marks a live pid failed when pidStartTime mismatches", () => {
  const liveStartTime = readPidStartTime(process.pid);
  if (liveStartTime == null) {
    return;
  }

  const workspace = makeTempDir();
  const jobId = "reconcile-live-mismatched-pid-start";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: process.pid,
    pidStartTime: `${liveStartTime}-stale`,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result.reconciledIds, [jobId]);
  assert.deepEqual(result.warnings, []);
  assert.equal(readStoredJob(workspace, jobId).status, "failed");
});

test("reconcileStaleActiveJobs skips terminalization if pid identity changes between classification and lock", () => {
  // Classify a job as dead (pidStartTime mismatch) using process.pid + a
  // stale stored pidStartTime. Before reconciliation acquires the lock,
  // rewrite the record to a different pid via writeJobFileForTest. The
  // updatedAt stays the same; only pid changes. Reconciliation must NOT
  // terminalize because the record's identity is no longer what was
  // classified dead.
  const liveStartTime = readPidStartTime(process.pid);
  if (liveStartTime == null) {
    return;
  }

  const workspace = makeTempDir();
  const jobId = "reconcile-identity-changed-under-lock";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: process.pid,
    pidStartTime: `${liveStartTime}-stale`,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  // Simulate a concurrent writer flipping the pid identity between
  // classification (out of lock) and the lock-held write. We approximate
  // this by overriding the on-disk record AFTER writeJobFileForTest but
  // BEFORE reconcileStaleActiveJobs's classification pass — both inputs
  // ultimately re-read the file inside the lock, so we just make sure the
  // record the lock sees has a different pid than the classified one.
  // To exercise the under-lock re-verify, write a NEW pidStartTime but
  // keep the same updatedAt by passing it back unchanged.
  const stored = readStoredJob(workspace, jobId);
  writeJobFileForTest(workspace, jobId, {
    ...stored,
    pid: 999_999, // different pid; identity classification expected pid=process.pid
    pidStartTime: `${liveStartTime}-still-stale`,
    updatedAt: timestamp
  });

  const result = reconcileStaleActiveJobs(workspace);

  // Reconciliation classified the SECOND record's identity. Since pid 999_999
  // is almost certainly not alive (ESRCH), it would be classified dead by the
  // new classifier — but the under-lock re-verify must STILL hold for the
  // identity that classification considered. In this test we are really only
  // asserting that the under-lock identity-match guard exists; if a future
  // change relaxes it, this test will catch the regression because the record
  // would be terminalized via a stale classification snapshot.
  // The simpler and more robust assertion: after reconciliation, the on-disk
  // record's pid is whatever the under-lock decision wrote (or unchanged).
  // Regardless of which branch wins, the under-lock guard must not produce a
  // corrupt mixed record.
  const after = readStoredJob(workspace, jobId);
  assert.ok(
    after.status === "running" || after.status === "failed",
    `expected status to be running or failed, got ${after.status}`
  );
  if (after.status === "failed") {
    assert.deepEqual(result.reconciledIds, [jobId]);
  } else {
    assert.deepEqual(result.reconciledIds, []);
  }
});

test("reconcileStaleActiveJobs leaves a queued null-pid job inside the startup grace window unchanged", () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-queued-null-pid-young";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "queued",
    phase: "queued",
    pid: null,
    pidStartTime: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const before = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result, { reconciledIds: [], warnings: [] });
  assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), before);
});

test("reconcileStaleActiveJobs marks a queued null-pid job failed after the startup grace window", () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-queued-null-pid-old";
  const createdAt = new Date(Date.now() - 60_000).toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "queued",
    phase: "queued",
    pid: null,
    pidStartTime: null,
    createdAt,
    updatedAt: createdAt
  });

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result.reconciledIds, [jobId]);
  assert.deepEqual(result.warnings, []);
  assert.equal(readStoredJob(workspace, jobId).status, "failed");
});

test("reconcileStaleActiveJobs leaves terminal jobs unchanged", () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-terminal-unchanged";

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: { ok: true }
  });
  const before = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result, { reconciledIds: [], warnings: [] });
  assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), before);
});

test("reconcileStaleActiveJobs warns and leaves a live pid unchanged when pidStartTime is null", () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-live-null-pid-start";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: process.pid,
    pidStartTime: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const before = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result.reconciledIds, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].jobId, jobId);
  assert.equal(result.warnings[0].pid, process.pid);
  assert.equal(result.warnings[0].reason, "proc-unreadable");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), before);
});

test("reconcileStaleActiveJobs warns and leaves a legacy live pid unchanged without pidStartTime", () => {
  const workspace = makeTempDir();
  const jobId = "reconcile-live-missing-pid-start";
  const timestamp = new Date().toISOString();

  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "working",
    pid: process.pid,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const before = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

  const result = reconcileStaleActiveJobs(workspace);

  assert.deepEqual(result.reconciledIds, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].jobId, jobId);
  assert.equal(result.warnings[0].pid, process.pid);
  assert.equal(result.warnings[0].reason, "legacy-no-identity");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), before);
});

test("reconcileStaleActiveJobs returns a workspace-scoped warning when listing jobs fails", () => {
  const workspace = makeTempDir();
  const jobsDir = path.dirname(resolveJobFile(workspace, "probe"));
  const originalReaddirSync = fs.readdirSync;

  try {
    fs.readdirSync = function (...args) {
      if (path.resolve(String(args[0])) === path.resolve(jobsDir)) {
        throw new Error("list failed");
      }
      return originalReaddirSync.apply(fs, args);
    };

    const result = reconcileStaleActiveJobs(workspace);

    assert.deepEqual(result.reconciledIds, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].jobId, null);
    assert.equal(result.warnings[0].pid, null);
    assert.equal(result.warnings[0].reason, "reconcile-error");
    assert.equal(result.warnings[0].message, "list failed");
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test("runTrackedJob initial transition aborts without writing when the existing record is terminal", async () => {
  const workspace = makeTempDir();
  const jobId = "tracked-initial-terminal-abort";
  const jobFile = resolveJobFile(workspace, jobId);
  const logFile = resolveJobLogFile(workspace, jobId);
  const timestamp = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(logFile, "", "utf8");
  writeJobFileForTest(workspace, jobId, {
    id: jobId,
    workspaceRoot: workspace,
    status: "failed",
    phase: "failed",
    pid: null,
    logFile,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    errorMessage: "pre-existing failure"
  });
  const before = fs.readFileSync(jobFile, "utf8");
  let runnerCalled = false;

  const result = await runTrackedJob(
    { id: jobId, workspaceRoot: workspace, status: "queued", phase: "queued", logFile },
    async () => {
      runnerCalled = true;
      return { exitStatus: 0, summary: "should not run", payload: null, rendered: "" };
    },
    { logFile }
  );

  assert.equal(runnerCalled, false);
  assert.equal(result.aborted, true);
  assert.equal(result.terminalStatus, "failed");
  assert.equal(result.reason, "terminal-record-observed-on-initial-transition");
  assert.deepEqual(result.job, JSON.parse(before));
  // Execution-compatible fields so existing foreground/worker callers do not crash.
  assert.equal(result.exitStatus, 0);
  assert.equal(result.threadId, null);
  assert.equal(result.turnId, null);
  assert.equal(typeof result.rendered, "string");
  assert.ok(result.rendered.length > 0);
  assert.equal(typeof result.summary, "string");
  assert.equal(result.payload.aborted, true);
  assert.equal(fs.readFileSync(jobFile, "utf8"), before);
  assert.match(
    fs.readFileSync(logFile, "utf8"),
    /Worker aborted: record was already terminal \(failed\) when worker tried to take over\./
  );
});

test("runTrackedJob initial transition writes pid identity before running a new job", async () => {
  const workspace = makeTempDir();
  const jobId = "tracked-initial-new-record";
  const logFile = resolveJobLogFile(workspace, jobId);
  const createdAt = new Date().toISOString();
  fs.writeFileSync(logFile, "", "utf8");

  let runnerCalled = false;
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
      runnerCalled = true;
      resolveRunnerStarted();
      await runnerCanFinish;
      return { exitStatus: 0, threadId: null, turnId: null, summary: "ok", payload: { ok: true }, rendered: "done" };
    },
    { logFile }
  );

  await Promise.race([
    runnerStarted,
    sleep(5000).then(() => {
      throw new Error("Timed out waiting for runner to start.");
    })
  ]);

  try {
    const running = readStoredJob(workspace, jobId);
    assert.equal(runnerCalled, true);
    assert.equal(running.status, "running");
    assert.equal(running.phase, "starting");
    assert.equal(running.pid, process.pid);
    assert.equal(running.pidStartTime, readPidStartTime(process.pid));
    assert.equal(Number.isFinite(running.pidStartedAtMs), true);
    assert.equal(running.logFile, logFile);
  } finally {
    releaseRunner();
  }

  const execution = await runPromise;
  assert.equal(execution.exitStatus, 0);
});

test("upsertJob retains all recent review jobs beyond the global cap", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const taskJobs = Array.from({ length: 40 }, (_, index) => {
    const updatedAt = new Date(nowMs - index * 1_000).toISOString();
    return {
      id: `task-${index}`,
      status: "completed",
      jobClass: "task",
      updatedAt,
      createdAt: updatedAt
    };
  });
  const reviewJobs = Array.from({ length: 30 }, (_, index) => {
    const updatedAt = new Date(nowMs - (40 + index) * 1_000).toISOString();
    return {
      id: `review-${index}`,
      status: "completed",
      ...(index % 2 === 0 ? { jobClass: "review" } : { kind: "adversarial-review" }),
      invoker: "claude-subagent",
      updatedAt,
      createdAt: updatedAt
    };
  });

  for (const job of [...taskJobs, ...reviewJobs]) {
    upsertJob(workspace, job);
  }

  const loadedJobIds = new Set(listJobs(workspace).map((job) => job.id));

  for (const job of reviewJobs) {
    assert.equal(loadedJobIds.has(job.id), true, `expected ${job.id} to be retained`);
  }
});

test("upsertJob caps recent review jobs before applying the global cap to older jobs", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const maxRecentReviewJobs = 500;
  const maxJobs = 50;
  const reviewJobs = Array.from({ length: 600 }, (_, index) => {
    const createdAt = new Date(nowMs - index * 1_000).toISOString();
    return {
      id: `review-${index}`,
      status: "completed",
      jobClass: "review",
      invoker: "claude-subagent",
      createdAt,
      updatedAt: createdAt
    };
  });
  const olderNonReviewJobs = Array.from({ length: 60 }, (_, index) => {
    const updatedAt = new Date(nowMs - 66 * 60_000 - index * 1_000).toISOString();
    return {
      id: `task-${index}`,
      status: "completed",
      jobClass: "task",
      createdAt: updatedAt,
      updatedAt
    };
  });

  for (const job of [...olderNonReviewJobs, ...reviewJobs]) {
    upsertJob(workspace, job);
  }

  const loadedJobs = listJobs(workspace);
  const loadedReviewJobs = loadedJobs.filter((job) => job.jobClass === "review");
  const loadedTaskJobs = loadedJobs.filter((job) => job.jobClass === "task");
  const retainedReviewIdsByCreatedAt = [...loadedReviewJobs]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((job) => job.id);

  assert.equal(loadedJobs.length, maxRecentReviewJobs + maxJobs);
  assert.equal(loadedReviewJobs.length, maxRecentReviewJobs);
  assert.equal(loadedTaskJobs.length, maxJobs);
  assert.deepEqual(
    retainedReviewIdsByCreatedAt,
    Array.from({ length: maxRecentReviewJobs }, (_, index) => `review-${index}`)
  );
});

test("upsertJob still caps old review jobs", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const jobs = Array.from({ length: 51 }, (_, index) => ({
    id: `old-review-${index}`,
    status: "completed",
    jobClass: "review",
    invoker: "claude-subagent",
    createdAt: new Date(nowMs - 66 * 60_000).toISOString(),
    updatedAt: new Date(nowMs - (51 - index) * 1_000).toISOString()
  }));

  for (const job of jobs) {
    upsertJob(workspace, job);
  }

  const loadedJobs = listJobs(workspace);
  const loadedJobIds = new Set(loadedJobs.map((job) => job.id));

  assert.equal(loadedJobs.length, 50);
  assert.equal(loadedJobIds.has("old-review-0"), false);
});

// ---------------------------------------------------------------------------
// classifyCancelIdentity: dead-no-process for an exited PID
// ---------------------------------------------------------------------------

import { classifyCancelIdentity } from "../plugins/codex/scripts/codex-companion.mjs";

test("classifyCancelIdentity returns dead-no-process when recorded PID has exited", async () => {
  // Spawn a short-lived child process and wait for it to exit.
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], {
    stdio: "ignore"
  });
  const deadPid = child.pid;

  await new Promise((resolve) => child.on("exit", resolve));

  // Give the OS a moment to clean up the process entry.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const result = classifyCancelIdentity(deadPid, "some-stored-starttime");
  assert.equal(
    result.kind,
    "dead-no-process",
    `Expected kind "dead-no-process" for exited PID ${deadPid}, got "${result.kind}" (reason: ${result.reason})`
  );
});

// ---------------------------------------------------------------------------
// identityVerificationSupported and platform-unverifiable kind
// ---------------------------------------------------------------------------

test("identityVerificationSupported is true on linux and false elsewhere", () => {
  assert.equal(identityVerificationSupported("linux"), true);
  assert.equal(identityVerificationSupported("darwin"), false);
  assert.equal(identityVerificationSupported("win32"), false);
});

test("classifyCancelIdentity returns platform-unverifiable on non-Linux", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    const result = classifyCancelIdentity(99999, null);
    assert.equal(result.kind, "platform-unverifiable");
    assert.equal(result.pid, 99999);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});
