# ADR 0003: `jobs/` directory is the source of truth for Codex job state

## Status

Accepted — 2026-05-20. Supersedes the implicit "single `state.json` holds
all jobs" design that this repository inherited.

Linked issue: <https://github.com/zackey-heuristics/codex-plugin-cc-devcontainer/issues/7>

## Context

`/codex:status` reported `running` / `verifying` for Codex tasks that had
already completed successfully — sometimes for hours, with an unbounded
elapsed counter. `/codex:cancel` against those entries was inconsistent:
some calls cleared the row, others responded "no running task" because the
underlying Codex process was long gone.

Before this change, the authoritative list of jobs lived in a single
`state.json` file written through a non-atomic read-modify-write inside
`upsertJob`:

```js
const state = loadState(cwd);   // snapshot from disk
mutate(state);                  // mutate in-memory
saveState(cwd, state);          // overwrite the whole file
```

The Codex plugin runs `codex-companion.mjs` as multiple short-lived
processes per Claude Code session: a foreground task, background rescues,
review subagents, and a session-lifecycle hook can all be writing
`state.json` at the same time, and a single task's own progress writes can
race with its own terminal write across two processes (parent + child).

Whenever two writers' snapshots overlapped, the *second writer's stale
snapshot won*. A late progress write from job B (using a snapshot that
predated job A's completion update) silently resurrected A's `running` row.
The per-job log file (`jobs/{id}.log`) recorded the truth, and the
job-specific JSON dropped by `writeJobFile` was correct, but `listJobs`
returned the `state.json` view to `/codex:status`, so operators saw the
stale row.

We considered three remedies:

1. **Global file lock around `state.json`.** Works, but every reader and
   writer in every helper process now contends on one lock. Easy to deadlock
   if a hook crashes mid-update.
2. **Single broker process owning the state.** Removes the race entirely
   but adds a long-lived process to a CLI plugin that today is
   pure-fork-and-exit. Considered too heavy for the scope of this fix.
3. **Per-job files as the source of truth.** Each job has its own
   `jobs/{id}.json`. Writers only touch their own file. There is no
   shared mutable resource to contend over for *distinct* jobs.

Option 3 was chosen. The remaining contention surface — two writers
updating *the same* job concurrently (e.g., a progress event racing the
terminal write) — is handled by a small per-job lock instead of a global
one.

## Decision

1. **`jobs/{id}.json` is authoritative.** `state.json` keeps only schema
   version and configuration (`stopReviewGate`, `reviewSubagentsEnabled`,
   etc.). `listJobs` scans the `jobs/` directory and parses each file.
2. **All job writes are atomic.** `writeJobFile` and `saveState` write to a
   temporary file in the same directory and `rename(2)` it into place, so
   readers never observe an empty or partially-written file.
3. **Per-job advisory lock.** `acquireJobLock` / `releaseJobLock` create
   `jobs/{id}.lock` containing an ownership token (random nonce + pid +
   start time). `releaseJobLock` only unlinks the file when the on-disk
   token matches its own — a stolen lock cannot be released by the
   original holder. Lock files older than a configured staleness window
   are stolen with ownership-checked side-file dance (`*.stealing.<token>`)
   so two would-be stealers cannot both believe they hold the lock.
4. **`upsertJob` is lock-protected and terminal-sticky.** Inside the lock,
   the function re-reads the on-disk file, merges the patch, refuses to
   *demote* a terminal status back to `running`/`queued`, and writes
   atomically. A late progress write therefore cannot resurrect a
   completed job.
5. **Pruning is also lock-protected and uses a re-read confirmation.**
   `pruneJobsOnDisk` selects deletion candidates from a snapshot, then for
   each candidate acquires the lock, re-reads the file, and only deletes
   if the snapshot's `updatedAt` still matches. A job that was rewritten
   between selection and deletion survives.
6. **`deleteSessionJobs` accepts an `onMatchUnderLock` callback** so the
   session-end hook can terminate a still-running process tree inside the
   lock — preventing the case where the hook fires `kill` against a PID
   that has already been reused by a new job.
7. **Legacy migration.** On the first read of a workspace that still has
   `jobs[]` inside its `state.json`, `loadState` drains those entries into
   `jobs/{id}.json` (skipping any file that already exists) and rewrites
   `state.json` without the array.

## Consequences

**Positive**

- The reported stale-job race is eliminated: a completed job cannot be
  un-completed by a concurrent writer.
- `/codex:status` reflects per-file ground truth. `/codex:cancel` works
  consistently because both commands look at the same authoritative
  source.
- Writes contend per-job, not globally. Distinct jobs make zero progress
  against each other.
- Atomic renames mean readers never see a torn or empty job record.
- The session-end hook can safely SIGTERM a stuck Codex tree without
  racing with a PID-reuse window.

**Negative / trade-offs**

- `listJobs` is now a directory scan + N JSON parses instead of one read.
  At the documented job cap (`MAX_JOBS = 50`, with up to `MAX_RECENT_REVIEW_JOBS = 500`
  short-retained review jobs) this is negligible.
- The lock dance (`*.lock`, `*.stealing.<token>`) adds files that operators
  may notice. They are self-cleaning after the configured staleness
  window and are restored if a stealer fails partway through.
- Legacy migration code in `loadState` carries until we are confident no
  workspace still has a `jobs[]` array in `state.json`. We will remove
  the migration after one minor release.
- The new test surface (`tests/state.test.mjs`) is significantly larger
  to cover concurrent writers, stale-lock recovery, pruning under lock,
  and the session-end callback contract. This is the cost of asserting
  the race actually stays fixed.

**Follow-ups (out of scope for this ADR)**

- A general "PID liveness reconciliation" pass that detects Codex
  processes killed without ever writing a terminal state. The reported
  issue did not require it (the tasks all finished cleanly), but it would
  close the remaining hole: a SIGKILL'd Codex CLI would still leave a
  `running` row until the next session-end hook fires.
- Removing the legacy migration code once one release cycle has passed.
