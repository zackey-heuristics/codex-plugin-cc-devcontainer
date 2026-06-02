#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  deleteSessionJobs,
  identityVerificationSupported,
  JobLockUnavailableError,
  readPidStartTime,
  RECONCILE_WARNING_REASON_RECONCILE_SKIPPED,
  reconcileStaleActiveJobs
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  deleteSessionJobs(workspaceRoot, sessionId, {
    onMatchUnderLock: (job) => {
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        return;
      }
      const storedPid = Number(job.pid);
      const storedPidStartTime = job.pidStartTime ?? null;
      if (!Number.isInteger(storedPid) || storedPid <= 0) {
        // No PID to signal (queued record before the worker took over,
        // or a record that never recorded an identity). Nothing to
        // terminate; return so deleteSessionJobs proceeds to write the
        // cancellation record. A late-starting worker will see the
        // terminal record in its initial-transition pre-check and abort
        // cleanly.
        process.stderr.write(
          `[codex-companion] session-end: no PID to signal for job ${job.id}; will mark cancelled\n`
        );
        return;
      }
      if (!identityVerificationSupported()) {
        process.stderr.write(
          `[codex-companion] session-end: proceeding without identity verification on ${process.platform} for job ${job.id}\n`
        );
        try {
          terminateProcessTree(storedPid);
        } catch {
          // Ignore teardown failures during session shutdown.
        }
        return;
      }
      if (storedPidStartTime == null) {
        // Identity unverifiable — do NOT signal and skip cancellation
        // entirely. The existing deleteSessionJobs contract treats a
        // thrown error as "skip this job".
        process.stderr.write(
          `[codex-companion] session-end: skipped pid termination for job ${job.id} (identity unverifiable)\n`
        );
        throw new Error("session-end identity unverifiable; record left intact");
      }
      const livePidStartTime = readPidStartTime(storedPid);
      if (livePidStartTime == null || String(storedPidStartTime) !== String(livePidStartTime)) {
        process.stderr.write(
          `[codex-companion] session-end: skipped pid termination for job ${job.id} (identity unverifiable)\n`
        );
        throw new Error("session-end identity unverifiable; record left intact");
      }
      try {
        terminateProcessTree(storedPid);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  });
}

function formatIdSummary(ids, maxIds = 3) {
  const visibleIds = ids.slice(0, maxIds).join(", ");
  const hiddenCount = ids.length - maxIds;
  return hiddenCount > 0 ? `${visibleIds} (+${hiddenCount} more)` : visibleIds;
}

function formatReconcileWarning(warning) {
  if (!warning || typeof warning !== "object") {
    return String(warning);
  }
  const prefix = warning.jobId ? `${warning.jobId} ` : "";
  const reason = warning.reason ? `${warning.reason}: ` : "";
  const message = warning.message ?? "unknown warning";
  return `${prefix}${reason}${message}`;
}

export function handleSessionStart(input, reconcileActiveJobs = reconcileStaleActiveJobs) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);

  const cwd = input.cwd || process.cwd();
  try {
    const { reconciledIds = [], warnings = [], staleIds = [] } = reconcileActiveJobs(cwd, { nonblocking: true });
    if (reconciledIds.length > 0) {
      process.stderr.write(
        `[codex-companion] session-start: reaped ${reconciledIds.length} dead/stale jobs (${formatIdSummary(reconciledIds)})\n`
      );
    }
    if (staleIds.length > 0) {
      process.stderr.write(
        `[codex-companion] session-start: tagged ${staleIds.length} stale jobs (run /codex:cancel --all-stale to clear)\n`
      );
    }
    for (const warning of warnings) {
      process.stderr.write(
        `[codex-companion] session-start: reconcile warning: ${formatReconcileWarning(warning)}\n`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JobLockUnavailableError) {
      process.stderr.write(
        `[codex-companion] session-start: reconcile warning: ${formatReconcileWarning({
          jobId: error.jobId ?? null,
          pid: null,
          reason: RECONCILE_WARNING_REASON_RECONCILE_SKIPPED,
          message
        })}\n`
      );
      return;
    }
    process.stderr.write(`[codex-companion] session-start: reconcile failed: ${message}\n`);
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
