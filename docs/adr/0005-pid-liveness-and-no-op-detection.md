# ADR 0005: PID-liveness reconciliation and no-op completion detection

## Status

Accepted — 2026-05-30.

Linked issue: <https://github.com/zackey-heuristics/codex-plugin-cc-devcontainer/issues/10>

Extends [ADR 0003](0003-jobs-directory-as-source-of-truth.md) by closing the
"PID liveness reconciliation" follow-up that ADR 0003 left explicitly out of
scope. Refines [ADR 0004](0004-best-effort-progress-log-writes.md) by
narrowing its "Consequences → Positive" claim about `upsertJob` being the
sole write path — see the [ADR 0004 refinement](#adr-0004-refinement)
subsection below for the bounded inventory of direct-write paths that
coexist with `upsertJob`.

## Context

Three intertwined defects in the `codex:rescue` flow could combine to make
the helper look like it had succeeded while having changed nothing:

1. **Stale active job.** `jobs/{id}.json` could remain in `running` or
   `queued` status when the owning worker process died without writing a
   terminal record. ADR 0003 noted this as an open follow-up: a `SIGKILL`'d
   Codex CLI left a `running` row until the next session-end hook fired,
   and across sessions the row was effectively permanent. Subsequent
   `/codex:status` calls reported a phantom active job; new tasks were
   blocked with `"Task X is still running"`; Codex itself, when threads
   were resumed, saw its own prior turn and hallucinated that the work was
   already underway.

2. **Silent no-op completion.** Codex's app-server can return
   `turn.status === "completed"` with an empty `lastAgentMessage` and
   `touchedFiles.length === 0`. The helper classified this as `exitStatus
   === 0` ("completed"); `renderTaskResult` emitted a one-line `"Codex did
   not return a final message."`. The Sonnet `codex-rescue` agent then
   triggered its "completed but returned no output" heuristic on the
   short/empty stdout and surfaced "Subagent completed but returned no
   output" — looking like success, with nothing actually changed.

3. **Thin conflict diagnostics.** When a new task was blocked by an
   "active" job, the only error text was `"Task X is still running. Use
   /codex:status before continuing it."` — no created-at, no phase, no
   workspace, no cancel/resume guidance. An operator who hit this had no
   easy way to tell whether the blocking job was a live worker or a
   ghost from defect (1).

The naive fix for defect (1) — "is the recorded PID still alive?" — is
unsafe in isolation. PIDs are reused; a same-user process that happens to
land on the recorded PID would keep the stale job marked `running`
indefinitely, and signalling that PID (from `/codex:cancel` or session-end
cleanup) would kill an unrelated process. ADR 0003 called this out
explicitly when it left the reconciliation pass out of scope.

Defects (2) and (3) are independent but compound (1)'s consequences: a
stale `running` row from defect (1) is the most operator-visible artefact
of defect (3)'s thin error text, and defect (2) is what allowed the
underlying failure mode to go unnoticed for as long as it did.

## Decision

Three focused changes inside the existing job-state machinery; no new
storage paradigms, no new long-lived processes.

### A. PID liveness reconciliation, identity-checked

Process identity is recorded at job-start time and verified at
reconciliation time, so PID reuse cannot mask a dead worker as alive nor
let reconciliation terminalize an unrelated same-user process.

**Identity recording.** When `runTrackedJob` transitions a job to
`running`, it writes — inside a single per-job `withJobLock` critical
section, via `writeJobFileUnlocked` (NOT `upsertJob`; see the
[refinement](#adr-0004-refinement) for why):

- `pid: process.pid`
- `pidStartTime: readPidStartTime(process.pid)` — `/proc/<pid>/stat`
  field 22 (kernel boot-time-relative starttime in clock ticks),
  stored as a string. Read once; constant for the process lifetime.
  `null` on non-Linux or where `/proc/self/stat` is unreadable.
- `pidStartedAtMs: Date.now()` — diagnostic only; never consulted by
  reconciliation.

The initial running transition reads + decides + writes in one
critical section. If the on-disk record is already terminal
(`completed`/`failed`/`cancelled`), the worker aborts with
`{ aborted: true, terminalStatus, reason:
"terminal-record-observed-on-initial-transition", job }` and writes
nothing — the terminal record stays byte-identical. Foreground
callers render `renderActiveJobConflict(aborted.job)` and exit 0;
background workers exit 0 silently after a best-effort log
breadcrumb.

**Enqueue ordering.** `enqueueBackgroundTask` writes a durable
queued record with `pid: null` / `pidStartTime: null`, spawns the
worker, and then performs no further writes. Identity is written
exclusively by the worker, atomically, inside the single-lock
initial transition above. If `spawn` throws synchronously, the
parent writes a terminal `failed` record under the per-job lock —
no detached orphan can exist when the on-disk record does not name
it. The trade-off is a bounded **queued startup window** (see
[Consequences](#consequences-1)).

**Identity-aware reconciliation.** A new helper,
`reconcileStaleActiveJobs(cwd)` in `state.mjs`, scans `listJobs(cwd)`
for `running` / `queued` records and classifies each one:

- **Verifiably alive** — `pid` is positive, `process.kill(pid, 0)`
  succeeds, AND `/proc/<pid>/stat` field 22 equals the recorded
  `pidStartTime`. Identity proof. No action.
- **Unverifiable identity** — `pid` is set but identity cannot be
  proved or disproved (Linux `/proc/<pid>/stat` unreadable, modern
  record with `pidStartTime: null`, legacy record with no
  `pidStartTime` field at all, or permission-denied probe with
  `sameUser === false` not provable). Reconciliation surfaces a
  per-job `{ reason: "proc-unreadable" | "legacy-no-identity",
  jobId, pid }` entry in `reconciliationWarnings` and **never
  terminalizes** the record. Such records only change state via the
  worker itself, operator-driven `/codex:cancel`, or an actual ESRCH
  on the recorded PID.
- **Dead** — any of: `pid` missing and `updatedAt` past the 30 s
  queued-grace window (worker was queued but never reached its
  first lock); `getPidStatus(pid).exists === false` (ESRCH); pid
  alive but `pidStartTime` mismatch (definitive PID reuse); pid
  alive but `permissionDenied === true` with `sameUser === false`
  (different user owns the PID — definitive PID reuse).

For each `dead` record, reconciliation acquires the per-job lock,
re-reads the record, re-confirms `updatedAt` AND active-status AND
the same `(pid, pidStartTime)` identity, then writes `status:
"failed"` / `phase: "failed"` / `pid: null` / `completedAt` /
`errorMessage: "Process exited without writing a terminal state."`
via `writeJobFileUnlocked` with `revalidateLock`. ADR 0003's
terminal-stickiness guarantee is preserved: reconciliation never
demotes a terminal status.

Reconciliation is called once at the top of `executeTaskRun`,
`enqueueBackgroundTask`, `buildStatusSnapshot`,
`buildSingleJobSnapshot`, and `resolveResultJob`. Each call is
try/catch-wrapped — reconciliation failure must never prevent a
snapshot/result from rendering or a new task from starting.
Workspace-scoped failures (e.g., `listJobs` throws) surface as a
single `{ jobId: null, pid: null, reason: "reconcile-error",
message }` warning; per-job failures carry their `jobId` and
observed `pid`. The returned shape is uniform across callers:
`{ reconciledIds: string[], warnings: Warning[] }`.

**Cancel and session-end are identity-aware.** Two existing paths
that signalled PIDs from records are tightened:

- **`/codex:cancel`** verifies `pidStartTime` against the live PID
  before calling `terminateProcessTree(job.pid)`. On match, normal
  cancellation. On mismatch, write the `cancelled` record without
  signalling (the original worker is gone) and emit a one-line
  stderr diagnostic. If the process provably does not exist (ESRCH),
  treat it like mismatch: write the `cancelled` record without
  signalling and emit a one-line stderr diagnostic — no `--force`
  required. On unverifiable identity due to permission-denied
  (`/proc` unreadable, same-user unknown), refuse by default with a
  clear error pointing at `--force`; `--force` signals and
  cancels with operator acknowledgement.
- **`deleteSessionJobs`'s `onMatchUnderLock` callback** in
  `session-lifecycle-hook.mjs` performs the same identity check
  before calling `terminateProcessTree`. On match, signal and let
  the existing cancellation path proceed. On mismatch or
  unverifiable identity, **skip both the signal and the
  cancellation write** — the on-disk record stays byte-identical so
  a possibly-live worker stays visible in `/codex:status` and
  `/codex:cancel`, and the operator sees a single `[codex-companion]
  session-end: skipped pid termination for job <id>` stderr line.
  This closes the PID-reuse exposure noted in ADR 0003's
  "Follow-ups" against `deleteSessionJobs`.

The shared principle: trust only verifiable identity for automatic
decisions; surface unverifiable cases as warnings and let the
operator override consciously.

### B. No-op completion detection (write-mode only)

In `executeTaskRun`, after `runAppServerTurn` returns, derive:

```js
const isNoOpRun =
  result.status === 0 &&
  (!rawOutput || rawOutput.trim() === "") &&
  (!Array.isArray(result.touchedFiles) || result.touchedFiles.length === 0);

const treatAsFailure = request.write && isNoOpRun;
```

Command count is **not** part of the gate — Codex may run inspection
commands and still return no useful answer or file change, which is
still the operator-visible failure mode. Command count is included in
the diagnostic (scope C) for context but does not change the
classification.

When `treatAsFailure` is true:

- The helper exits 0 (the rescue agent's `If the Bash call fails,
  return nothing` clause would otherwise re-create the original
  "no output" symptom).
- `noOp: true` is set on both the top-level object returned by
  `executeTaskRun` (read by `runTrackedJob`) AND on `payload.noOp`
  (persisted into `jobs/{id}.json` for `/codex:result` and downstream
  tooling).
- `summary` becomes `"Codex completed with no output and no changes
  (likely no-op)."`.
- `rendered` is the structured diagnostic (scope C).
- `runTrackedJob`'s completion classification becomes:
  `execution.exitStatus === 0 && !execution.noOp ? "completed" :
  "failed"`.

Read-only runs (no `--write`) are unchanged: they may legitimately
return short answers (research, diagnosis) and silently failing those
would be wrong.

### C. Structured rendering

Three new render helpers in `plugins/codex/scripts/lib/render.mjs`:

- `renderNoOpDiagnostic({ jobId, title, durationMs, touchedFiles,
  commandsRun, threadId, logFile })` returns a ≥10-line message
  with the operator-facing fields (`Status: failed (no-op)`,
  duration, file count, command count, `Final message: (empty)`,
  thread ID, log path) and a "Next steps:" block listing
  `/codex:rescue --fresh`, `/codex:status <id>`, and
  `/codex:cancel`. The length is deliberate: the Sonnet rescue
  agent's "completed but returned no output" heuristic triggers on
  empty/whitespace stdout, so a structured ≥10-line message
  survives.

- `renderActiveJobConflict(job)` returns a multi-line error body
  used everywhere an active job blocks a new run (the
  `runTrackedJob` terminal-abort surface, the
  `resolveLatestTrackedTaskThread` conflict path, etc.). It
  carries ID, title, status, phase, created-at, updated-at,
  workspace root, and the inspect / cancel / resume hints.

- `renderReconciliationWarnings(warnings)` is the single helper
  invoked by both the multi-job `/codex:status` renderer and the
  targeted `/codex:status <id>` (and `--wait <id>`) renderer. It
  emits a compact `Warnings:` section listing each affected
  `jobId` (or a workspace marker when `jobId === null`) and the
  one-line reason. A warning is never silently dropped from
  either status path.

### ADR 0004 refinement

ADR 0004's "Consequences → Positive" section claimed that
`jobs/{id}.json` writes "still go through `upsertJob` → per-job lock
→ atomic rename → terminal-stickiness". That wording was correct in
spirit for routine writes but did not cover the bounded set of paths
that — by necessity, not laziness — write the job file directly via
`withJobLock` + `writeJobFileUnlocked`. Issue #10 adds two more such
paths, so we formalize the inventory here.

State writes preserve the same strictness guarantees as before
(per-job lock + atomic rename + terminal-stickiness). `upsertJob` is
the canonical path for **routine** writes: progress updates, queued
enqueue, terminal completion, cancellation. A bounded set of paths
write the job file **directly** because they need read + decide +
write in **one critical section** — a semantics `upsertJob` cannot
provide without deadlocking the caller (which would already be
holding the lock) or requiring a recursive lock. These paths, as of
this ADR, are:

1. **(Pre-existing, since Issue #7 / ADR 0003.)**
   `deleteSessionJobs` (state.mjs, session-end cleanup): under the
   per-job lock, read the record, run the `onMatchUnderLock`
   callback, then either `writeJobFileUnlocked` a cancelled record
   (when status is active) or delete the file (when terminal). This
   write path predates Issue #10 and was not covered by ADR 0004's
   wording — the refinement formalizes it. With Issue #10's
   identity-aware callback, the active-record branch may also
   *skip* both the signal and the write entirely when identity is
   unverifiable (record stays byte-identical).
2. **(Pre-existing, since Issue #7 / ADR 0003.)** `pruneJobsOnDisk`
   (state.mjs): under the per-job lock, re-reads the candidate,
   re-confirms `updatedAt` match and non-active status, then
   deletes the file. This is a delete rather than a write, but it
   shares the same single-critical-section + terminal-stickiness
   semantics and the refinement notes it for completeness.
3. **(Pre-existing, legacy migration only.)** `migrateLegacyJobs`
   via `writeJobFileExclusive` (state.mjs): when `loadState` finds
   the legacy `jobs[]` array in `state.json`, it creates
   `jobs/{id}.json` directly via `link(2)` with EXCL semantics.
   **No per-job lock is taken.** This is noted so the production
   direct-write inventory is exhaustive, but does NOT claim it
   shares the read+decide+write critical section of paths 4–5 nor
   that it fully participates in ADR 0003's terminal-stickiness
   invariant. A known small race exists: a concurrent `upsertJob`
   that observed `ENOENT` before the migration's link can rename
   over the freshly-migrated record. This race is pre-existing and
   out of scope for Issue #10; it is surfaced here so the next
   contributor cannot miss it. The fix is to make
   `migrateLegacyJobs` acquire the per-job lock for each migrated
   job and re-check existence under the lock; that change is
   deliberately not bundled into Issue #10.
4. **(New, Issue #10.)** `runTrackedJob`'s initial running
   transition: read the record under the lock; abort without
   writing if terminal; otherwise `writeJobFileUnlocked` the
   running record.
5. **(New, Issue #10.)** `reconcileStaleActiveJobs` per-job
   decision: read; classify as alive/dead with full identity check;
   `writeJobFileUnlocked` a terminal record only when dead and the
   identity still matches the out-of-lock classification.

Terminal-stickiness on these direct paths is enforced by the
under-lock pre-check that returns without writing whenever the
existing record is terminal (paths 4–5 explicitly; paths 1–2 have
their own session-end / pruning semantics preserved as documented
in ADR 0003). ADR 0003's invariants (per-job lock, atomic rename,
terminal records never demoted by routine writes) hold across paths
1–2 and 4–5. **Path 3 (legacy migration) is explicitly excluded**
from those invariants — it does not take the per-job lock and
carries the pre-existing ENOENT-then-rename race documented in its
description. Its safety relies only on best-effort EXCL-link
skipping, not on the broader ADR 0003 protections.

ADR 0004's text is not edited beyond a small forward-pointer note
to this subsection so a reader of ADR 0004 cannot miss the
narrowing.

## Consequences

**Positive**

- ADR 0003's "PID liveness reconciliation" follow-up is resolved.
  A `SIGKILL`'d Codex CLI no longer leaves a `running` row beyond
  the next status read or new-task attempt; the row transitions to
  `failed` with `errorMessage: "Process exited without writing a
  terminal state."`.
- PID reuse cannot cause either a false-positive cleanup or a
  false-negative live-job report. Reconciliation requires verifiable
  identity to terminalize; `/codex:cancel` and the session-end hook
  require verifiable identity to signal.
- `--write` rescue tasks that produce no output and no changes are
  classified as `failed` with a structured ≥10-line diagnostic and
  `noOp: true` persisted in `jobs/{id}.json`. The rescue agent's
  "completed but returned no output" heuristic no longer fires; the
  operator sees concrete next-step guidance instead of silence.
- Active-job conflicts surface ID, title, status, phase, created/
  updated timestamps, workspace, and explicit inspect / cancel /
  resume hints. The operator can tell at a glance whether the
  blocker is a live worker or a stale row awaiting reconciliation.
- Status and result paths uniformly carry a `reconciliationWarnings:
  Warning[]` field with a stable shape (`{ jobId, pid, reason,
  message }`). Both renderers emit warnings via the same helper, so
  unverifiable cases (`proc-unreadable`, `legacy-no-identity`) and
  workspace-scoped failures (`reconcile-error`) are surfaced
  consistently in CLI and JSON consumers.

<a id="consequences-1"></a>

**Negative / trade-offs**

- **Queued startup window.** Between `enqueueBackgroundTask`'s
  durable queued upsert (`pid: null`) and the worker's
  running-transition write, the record carries no identity. If the
  worker has not taken its first lock within 30 s (VM suspend,
  extreme CPU starvation), reconciliation marks the record `failed`.
  The worker eventually wakes, sees the terminal record in its
  initial-transition pre-check, and aborts cleanly. One task is
  lost in this pathological case. The alternative — no time-bound
  on queued records — would let a parent that crashed before spawn
  accumulate ghost jobs that block new tasks. Detached orphans
  cannot result from this case because the worker checks the
  terminal record before doing any work.
- **Identity-unverifiable session-end leaves stale active records.**
  If session-end runs against an active record with no
  `pidStartTime` (legacy) or where `/proc/<pid>/stat` is unreadable,
  the hook deliberately does NOT terminate the process and does NOT
  cancel the record. If the worker is alive, it remains visible in
  `/codex:status` and is cancellable via `/codex:cancel`. If the
  worker is dead and the PID is a stale identifier, the record
  remains active until the next reconciliation pass — which can
  only resolve it if the kernel reports ESRCH for that PID. Modern
  records always carry verifiable identity, so this risk applies
  only to legacy records or non-Linux platforms. A per-job stderr
  diagnostic surfaces each skipped case; further automation is out
  of scope.
- **No general `updatedAt` heartbeat.** The single
  `updatedAt`-bounded reconciliation path is the 30-second
  queued-grace window for records that have `pid: null` (worker
  never reached its first lock). Once a `pid` has been written, the
  record is judged by PID liveness + identity, never by
  `updatedAt`. Live legacy records (no `pidStartTime` at all) and
  modern records with unverifiable identity stay alive as long as
  their PID is alive; both surface a per-job warning. This is
  deliberate: Issue #9 / ADR 0004 made log writes best-effort and
  `createJobProgressUpdater` only rewrites `jobs/{id}.json` when
  phase/threadId/turnId actually change, so `updatedAt` freshness
  is not a reliable liveness signal.
- **`noOp: true` semantics interact with the rescue default.**
  `--write` is rescue's default. A user who asks Codex to "explain"
  with `--write` accidentally on, and whose run legitimately
  produces no output and no changes, will see a no-op failure. The
  safety win (catching the real no-op symptom) outweighs the rare
  false positive; read-only runs are unchanged.
- **The rescue agent might still mistake the structured diagnostic
  for noise.** Mitigations: the diagnostic uses imperative-style
  "Next steps:" guidance; the helper exits 0 so the rescue agent's
  `Return the stdout exactly as-is` clause applies; `/codex:status`
  reports `failed` so any tooling that polls job state sees the
  truth even if the rescue agent's rendering does not.
- **Reconciliation adds a few `process.kill(pid, 0)` + small
  `/proc` reads per call site.** With `MAX_JOBS = 50` and the
  active subset typically much smaller, the overhead is negligible.

**Follow-ups (out of scope for this ADR)**

- Pre-existing legacy-migration race in `migrateLegacyJobs` (path 3
  in the [refinement](#adr-0004-refinement)): fix by acquiring the
  per-job lock around the link, in a separate PR.
- `codex-rescue.md` agent prompt: `--resume-last` auto-inference
  triggers too aggressively on phrasing like "continue", "keep
  going", or "Step 6". A separate Issue tracks this; the structured
  active-job conflict diagnostic from scope C makes the symptom
  visible, but the upstream prompt change is independent.
- Migrating from the per-line `appendFileSync` log path to a held
  file descriptor (already noted in ADR 0004): unchanged by this
  ADR.
