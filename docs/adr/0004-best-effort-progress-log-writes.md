# ADR 0004: Per-task progress-log writes are best-effort

## Status

Accepted — 2026-05-30.

Linked issue: <https://github.com/zackey-heuristics/codex-plugin-cc-devcontainer/issues/9>

Builds on (and does not weaken) [ADR 0003](0003-jobs-directory-as-source-of-truth.md):
`jobs/{id}.json` remains the strict source of truth for job state. This
ADR only relaxes the `.log` sibling file, which is observability.

## Context

In foreground rescue runs against a workspace on a `virtiofs`-backed
devcontainer mount, a Codex task occasionally failed roughly **180 ms
after `startedAt`** with:

```
EACCES: permission denied, open '/.../jobs/task-<id>.log'
```

Investigation (Issue #9):

- The per-task log file already existed, owned by the same uid as the
  failing process, with `0644` permissions.
- The first `appendFileSync(<log>, "Starting Codex Task.")` had
  succeeded; a *subsequent* `appendFileSync` from a progress callback
  threw `EACCES`.
- The file's `Change` time was 167 ms after the last `Modify` time,
  implying external metadata mutation in the failure window. The
  workload is on a `virtiofs` mount, where transient `EACCES` during
  metadata sync is a documented hazard class.
- Reproduction: 1 in 5 runs in the same session. Not deterministic.

The cost was disproportionate: a single transient observability write
failure aborted the entire Codex task, even though `runner()` itself
was healthy and could have completed.

Two related observations shaped the decision:

1. The log file is *informational duplicate state*. The rendered
   result, summary, and final status are also stored in
   `jobs/{id}.json` via the `rendered`, `result`, `summary`, and
   `status` fields that `runTrackedJob` upserts. `/codex:result`
   reads from the JSON, not the log. So losing one log line — or even
   the whole log content — does not break user-visible workflows; the
   user can still retrieve the task result.
2. Job state writes (`upsertJob` → `writeJobFileExclusive` → atomic
   rename, with per-job lock and terminal-stickiness from ADR 0003)
   are independent of `.log` writes. The fix to the log path does not
   weaken state correctness.

## Decision

Make `appendLogLine` and `appendLogBlock` **best-effort**. A single
transient FS error on the log file must NOT abort the task.

Concretely, in `plugins/codex/scripts/lib/tracked-jobs.mjs`:

1. **`safeAppendFileSync(logFile, content)` helper** wraps
   `fs.appendFileSync` with:
   - On transient error codes (`EACCES`, `EBUSY`, `EAGAIN`, `EPERM`,
     `EMFILE`, `ENFILE`, `EINTR`): up to 3 attempts with cumulative
     synchronous backoff ≤25 ms (5 ms, then 10 ms).
   - On non-transient error codes (anything else, including `ENOENT`,
     `EISDIR`, `EROFS`, and errors with missing/unrecognized `.code`):
     1 attempt, no retry.
   - On any failure, returns `{ ok: false, attempts, error,
     circuitOpen: false }`. **Never throws.**
   - On success, returns `{ ok: true, attempts, error: null,
     circuitOpen: false }`.

2. **Per-file circuit breaker.** A module-level
   `Map<resolvedAbsolutePath, true>` records files whose writes have
   failed. When the circuit is OPEN, `safeAppendFileSync` returns
   immediately with `{ ok: false, attempts: 0, error: null,
   circuitOpen: true }` — no `appendFileSync` call, no `statSync`
   call, no `stderr` write. This bounds the syscall storm under a hot
   progress stream: at most 3 attempts × 1 file × 1 process lifetime,
   not 3 × every progress callback.

3. **One diagnostic stderr line per file per process.** On the first
   failure for a given log file (transient-exhausted OR non-transient),
   `safeAppendFileSync` emits a single `[codex-companion]`-prefixed
   line containing: error code, attempts, `logFile` path, file stat
   (mode/uid/gid/size, `ctime − mtime` gap), directory stat
   (mode/uid/gid), and current process uid/gid. Each field is
   collected with its own try/catch; unreadable fields render as
   `unavailable:<code>`. The `process.stderr.write` call itself is
   wrapped — a failure to print the warning is also swallowed.

4. **`appendLogLine` and `appendLogBlock` keep their public
   signatures and `void` return.** They simply route through
   `safeAppendFileSync`. No caller in the codebase needs to change.

5. **`createJobLogFile` continues to throw** on initial-write failure.
   That is a real "cannot start" condition — softening it would hide
   genuine setup misconfiguration.

6. **Test-injection contract.** `__setAppendFileSyncForTest(fn)`,
   `__resetAppendFileSyncForTest()`, and
   `__resetCircuitBreakerForTest()` are exported. They are the ONLY
   mechanism for tests to inject failure. The public helpers do NOT
   take an extra "injected appendFileSync" parameter — `chmod`-based
   EACCES simulation was rejected because the helper is synchronous
   (all retries and synchronous backoff run before any microtask can
   fire) and would not be portable.

## Consequences

**Positive**

- A single transient `EACCES` on a progress-log append no longer
  aborts the task. The user-visible symptom of Issue #9 is gone.
- Other transient FS conditions on virtio/overlay file systems
  (`EBUSY`, `EAGAIN`, `EPERM`, `EMFILE`, `ENFILE`, `EINTR`) are
  similarly absorbed.
- The retry budget is bounded: per-file, per-lifetime. A persistently
  broken log file cannot turn into a per-callback retry storm.
- All diagnostic stat syscalls are field-wrapped and best-effort, so
  a log file that is removed or made unstatable between the failed
  append and the warning still produces a `unavailable:<code>`-marked
  warning rather than throwing.
- State correctness invariants from ADR 0003 are untouched:
  `jobs/{id}.json` writes still go through `upsertJob` → per-job lock
  → atomic rename → terminal-stickiness. `/codex:status` and
  `/codex:result` remain authoritative.

**Negative / trade-offs**

- **Persistent log failures silently drop log content after the
  one-time warning.** Once the circuit is OPEN for a file, all later
  appends short-circuit for the lifetime of the process. This is an
  intentional choice: the alternative (per-callback retry) would
  trade observability for task latency under a stuck FS, and a
  cooldown / half-open scheme would add code without changing the
  outcome — the data we'd recover (log lines) is duplicated in
  `jobs/{id}.json` (`summary`, `result`, `rendered`), which is the
  authoritative store. We pay a log-completeness cost; we do not pay
  a user-data cost.
- **Background-task diagnostics may go unread.** Background tasks
  spawned via `spawnDetachedTaskWorker` use `stdio: "ignore"` for the
  child. The one-time stderr warning for a failed log file in a
  background task is not surfaced anywhere a human can easily see it
  unless the operator looks at logs of the parent shell that
  attached to the broker. This is a property of the existing
  background model, not of this change; we mention it so the next
  reader is not surprised.
- **The transient-code list includes `EPERM`.** On Linux, an `EPERM`
  on `appendFileSync` typically indicates a permanent ownership/
  policy mismatch, not a transient condition. We include it because
  virtiofs has been observed to return `EPERM` transiently during
  metadata sync — losing one log line is preferable to crashing the
  task when this happens. The circuit then immediately opens, so a
  truly persistent `EPERM` does not cause more than 1 failing
  syscall per log file.
- **Test isolation requires `__resetCircuitBreakerForTest()` and
  `__resetAppendFileSyncForTest()` in `beforeEach`/`afterEach`.** This
  is documented in the test file and exercised in every test, but it
  is a small new cost on the test side.

**Follow-ups (out of scope for this ADR)**

- Whether session-end (`handleSessionEnd` →
  `cleanupSessionJobs` → `deleteSessionJobs`) can race with an
  in-flight task of the same sessionId and remove its log file
  underneath it. Issue #9's evidence does not point at this race
  (the log file was still on disk at investigation time), and the
  best-effort path already absorbs a deleted log file via the
  non-transient ENOENT branch.
- Hardening `createJobLogFile` initial-write errors with richer stat
  diagnostics. The current error is sufficient because that path is
  a real "cannot start" condition; future investigation can revisit
  if it occurs in practice.
- Migrating from per-line `appendFileSync` to a held file descriptor.
  This would amortize the open cost but introduces fd-lifecycle
  complexity (crash leaks, log rotation hand-off). Not justified by
  current evidence.
