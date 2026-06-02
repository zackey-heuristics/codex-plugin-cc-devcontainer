import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  readJobFile,
  readPidStartTime,
  resolveProgressTimeoutMs,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  withJobLock,
  writeJobFileUnlocked
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const PROGRESS_UPDATE_THROTTLE_MS = 5_000;
const TRANSIENT_APPEND_ERROR_CODES = new Set(["EACCES", "EBUSY", "EAGAIN", "EPERM", "EMFILE", "ENFILE", "EINTR"]);
const APPEND_RETRY_DELAYS_MS = [5, 10];
const appendCircuitOpenByLogFile = new Map();

let appendFileSyncImpl = fs.appendFileSync;

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeAppendError(error) {
  if (error instanceof Error) {
    return error;
  }
  const normalized = new Error(String(error));
  if (error && typeof error === "object" && "code" in error) {
    normalized.code = error.code;
  }
  return normalized;
}

function getErrorCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "UNKNOWN";
}

function isTransientAppendError(error) {
  return TRANSIENT_APPEND_ERROR_CODES.has(getErrorCode(error));
}

function unavailableStat(error) {
  return `unavailable:${getErrorCode(error)}`;
}

function readStatField(filePath, readField) {
  try {
    return String(readField(fs.statSync(filePath)));
  } catch (error) {
    return unavailableStat(error);
  }
}

function readProcessField(readField) {
  try {
    const value = readField();
    return value == null ? "unavailable:UNKNOWN" : String(value);
  } catch (error) {
    return unavailableStat(error);
  }
}

function formatMode(mode) {
  return `0o${mode.toString(8)}`;
}

function emitAppendFailureDiagnostic(logFile, attempts, error) {
  const dir = path.dirname(logFile);
  const code = getErrorCode(error);
  const parts = [
    "[codex-companion] log append failed",
    `code=${code}`,
    `attempts=${attempts}`,
    `logFile=${JSON.stringify(logFile)}`,
    `file.mode=${readStatField(logFile, (stat) => formatMode(stat.mode))}`,
    `file.uid=${readStatField(logFile, (stat) => stat.uid)}`,
    `file.gid=${readStatField(logFile, (stat) => stat.gid)}`,
    `file.size=${readStatField(logFile, (stat) => stat.size)}`,
    `file.ctimeMtimeGapMs=${readStatField(logFile, (stat) => Math.round(stat.ctimeMs - stat.mtimeMs))}`,
    `dir.mode=${readStatField(dir, (stat) => formatMode(stat.mode))}`,
    `dir.uid=${readStatField(dir, (stat) => stat.uid)}`,
    `dir.gid=${readStatField(dir, (stat) => stat.gid)}`,
    `process.uid=${readProcessField(() => (typeof process.getuid === "function" ? process.getuid() : null))}`,
    `process.gid=${readProcessField(() => (typeof process.getgid === "function" ? process.getgid() : null))}`
  ];

  try {
    process.stderr.write(`${parts.join("; ")}\n`);
  } catch {
    // Diagnostics must never interfere with the task path.
  }
}

export function __setAppendFileSyncForTest(fn) {
  appendFileSyncImpl = fn;
}

export function __resetAppendFileSyncForTest() {
  appendFileSyncImpl = fs.appendFileSync;
}

export function __resetCircuitBreakerForTest() {
  appendCircuitOpenByLogFile.clear();
}

export function safeAppendFileSync(logFile, content) {
  const resolvedLogFile = path.resolve(String(logFile ?? ""));
  if (appendCircuitOpenByLogFile.has(resolvedLogFile)) {
    return { ok: false, attempts: 0, error: null, circuitOpen: true };
  }

  let attempts = 0;
  let lastError = null;
  while (attempts < 3) {
    attempts += 1;
    try {
      appendFileSyncImpl(resolvedLogFile, content, "utf8");
      return { ok: true, attempts, error: null, circuitOpen: false };
    } catch (error) {
      lastError = normalizeAppendError(error);
      if (!isTransientAppendError(lastError) || attempts >= 3) {
        emitAppendFailureDiagnostic(resolvedLogFile, attempts, lastError);
        appendCircuitOpenByLogFile.set(resolvedLogFile, true);
        return { ok: false, attempts, error: lastError, circuitOpen: false };
      }
      sleepSync(APPEND_RETRY_DELAYS_MS[attempts - 1] ?? 0);
    }
  }

  emitAppendFailureDiagnostic(resolvedLogFile, attempts, lastError);
  appendCircuitOpenByLogFile.set(resolvedLogFile, true);
  return { ok: false, attempts, error: lastError, circuitOpen: false };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  safeAppendFileSync(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  safeAppendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastProgressUpdateMs = Number.NEGATIVE_INFINITY;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;
    const currentMs = Date.now();

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (currentMs - lastProgressUpdateMs >= PROGRESS_UPDATE_THROTTLE_MS) {
      lastProgressUpdateMs = currentMs;
      patch.progressUpdatedAt = nowIso();
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  let runningRecord = null;
  let aborted = null;
  let abortedLogFile = null;

  withJobLock(job.workspaceRoot, job.id, (revalidateLock) => {
    const jobFile = resolveJobFile(job.workspaceRoot, job.id);
    let existing = null;
    try {
      existing = readJobFile(jobFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) {
      const terminalStatus = existing.status;
      aborted = {
        aborted: true,
        terminalStatus,
        reason: "terminal-record-observed-on-initial-transition",
        job: existing,
        exitStatus: 0,
        threadId: null,
        turnId: null,
        payload: {
          aborted: true,
          terminalStatus,
          reason: "terminal-record-observed-on-initial-transition",
          job: existing
        },
        rendered: `Cannot start: a job for this id is already terminal (${terminalStatus}).\n`,
        summary: "Worker aborted: record was already terminal."
      };
      abortedLogFile = options.logFile ?? existing.logFile ?? job.logFile ?? null;
      return;
    }

    const baseRecord = existing ?? job;
    const timestamp = nowIso();
    const progressTimeoutMs = resolveProgressTimeoutMs();
    runningRecord = {
      ...baseRecord,
      id: job.id,
      status: "running",
      phase: "starting",
      pid: process.pid,
      pidStartTime: readPidStartTime(process.pid),
      pidStartedAtMs: Date.now(),
      startedAt: timestamp,
      progressUpdatedAt: timestamp,
      progressTimeoutMs,
      updatedAt: timestamp,
      logFile: options.logFile ?? baseRecord.logFile ?? job.logFile ?? null
    };
    writeJobFileUnlocked(job.workspaceRoot, job.id, runningRecord, { beforeRename: revalidateLock });
  });

  if (aborted) {
    try {
      appendLogLine(
        abortedLogFile,
        `Worker aborted: record was already terminal (${aborted.terminalStatus}) when worker tried to take over.`
      );
    } catch {
      // Best-effort breadcrumb only.
    }
    return aborted;
  }

  try {
    const execution = await runner();
    const noOp = execution?.noOp === true;
    const completionStatus = execution.exitStatus === 0 && !noOp ? "completed" : "failed";
    const completedAt = nowIso();
    upsertJob(job.workspaceRoot, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      staleness: null,
      progressUpdatedAt: null,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
      ...(noOp ? { noOp: true, errorMessage: "Codex completed with no output and no changes." } : {})
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    upsertJob(job.workspaceRoot, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      staleness: null,
      progressUpdatedAt: null,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    throw error;
  }
}
