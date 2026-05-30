import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
export const MAX_RECENT_REVIEW_JOBS = 500;
const RECENT_REVIEW_RETENTION_MS = 65 * 60_000;
const ACTIVE_JOB_MISSING_PID_GRACE_MS = 30_000;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_STICKY_FIELDS = [
  "phase",
  "completedAt",
  "cancelledAt",
  "errorMessage",
  "result",
  "rendered",
  "pid",
  "pidStartTime",
  "pidStartedAtMs"
];
const JOB_LOCK_RETRY_COUNT = 200;
const JOB_LOCK_RETRY_DELAY_MS = 25;
const JOB_LOCK_INCOMPLETE_STALE_MS = JOB_LOCK_RETRY_COUNT * JOB_LOCK_RETRY_DELAY_MS;
const JOB_LOCK_STALE_MS = 60_000;
const JOB_LOCK_SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

class JobLockTimeoutError extends Error {
  constructor(jobId) {
    super(`Timed out acquiring job lock for ${jobId}.`);
    this.name = "JobLockTimeoutError";
  }
}

class JobLockStolenError extends Error {
  constructor(jobId) {
    super(`Job lock for ${jobId} was stolen before the write could be committed.`);
    this.name = "JobLockStolenError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      reviewSubagentsEnabled: false
    }
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function normalizeState(value) {
  const parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: Number.isInteger(parsed.version) ? parsed.version : STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    }
  };
}

function atomicWriteJsonFile(filePath, value, options = undefined) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    options?.beforeRename?.();
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    removeFileIfExists(tmpFile);
    throw error;
  }
}

function writeFlushedJsonTempFile(filePath, value) {
  const tmpFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  let fd = null;

  try {
    fd = fs.openSync(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return tmpFile;
  } catch (error) {
    if (fd != null) {
      fs.closeSync(fd);
    }
    removeFileIfExists(tmpFile);
    throw error;
  }
}

function writeJobFileExclusive(cwd, job) {
  if (!job || typeof job !== "object") {
    return;
  }

  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, job.id);
  let tmpFile = null;
  try {
    tmpFile = writeFlushedJsonTempFile(jobFile, job);
    fs.linkSync(tmpFile, jobFile);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  } finally {
    removeFileIfExists(tmpFile);
  }
}

function migrateLegacyJobs(cwd, jobs) {
  for (const job of jobs) {
    try {
      writeJobFileExclusive(cwd, job);
    } catch (error) {
      if (isInvalidJobIdError(error)) {
        process.stderr.write(`Skipping legacy job ${JSON.stringify(job?.id ?? null)}: Invalid job id\n`);
        continue;
      }
      throw error;
    }
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return defaultState();
  }

  const state = normalizeState(parsed);
  if (Array.isArray(parsed.jobs)) {
    migrateLegacyJobs(cwd, parsed.jobs);
    atomicWriteJsonFile(stateFile, state);
  }
  return state;
}

function sortJobsByUpdatedDesc(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getTimestampMs(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sortReviewJobsByCreatedDesc(jobs) {
  return [...jobs].sort((left, right) => {
    const leftCreated = getTimestampMs(left?.createdAt) ?? getReviewRetentionTimestampMs(left) ?? 0;
    const rightCreated = getTimestampMs(right?.createdAt) ?? getReviewRetentionTimestampMs(right) ?? 0;
    if (rightCreated !== leftCreated) {
      return rightCreated - leftCreated;
    }

    const leftUpdated = getTimestampMs(left?.updatedAt) ?? leftCreated;
    const rightUpdated = getTimestampMs(right?.updatedAt) ?? rightCreated;
    return rightUpdated - leftUpdated;
  });
}

function isReviewJob(job) {
  return job?.jobClass === "review" || job?.kind === "review" || job?.kind === "adversarial-review";
}

function getReviewRetentionTimestampMs(job) {
  return getTimestampMs(job?.createdAt ?? job?.updatedAt);
}

function pruneJobs(jobs) {
  const nowMs = Date.now();
  const recentReviewCutoff = nowMs - RECENT_REVIEW_RETENTION_MS;
  const recentReview = [];
  const rest = [];

  for (const job of jobs) {
    const createdMs = getReviewRetentionTimestampMs(job);
    if (isReviewJob(job) && createdMs != null && createdMs >= recentReviewCutoff && createdMs <= nowMs) {
      recentReview.push(job);
    } else {
      rest.push(job);
    }
  }

  const retainedRecentReview =
    recentReview.length > MAX_RECENT_REVIEW_JOBS
      ? sortReviewJobsByCreatedDesc(recentReview).slice(0, MAX_RECENT_REVIEW_JOBS)
      : recentReview;
  const retainedById = new Map();
  for (const job of [...retainedRecentReview, ...sortJobsByUpdatedDesc(rest).slice(0, MAX_JOBS)]) {
    if (!retainedById.has(job.id)) {
      retainedById.set(job.id, job);
    }
  }

  return sortJobsByUpdatedDesc([...retainedById.values()]);
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(JOB_LOCK_SLEEP_VIEW, 0, 0, ms);
}

function createJobLockToken() {
  return `${process.pid}.${process.hrtime.bigint().toString(36)}.${randomBytes(8).toString("hex")}`;
}

function readProcessUid(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^Uid:\s+(\d+)/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function readPidStartTime(pid) {
  if (process.platform !== "linux") {
    return null;
  }

  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return null;
  }

  try {
    const stat = fs.readFileSync(`/proc/${numericPid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd === -1) {
      return null;
    }

    const fieldsAfterComm = stat.slice(commEnd + 1).split(/\s+/);
    return fieldsAfterComm[20] || null;
  } catch {
    return null;
  }
}

export function getPidStatus(pid) {
  try {
    process.kill(pid, 0);
    return { exists: true, permissionDenied: false, sameUser: true };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { exists: false, permissionDenied: false, sameUser: false };
    }

    if (error?.code === "EPERM") {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
      const ownerUid = currentUid == null ? null : readProcessUid(pid);
      return {
        exists: true,
        permissionDenied: true,
        sameUser: ownerUid == null || currentUid == null ? null : ownerUid === currentUid
      };
    }

    return { exists: true, permissionDenied: false, sameUser: false };
  }
}

function isLockFileOlderThan(lockPath, ageMs) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > ageMs;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function readJobLockSnapshot(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    try {
      const lock = JSON.parse(raw);
      return { exists: true, parsed: true, raw, lock };
    } catch {
      return { exists: true, parsed: false, raw, lock: null };
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, parsed: false, raw: "", lock: null };
    }
    throw error;
  }
}

function getStaleJobLockSnapshot(lockPath) {
  const snapshot = readJobLockSnapshot(lockPath);
  if (!snapshot.exists) {
    return { ...snapshot, stale: true };
  }
  if (!snapshot.parsed) {
    return { ...snapshot, stale: isLockFileOlderThan(lockPath, JOB_LOCK_INCOMPLETE_STALE_MS) };
  }

  const lock = snapshot.lock;
  const acquiredAtMs = Date.parse(lock?.acquiredAt ?? "");
  // An alive process with a parsed lock older than 60s is stale by design to recover from hung owners.
  const isOld = Number.isFinite(acquiredAtMs) && Date.now() - acquiredAtMs > JOB_LOCK_STALE_MS;
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ...snapshot, stale: true };
  }

  const pidStatus = getPidStatus(pid);
  return {
    ...snapshot,
    stale: isOld || !pidStatus.exists || (pidStatus.permissionDenied && pidStatus.sameUser === false)
  };
}

function isStaleJobLock(lockPath) {
  return getStaleJobLockSnapshot(lockPath).stale;
}

function jobLockSnapshotsMatch(left, right) {
  if (left.parsed && right.parsed) {
    return (
      Number(left.lock?.pid) === Number(right.lock?.pid) &&
      left.lock?.acquiredAt === right.lock?.acquiredAt &&
      left.lock?.token === right.lock?.token
    );
  }
  return !left.parsed && !right.parsed && left.raw === right.raw;
}

function restoreRenamedLockFile(sidePath, lockPath) {
  try {
    fs.linkSync(sidePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function stealStaleJobLock(lockPath, staleSnapshot, token) {
  if (!staleSnapshot.exists) {
    return true;
  }

  const sidePath = `${lockPath}.stealing.${token}.${process.hrtime.bigint().toString(36)}`;
  try {
    fs.renameSync(lockPath, sidePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }

  try {
    const renamedSnapshot = readJobLockSnapshot(sidePath);
    if (renamedSnapshot.exists && jobLockSnapshotsMatch(staleSnapshot, renamedSnapshot)) {
      removeFileIfExists(sidePath);
      return true;
    }

    restoreRenamedLockFile(sidePath, lockPath);
    return false;
  } catch (error) {
    restoreRenamedLockFile(sidePath, lockPath);
    throw error;
  }
}

function releaseJobLock(lockPath, token) {
  const snapshot = readJobLockSnapshot(lockPath);
  if (!snapshot.exists || !snapshot.parsed || snapshot.lock?.token !== token) {
    return;
  }

  removeLinkedJobLockSideFiles(lockPath);
  const sidePath = `${lockPath}.releasing.${token}.${process.hrtime.bigint().toString(36)}`;
  try {
    fs.renameSync(lockPath, sidePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    const renamedSnapshot = readJobLockSnapshot(sidePath);
    if (renamedSnapshot.exists && renamedSnapshot.parsed && renamedSnapshot.lock?.token === token) {
      removeFileIfExists(sidePath);
      return;
    }

    restoreRenamedLockFile(sidePath, lockPath);
  } catch (error) {
    restoreRenamedLockFile(sidePath, lockPath);
    throw error;
  }
}

function revalidateJobLock(lockPath, token, jobId) {
  const snapshot = readJobLockSnapshot(lockPath);
  if (!snapshot.exists || !snapshot.parsed || snapshot.lock?.token !== token) {
    throw new JobLockStolenError(jobId);
  }
}

function isJobLockSideFileName(entry) {
  return isJobLockStealingSideFileName(entry) || isJobLockReleasingSideFileName(entry);
}

function isJobLockStealingSideFileName(entry) {
  return /\.lock\.stealing\./.test(entry);
}

function isJobLockReleasingSideFileName(entry) {
  return /\.lock\.releasing\./.test(entry);
}

function filesReferToSameInode(leftPath, rightPath) {
  try {
    const left = fs.statSync(leftPath);
    const right = fs.statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function removeLinkedJobLockSideFiles(lockPath) {
  const jobsDir = path.dirname(lockPath);
  const lockPrefix = `${path.basename(lockPath)}.`;
  let entries = [];
  try {
    entries = fs.readdirSync(jobsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(lockPrefix) || !isJobLockSideFileName(entry)) {
      continue;
    }
    const sidePath = path.join(jobsDir, entry);
    if (filesReferToSameInode(lockPath, sidePath)) {
      removeFileIfExists(sidePath);
    }
  }
}

function hasRecentBlockingJobLockSideFile(lockPath) {
  const jobsDir = path.dirname(lockPath);
  const lockPrefix = `${path.basename(lockPath)}.`;
  let entries = [];
  try {
    entries = fs.readdirSync(jobsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(lockPrefix) || !isJobLockSideFileName(entry)) {
      continue;
    }
    try {
      const sidePath = path.join(jobsDir, entry);
      if (filesReferToSameInode(lockPath, sidePath)) {
        continue;
      }
      if (isJobLockReleasingSideFileName(entry)) {
        removeFileIfExists(sidePath);
        continue;
      }
      if (Date.now() - fs.statSync(sidePath).mtimeMs <= JOB_LOCK_STALE_MS) {
        return true;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

function cleanupStaleJobLockSideFiles(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(jobsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!isJobLockSideFileName(entry)) {
      continue;
    }
    const sidePath = path.join(jobsDir, entry);
    try {
      if (Date.now() - fs.statSync(sidePath).mtimeMs > JOB_LOCK_STALE_MS) {
        removeFileIfExists(sidePath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function publishJobLock(lockPath, token) {
  const lock = { pid: process.pid, acquiredAt: nowIso(), token };
  let tmpFile = null;

  try {
    tmpFile = writeFlushedJsonTempFile(lockPath, lock);
    try {
      fs.linkSync(tmpFile, lockPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }

    const snapshot = readJobLockSnapshot(lockPath);
    if (!snapshot.parsed || snapshot.lock?.token !== token) {
      releaseJobLock(lockPath, token);
      throw new Error(`Failed to verify job lock for ${path.basename(lockPath, ".lock")}.`);
    }

    if (hasRecentBlockingJobLockSideFile(lockPath)) {
      releaseJobLock(lockPath, token);
      return false;
    }

    return true;
  } finally {
    removeFileIfExists(tmpFile);
  }
}

function acquireJobLock(cwd, jobId) {
  const lockPath = resolveJobLockFile(cwd, jobId);
  const token = createJobLockToken();
  let attempts = 0;

  for (;;) {
    try {
      if (!hasRecentBlockingJobLockSideFile(lockPath) && publishJobLock(lockPath, token)) {
        return { lockPath, token };
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    if (attempts >= JOB_LOCK_RETRY_COUNT) {
      const staleSnapshot = getStaleJobLockSnapshot(lockPath);
      if (staleSnapshot.stale && !hasRecentBlockingJobLockSideFile(lockPath)) {
        stealStaleJobLock(lockPath, staleSnapshot, token);
        attempts = 0;
        continue;
      }
      throw new JobLockTimeoutError(jobId);
    }

    attempts += 1;
    sleepSync(JOB_LOCK_RETRY_DELAY_MS);
  }
}

export function withJobLock(cwd, jobId, fn) {
  // Per-job lock serializes cross-process read/write and prune/delete critical sections.
  const { lockPath, token } = acquireJobLock(cwd, jobId);
  try {
    return fn(() => revalidateJobLock(lockPath, token, jobId));
  } finally {
    releaseJobLock(lockPath, token);
  }
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(status);
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function preserveTerminalJob(existing, nextJob) {
  const preserved = {
    ...nextJob,
    status: existing.status
  };

  for (const field of TERMINAL_STICKY_FIELDS) {
    if (hasOwn(existing, field)) {
      preserved[field] = existing[field];
    } else {
      delete preserved[field];
    }
  }

  return preserved;
}

function isPathInDirectory(parentDir, candidatePath) {
  if (!candidatePath) {
    return false;
  }

  const relative = path.relative(parentDir, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertSafeJobId(jobId) {
  if (
    typeof jobId !== "string" ||
    jobId === "." ||
    jobId === ".." ||
    jobId.includes("/") ||
    jobId.includes("\\") ||
    !SAFE_JOB_ID_PATTERN.test(jobId)
  ) {
    throw new Error("Invalid job id");
  }
  return jobId;
}

function isInvalidJobIdError(error) {
  return error instanceof Error && error.message === "Invalid job id";
}

function resolveJobPath(cwd, jobId, extension) {
  const safeJobId = assertSafeJobId(jobId);
  ensureStateDir(cwd);
  const jobsDir = resolveJobsDir(cwd);
  const jobPath = path.join(jobsDir, `${safeJobId}${extension}`);
  if (!isPathInDirectory(path.resolve(jobsDir), path.resolve(jobPath))) {
    throw new Error("Invalid job id");
  }
  return jobPath;
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state?.config ?? {})
    }
  };

  atomicWriteJsonFile(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  if (!jobPatch || !hasOwn(jobPatch, "id")) {
    throw new Error("Cannot upsert a job without an id.");
  }
  assertSafeJobId(jobPatch.id);

  ensureStateDir(cwd);
  const nextJob = withJobLock(cwd, jobPatch.id, (revalidateLock) => {
    const timestamp = nowIso();
    const jobFile = resolveJobFile(cwd, jobPatch.id);
    let existing = null;
    try {
      existing = readJobFile(jobFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    let mergedJob = existing
      ? {
          ...existing,
          ...jobPatch,
          createdAt: existing.createdAt ?? jobPatch.createdAt ?? timestamp,
          updatedAt: timestamp
        }
      : {
          createdAt: timestamp,
          updatedAt: timestamp,
          ...jobPatch
        };
    if (existing && isTerminalJobStatus(existing.status)) {
      mergedJob = preserveTerminalJob(existing, mergedJob);
    }

    writeJobFileUnlocked(cwd, jobPatch.id, mergedJob, { beforeRename: revalidateLock });
    return mergedJob;
  });
  pruneJobsOnDisk(cwd);
  return nextJob;
}

export function listJobs(cwd) {
  loadState(cwd);
  const jobsDir = resolveJobsDir(cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(jobsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    try {
      const parsed = readJobFile(path.join(jobsDir, entry));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        jobs.push(parsed);
      }
    } catch {
      // Ignore partially-written, corrupt, or unreadable job files.
    }
  }

  return sortJobsByUpdatedDesc(jobs);
}

function normalizePid(pid) {
  const numericPid = Number(pid);
  return Number.isInteger(numericPid) && numericPid > 0 ? numericPid : null;
}

function makeReconcileWarning(jobId, pid, reason, message) {
  return {
    jobId: jobId ?? null,
    pid: pid ?? null,
    reason,
    message
  };
}

function isMissingPidStale(job) {
  const updatedAtMs = Date.parse(job?.updatedAt ?? "");
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > ACTIVE_JOB_MISSING_PID_GRACE_MS;
}

function classifyActiveJobForReconciliation(job) {
  const pid = normalizePid(job?.pid);
  if (pid == null) {
    // The 30s queued-grace only applies to `queued` records (waiting for
    // their worker to take the first lock). A `running` record without a
    // pid is a legacy / unverifiable case: surface a warning but do NOT
    // terminalize on updatedAt age alone.
    if (job?.status !== "queued") {
      return {
        pid: null,
        dead: false,
        warning: makeReconcileWarning(
          job?.id,
          null,
          "legacy-no-identity",
          "Active record has no recorded pid; leaving active state unchanged."
        )
      };
    }
    return {
      pid: null,
      dead: isMissingPidStale(job),
      warning: null
    };
  }

  const pidStatus = getPidStatus(pid);
  if (!pidStatus.exists || (pidStatus.permissionDenied && pidStatus.sameUser === false)) {
    return { pid, dead: true, warning: null };
  }

  if (pidStatus.permissionDenied) {
    return {
      pid,
      dead: false,
      warning: makeReconcileWarning(
        job?.id,
        pid,
        "proc-unreadable",
        "Process exists but cannot be identity-verified due to permission restrictions."
      )
    };
  }

  if (!hasOwn(job, "pidStartTime")) {
    return {
      pid,
      dead: false,
      warning: makeReconcileWarning(
        job?.id,
        pid,
        "legacy-no-identity",
        "Job record has no pidStartTime field; leaving active state unchanged."
      )
    };
  }

  const livePidStartTime = readPidStartTime(pid);
  if (job.pidStartTime == null || livePidStartTime == null) {
    return {
      pid,
      dead: false,
      warning: makeReconcileWarning(
        job?.id,
        pid,
        "proc-unreadable",
        "Process identity cannot be confirmed from pidStartTime; leaving active state unchanged."
      )
    };
  }

  return {
    pid,
    dead: String(job.pidStartTime) !== livePidStartTime,
    warning: null
  };
}

export function reconcileStaleActiveJobs(cwd, options = {}) {
  void options;

  const reconciledIds = [];
  const warnings = [];

  try {
    const jobs = listJobs(cwd);
    for (const job of jobs) {
      if (!isActiveJobStatus(job?.status)) {
        continue;
      }

      try {
        const classification = classifyActiveJobForReconciliation(job);
        if (classification.warning) {
          warnings.push(classification.warning);
        }
        if (!classification.dead) {
          continue;
        }

        withJobLock(cwd, job.id, (revalidateLock) => {
          const jobFile = resolveJobFile(cwd, job.id);
          let currentJob = null;
          try {
            currentJob = readJobFile(jobFile);
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
            return;
          }

          if (currentJob.updatedAt !== job.updatedAt || !isActiveJobStatus(currentJob.status)) {
            return;
          }

          // Re-verify the identity that the out-of-lock classification was
          // based on. If pid or pidStartTime changed between classification
          // and lock acquisition, the record is no longer the one we
          // classified dead — abort to avoid terminalizing a different
          // process identity.
          const sameIdentity =
            (currentJob.pid ?? null) === (job.pid ?? null) &&
            (currentJob.pidStartTime ?? null) === (job.pidStartTime ?? null);
          if (!sameIdentity) {
            return;
          }

          const timestamp = nowIso();
          writeJobFileUnlocked(
            cwd,
            job.id,
            {
              ...currentJob,
              status: "failed",
              phase: "failed",
              pid: null,
              completedAt: timestamp,
              updatedAt: timestamp,
              errorMessage: "Process exited without writing a terminal state."
            },
            { beforeRename: revalidateLock }
          );
          reconciledIds.push(job.id);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(makeReconcileWarning(job?.id ?? null, normalizePid(job?.pid), "reconcile-error", message));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reconciledIds: [],
      warnings: [makeReconcileWarning(null, null, "reconcile-error", message)]
    };
  }

  return { reconciledIds, warnings };
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFileUnlocked(cwd, jobId, payload, options = undefined) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteJsonFile(jobFile, payload, options);
  return jobFile;
}

export function writeJobFileForTest(cwd, jobId, payload) {
  assertSafeJobId(jobId);
  if (payload && typeof payload === "object" && hasOwn(payload, "id")) {
    assertSafeJobId(payload.id);
  }
  // Test-only seeding keeps raw payload fields while still respecting the lock and terminal stickiness.
  return withJobLock(cwd, jobId, (revalidateLock) => {
    const jobFile = resolveJobFile(cwd, jobId);
    let nextPayload = payload;
    try {
      const existing = readJobFile(jobFile);
      if (existing && isTerminalJobStatus(existing.status)) {
        nextPayload = preserveTerminalJob(existing, payload);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    writeJobFileUnlocked(cwd, jobId, nextPayload, { beforeRename: revalidateLock });
    return jobFile;
  });
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  removeFileIfExists(jobFile);
}

function removeJobLogFiles(cwd, job) {
  const stateDir = resolveStateDir(cwd);
  const siblingLogFile = resolveJobLogFile(cwd, job.id);
  removeFileIfExists(siblingLogFile);
  if (job.logFile && job.logFile !== siblingLogFile && isPathInDirectory(stateDir, job.logFile)) {
    removeFileIfExists(job.logFile);
  }
}

export function pruneJobsOnDisk(cwd) {
  cleanupStaleJobLockSideFiles(cwd);
  const jobs = listJobs(cwd);
  const retainedIds = new Set(pruneJobs(jobs).map((job) => job.id));

  for (const job of jobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    if (isActiveJobStatus(job.status)) {
      continue;
    }

    try {
      assertSafeJobId(job.id);
      withJobLock(cwd, job.id, (revalidateLock) => {
        const jobFile = resolveJobFile(cwd, job.id);
        let currentJob = null;
        try {
          currentJob = readJobFile(jobFile);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
          return;
        }
        if (currentJob.updatedAt !== job.updatedAt || isActiveJobStatus(currentJob.status)) {
          return;
        }

        revalidateLock();
        removeJobFile(jobFile);
        removeJobLogFiles(cwd, currentJob);
      });
    } catch (error) {
      if (isInvalidJobIdError(error)) {
        process.stderr.write(`Skipping pruned job ${JSON.stringify(job.id)}: Invalid job id\n`);
        continue;
      }
      if (error instanceof JobLockTimeoutError) {
        continue;
      }
      throw error;
    }
  }
}

export function deleteSessionJobs(cwd, sessionId, options = undefined) {
  if (!sessionId) {
    return [];
  }

  const onMatchUnderLock =
    typeof options?.onMatchUnderLock === "function" ? options.onMatchUnderLock : undefined;
  const jobs = listJobs(cwd);
  const deletedIds = [];

  for (const job of jobs) {
    if (!job?.id || job.sessionId !== sessionId) {
      continue;
    }

    try {
      assertSafeJobId(job.id);
      withJobLock(cwd, job.id, (revalidateLock) => {
        const jobFile = resolveJobFile(cwd, job.id);
        let currentJob = null;
        try {
          currentJob = readJobFile(jobFile);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
          return;
        }

        if (currentJob.sessionId !== sessionId) {
          return;
        }

        if (onMatchUnderLock) {
          try {
            // Runs synchronously under the per-job lock before mutating the matched job.
            onMatchUnderLock(currentJob);
          } catch (error) {
            const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
            process.stderr.write(`Skipping session job ${currentJob.id ?? job.id}: ${detail}\n`);
            return;
          }
        }

        if (isActiveJobStatus(currentJob.status)) {
          const timestamp = nowIso();
          writeJobFileUnlocked(
            cwd,
            job.id,
            {
              ...currentJob,
              status: "cancelled",
              phase: "cancelled",
              pid: null,
              completedAt: timestamp,
              errorMessage: "Cancelled by session end.",
              cancelledAt: timestamp,
              updatedAt: timestamp
            },
            { beforeRename: revalidateLock }
          );
        } else {
          revalidateLock();
          removeJobFile(jobFile);
          removeJobLogFiles(cwd, currentJob);
        }
        deletedIds.push(job.id);
      });
    } catch (error) {
      if (isInvalidJobIdError(error)) {
        process.stderr.write(`Skipping session job ${JSON.stringify(job.id)}: Invalid job id\n`);
        continue;
      }
      if (error instanceof JobLockTimeoutError) {
        continue;
      }
      throw error;
    }
  }

  return deletedIds;
}

export function resolveJobLogFile(cwd, jobId) {
  return resolveJobPath(cwd, jobId, ".log");
}

export function resolveJobFile(cwd, jobId) {
  return resolveJobPath(cwd, jobId, ".json");
}

function resolveJobLockFile(cwd, jobId) {
  return resolveJobPath(cwd, jobId, ".lock");
}
