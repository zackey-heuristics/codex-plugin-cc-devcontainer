# ADR 0006: Stale Codex job detection, surfacing, and reaping

## Status

Proposed — 2026-06-02.

Linked issue: <https://github.com/zackey-heuristics/codex-plugin-cc-devcontainer/issues/11>

Extends [ADR 0005](0005-pid-liveness-and-no-op-detection.md) by closing a
class of stale-record symptoms that PID liveness alone cannot detect: an
active worker whose PID is verifiably alive but whose Codex turn has
silently wedged, exceeded its useful budget, or stopped producing progress.
ADR 0005's reconciliation keeps such records `running` indefinitely
(identity verifies; no ESRCH), so they keep consuming the limited active-job
capacity until manual `/codex:cancel`.

## Context

After [ADR 0005](0005-pid-liveness-and-no-op-detection.md) landed,
operators continued to hit `"Task X is still running"` on new launches —
this time against records whose worker process was still alive but whose
work was effectively dead:

1. **Wedged Codex turn.** The app-server stops emitting `turn/progress`
   events (network stall, model timeout, backend incident). The worker
   sits in `await` indefinitely. PID identity verifies; `getPidStatus`
   reports alive. Reconciliation leaves the record `running` forever.

2. **Forgotten review job.** A `/codex:review` started 4 hours ago.
   Reviewer aborted the terminal; the worker is technically still alive
   but no operator is consuming its output. The job slot is gone.

3. **Background queue saturation.** `MAX_JOBS = 50`; a workspace where
   a handful of long-running review/task records accumulate hits the
   ceiling. New launches fail with `"no rollout found"` because the
   slot is occupied by something nobody can reason about from
   `/codex:status` alone.

The naïve fix — "kill anything older than N minutes" — is unsafe for the
same reason ADR 0005's "kill anything whose PID stopped responding" was
unsafe in isolation: legitimate long-running review work and intentionally
deep `--effort xhigh` task runs would be terminated mid-flight. What we
actually need is:

- A bounded **classification** of "this job is no longer making
  progress" that is distinguishable from "this job is still working".
- A way to **surface** stale jobs in `/codex:status` so operators can
  decide.
- A discoverable **bulk-cancel** path so a workspace that hit the ceiling
  can be unblocked without per-id incantations.
- **Automatic reaping** on session lifecycle so a fresh Claude Code
  session does not start by inheriting yesterday's blocked capacity.

## Decision

Five scopes, layered on top of ADR 0005's identity-checked reconciliation
machinery. No new storage paradigm, no detached daemons, no new
dependencies.

### A. TTL + progress-timeout staleness classification

A new `staleness` sub-field is written onto `jobs/{id}.json` for records
that are still active (`running` / `queued` / `verifying`) but have
crossed at least one of two thresholds:

- **TTL exceeded.** The wall-clock age of the record exceeds one of two
  per-kind budgets:
  - `STALE_TTL_TASK_MS` — default `3_600_000` (1 h). Applies to `task`
    and `rescue` kinds.
  - `STALE_TTL_REVIEW_MS` — default `900_000` (15 min). Applies to
    `review` and `adversarial-review` kinds.
- **Progress stalled.** The job has not emitted a progress signal for
  longer than `PROGRESS_TIMEOUT_MS` — default `300_000` (5 min). See
  scope B for how that signal is written.

Both thresholds are overridable per workspace via env vars of the same
name; each resolver validates the value strictly (positive integer
milliseconds) and surfaces a one-time per-process stderr warning on
invalid input (`__resetEnvVarWarningsForTest` exposes a dedupe-reset hook
for the test suite).

Classification lives in `applyStalenessUnderLock(workspaceRoot, jobId,
classificationSnapshot)`:

- Re-reads the on-disk record under the per-job lock and aborts if the
  record is already terminal or if its `(pid, pidStartTime)` identity
  changed since classification — same TOCTOU defence as ADR 0005's
  reconciliation.
- Computes a canonical-ordered reason list against
  `STALE_REASONS_CANONICAL_ORDER = ["ttl-exceeded", "progress-stalled"]`
  so the rendered output is deterministic.
- Idempotent — a no-op write when the computed reasons equal the
  already-stored ones.
- Writes the result as a `staleness: { reasons, classifiedAt }` field
  alongside the existing job fields, without disturbing the
  ADR 0005 identity contract.

Every terminal transition clears `staleness` (and `progressUpdatedAt`,
see scope B) — covered by `preserveTerminalJob`, `upsertJob`, and
`deleteSessionJobs`. Stale tagging never persists past the moment a
record becomes terminal.

`reconcileStaleActiveJobs(cwd)` (introduced in ADR 0005 with the
shape `{ reconciledIds, warnings }`) is extended to return
`{ reconciledIds, warnings, staleIds }`. Dead records still terminalize
exactly as in ADR 0005; the new `staleIds` array names records that
are stale-but-alive. The dead path takes precedence — a dead record is
never reported as merely stale.

### B. Progress heartbeat

`runTrackedJob` writes a `progressUpdatedAt` ISO timestamp onto the job
record at start, and the in-process progress updater
(`createJobProgressUpdater`) refreshes the field every
`PROGRESS_UPDATE_THROTTLE_MS = 5_000` while the job emits Codex turn
events. The throttle bounds disk write amplification: a chatty Codex
turn that emits hundreds of progress events per minute generates at
most twelve `jobs/{id}.json` rewrites per minute on this account.

The field is `null` on terminal transitions (paired with `staleness`
clearing in scope A). A `null` value means "no heartbeat ever recorded"
(typically a freshly queued record whose worker has not started) — the
TTL path still applies; the progress-stalled path is suppressed.

`runTrackedJob` also stamps `progressTimeoutMs` onto the active record
so the classification snapshot in scope A does not need to re-resolve
the env var per scan iteration; tests can inject a custom
`progressTimeoutMs` per fixture without touching `process.env`.

### C. Surfacing in `/codex:status`

`render.mjs` gains a `STALE_REASON_LABELS` allow-list (one human-readable
label per canonical reason) so unknown reasons render as `null` rather
than echoing arbitrary `String(reason)` into the operator's terminal —
defence against any future reason value flowing in from outside the
canonical list.

The Active jobs table grows an inline `Stale` column that renders the
sorted canonical reasons for the row (or empty when not stale). A
`Stale jobs: N (see rows)` summary line counts **visible** rows only —
not all stale jobs workspace-wide — so the rendered count matches what
the operator sees in front of them.

`buildStatusSnapshot` / `buildSingleJobSnapshot` / `resolveResultJob`
each receive their `staleIds` from `reconcileStaleActiveJobs` and pass
them through scoped filters:

- `filterStaleIdsForJobs(snapshotJobs, staleIds)` for the list snapshot.
- `filterStaleIdsForSelectedJob(jobId, staleIds)` for single-job and
  result snapshots.

This scoping closes a workspace-wide `--json` leak: without it, a
single-job `/codex:status JOBID --json` could include stale ids from
unrelated sessions, breaking caller assumptions about the JSON
schema's per-snapshot scoping.

### D. `cancel --all-stale` workspace-wide sweep

`codex-companion.mjs cancel` accepts a new `--all-stale` flag (mutually
exclusive with a job-id argument) and an optional `--force`. The
implementation extracts a `cancelOneStaleJob(workspaceRoot, jobId, opts)`
helper from the existing single-id `handleCancel` so single-job and
batch paths share identical safety semantics. The batch path's source
of truth is `reconcileStaleActiveJobs().staleIds` — there is no
parallel "stale list" that could disagree with the rendered status.

Cancellation is structured as a two-phase tombstone (`commitCancelTombstoneUnderLock`
in `state.mjs`) to close the TOCTOU race that an inline
"validate-then-signal" sequence would leave open:

1. **Phase 1 (under lock).** Revalidate that the record is still
   active and still stale; verify identity; record the cancellation
   commitment (the tombstone). Release the lock. Returns
   `{ signalRequired, pid, pidStartTime }`.
2. **Phase 2 (no lock).** If phase 1 said `signalRequired`, race a
   bounded interrupt of the app-server turn against
   `CODEX_PLUGIN_CANCEL_INTERRUPT_TIMEOUT_MS` (default `5_000`), then
   reclassify `pid` / `pidStartTime` immediately before
   `terminateProcessTree` so PID reuse during the interrupt window
   cannot cause us to signal an unrelated process.

The interrupt race is essential because `interruptAppServerTurn` has
no built-in timeout: a wedged app-server would deadlock the batch
otherwise. The batch path uses a *disposable* app-server client per
job so a stuck client cannot poison the next job, and on timeout the
client is `forceDestroy()`ed — SIGTERM, destroy all child stdio,
unref the child, synchronous SIGKILL before `proc.unref()` — to
guarantee event-loop quiescence even if the spawned `app-server`
traps SIGTERM. The shared broker process is *never* killed by
`forceDestroy`; only disposable spawned clients are.

Unverifiable identities (no `pidStartTime`, `/proc` unreadable, etc.)
are *skipped* by default in batch mode (`{ pid preserved, no signal }`),
diverging from the single-cancel path which always attempts an
interrupt. `--force` overrides the skip and signals the recorded PID
without identity verification — matched against the single-cancel
`--force` semantics from ADR 0005.

Per-job errors are collected into a `errors[]` array; the rendered
batch summary lists them, and `process.exitCode = 1` if any job
errored — so a CI caller can tell "this batch had failures" without
parsing the output.

This scope intentionally rejected two alternatives:

- **"Extend the per-job lock through the SIGTERM."** `interruptAppServerTurn`
  and `terminateProcessTree` have no timeouts; holding the lock past
  them risks unbounded lock-hold, and the lock becomes stealable at
  60 s — starving the worker, status, and reconcile paths instead.
- **"Force-destroy by closing the broker socket."** The shared broker
  serves all sessions in the workspace; killing it would terminate
  unrelated active jobs. Only the disposable per-job client is torn
  down.

### E. SessionStart reaping with nonblocking lock acquisition

`plugins/codex/scripts/session-lifecycle-hook.mjs` `handleSessionStart`
now resolves the workspace cwd and calls `reconcileStaleActiveJobs(cwd,
{ nonblocking: true })` inside a try/catch. Three concise stderr lines
surface the result (matching the existing `[codex-companion] session-end:`
format):

- `reaped N dead/stale jobs (id1, id2, ...)` when ADR 0005-style dead
  records were terminalized.
- `tagged N stale jobs (run /codex:cancel --all-stale to clear)` when
  scope A tagged live-but-stuck records.
- `reconcile warning: <id> <reason>: <message>` per warning. The new
  `reconcile-skipped` reason (see below) is rendered through this
  same line.

Reconcile failure is **always** swallowed — SessionStart must never
block Claude Code from starting a session. The existing env-var
append happens *before* the reconcile try block so a thrown reconcile
does not bypass it.

`handleSessionStart` is exported and accepts a 2-arg form
`(input, reconcileActiveJobs = reconcileStaleActiveJobs)` so tests
can inject a stub thrower without spawning a subprocess. `main()`
is gated behind a self-exec guard
(`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`)
so importing the module from a test does not trigger CLI dispatch.

**Why nonblocking.** The hook command in `plugins/codex/hooks/hooks.json`
has `timeout: 5` (seconds). `withJobLock`'s default retry budget is
`200 × 25ms = 5_000 ms`; a single contended job lock can therefore
spend the entire hook budget waiting, get killed by the runner (exit
124), and accomplish nothing — recreating the very capacity-blocking
symptom this ADR exists to prevent. A nonblocking lock-acquisition
mode short-circuits live contention: the job is left untouched and a
`reconcile-skipped` warning surfaces. The 60-second stale-lock
takeover path (an existing safety from ADR 0005) is *not* affected —
stale-owner locks are still reclaimed so SessionStart can reap dead
workers whose lock files were never released.

Concretely:

- `withJobLock(cwd, jobId, fn, { nonblocking: true })` throws a new
  `JobLockUnavailableError` immediately when the lock is currently
  held by a live owner. `JobLockTimeoutError` (default-path expiry
  after the full retry budget) is kept as a distinct class so
  callers can distinguish "busy, try later" from "wait expired".
- `applyStalenessUnderLock` forwards a `nonblocking` option to its
  inner `withJobLock`.
- `reconcileStaleActiveJobs(cwd, { nonblocking })` propagates the
  option to both its dead-record cancel path and its live-record
  staleness-tagging path. On `JobLockUnavailableError` from either,
  it pushes a `reconcile-skipped` warning naming the job and
  continues to the next record without incrementing `reconciledIds`
  or `staleIds`.

Every other call site of `withJobLock`, `applyStalenessUnderLock`,
and `reconcileStaleActiveJobs` continues to use the default blocking
behavior — none of them is competing with a 5-second hook timeout.

## Consequences

**Positive.**

- Stale jobs are surfaced (scope C), bulk-cancellable (scope D), and
  auto-reaped on each new session (scope E) without operator
  intervention.
- TTL + progress-timeout together catch both "this job has been
  running forever" (TTL) and "this job is wedged mid-flight"
  (progress-stalled) — overlapping coverage, only one reason needed
  to fire.
- The `staleness` field is purely additive on the on-disk schema;
  pre-existing terminalisation rules from ADR 0005 (clear on
  terminal) keep it bounded.
- The nonblocking lock mode (scope E) gives the SessionStart hook a
  bounded budget without changing the default blocking semantics any
  other path depends on. Identity-aware reaping from ADR 0005 still
  fires on every dead record whose lock is free.
- `cancel --all-stale` shares safety code with single-cancel via
  `cancelOneStaleJob`, so a future change to identity-aware signal
  semantics propagates to both paths automatically.

**Negative / trade-offs.**

- A burst of contended locks during SessionStart will be *skipped*
  rather than waited for; the affected jobs stay active until the
  *next* SessionStart, an explicit `/codex:status`, or a manual
  `/codex:cancel --all-stale`. The corresponding `reconcile-skipped`
  warning makes this visible. In exchange the hook never kills the
  Claude Code startup path.
- A wedged Codex turn whose record is `verifying` or `queued` (i.e.
  the worker truly is alive and looks correct from the OS's
  perspective) only becomes stale after `PROGRESS_TIMEOUT_MS` or
  `STALE_TTL_*` — there is no instantaneous detection. The default
  budgets bias toward false negatives over false positives;
  operators can shorten them per workspace via env vars.
- `cancel --all-stale` uses a per-job *disposable* app-server client,
  which adds spawn overhead vs. reusing the broker. The trade-off is
  intentional: a stuck batch client cannot poison the next job, and
  `forceDestroy` is bounded.
- `JobLockUnavailableError` adds a new error class that future
  callers must consider. The default `withJobLock` path does not
  throw it, so existing call sites are unaffected; new opt-in
  callers must handle it explicitly.

**Out of scope (deferred follow-ups).**

- A continuously-running reaper (cron / systemd / detached daemon)
  would catch stalls between SessionStart events. Not pursued — the
  current SessionStart-plus-snapshot cadence is sufficient for the
  capacity-blocking class of symptom this ADR addresses, and a
  long-lived process introduces lifecycle and supervision concerns
  this plugin does not currently take on.
- Promoting `--all-stale` into the rendered `Stale: N` summary line
  as a tappable hint (`run /codex:cancel --all-stale` etc.) was
  considered for `render.mjs`; rejected to keep the table compact.
  The SessionStart stderr line carries the same hint.
- Sub-classifying `progress-stalled` into "no events ever" vs "events
  stopped" is a single boolean away, but no caller distinguishes
  them today — left for the first consumer that does.
- Test-harness leak: this work surfaced ~500 stale broker pid files
  in `/tmp/claude-1000/cxc-*/` from prior `tests/runtime.test.mjs`
  runs. Pre-existing; not addressed here. A separate task should
  add cleanup to the test fixture.
