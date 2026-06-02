import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildSingleJobSnapshot, buildStatusSnapshot, resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import {
  renderActiveJobConflict,
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "../plugins/codex/scripts/lib/render.mjs";
import { saveState, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("renderSetupReport includes review subagent state", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24.0.0" },
    npm: { detail: "10.0.0" },
    codex: { detail: "installed" },
    auth: { detail: "logged in" },
    sessionRuntime: { label: "direct" },
    reviewGateEnabled: true,
    reviewSubagentsEnabled: false,
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /^- review gate: enabled$/m);
  assert.match(output, /^- review subagents: disabled$/m);
});

test("renderCancelReport surfaces when a job was already terminal", () => {
  const output = renderCancelReport({
    id: "task-finished",
    status: "completed",
    title: "Codex Task",
    cancelNote: "Job had already completed; no action taken."
  });

  assert.match(output, /Did not cancel task-finished\./);
  assert.match(output, /Job had already completed; no action taken\./);
  assert.match(output, /- Title: Codex Task/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

function baseStatusReport(overrides = {}) {
  return {
    sessionRuntime: { label: "direct" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: false,
    reviewInvokerBreakdown: {
      windowMs: 3_600_000,
      total: 0,
      byInvoker: {
        "user-slash": 0,
        "claude-subagent": 0,
        "claude-bash": 0,
        hook: 0
      }
    },
    ...overrides
  };
}

test("renderStatusReport includes invoker table column and legacy review invoker", () => {
  const output = renderStatusReport(
    baseStatusReport({
      running: [
        {
          id: "review-running",
          kindLabel: "review",
          kind: "review",
          jobClass: "review",
          status: "running",
          phase: "reviewing",
          elapsed: "2s",
          invoker: "claude-subagent",
          summary: "working tree"
        },
        {
          id: "task-running",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "3s",
          summary: "task"
        }
      ],
      latestFinished: {
        id: "review-legacy",
        kindLabel: "adversarial-review",
        kind: "adversarial-review",
        jobClass: "review",
        status: "completed",
        phase: "done",
        duration: "1s",
        summary: "legacy"
      },
      reviewInvokerBreakdown: {
        windowMs: 3_600_000,
        total: 1,
        byInvoker: {
          "user-slash": 0,
          "claude-subagent": 1,
          "claude-bash": 0,
          hook: 0
        }
      }
    })
  );

  assert.match(output, /\| Job \| Kind \| Invoker \| Status \|/);
  assert.match(output, /\| review-running \| review \| claude-subagent \| running \|/);
  assert.match(output, /\| task-running \| rescue \| - \| running \|/);
  assert.match(output, /Invoker: unknown/);
});

test("renderStatusReport includes review invoker aggregate only when reviews exist", () => {
  const output = renderStatusReport(
    baseStatusReport({
      latestFinished: {
        id: "review-1",
        kindLabel: "review",
        kind: "review",
        jobClass: "review",
        status: "completed",
        phase: "done",
        invoker: "claude-subagent",
        summary: "done"
      },
      reviewInvokerBreakdown: {
        windowMs: 3_600_000,
        total: 3,
        byInvoker: {
          "user-slash": 1,
          "claude-subagent": 1,
          "claude-bash": 1,
          hook: 0
        }
      }
    })
  );

  assert.equal(
    output.match(/reviews in the last hour were Claude-driven/g)?.length,
    1
  );
  assert.match(output, /2 of last 3 reviews in the last hour were Claude-driven \(claude-subagent or claude-bash\)\./);

  const emptyOutput = renderStatusReport(baseStatusReport());
  assert.doesNotMatch(emptyOutput, /reviews in the last hour were Claude-driven/);
});

function staleBothReasons(overrides = {}) {
  return {
    reasons: ["ttl-exceeded", "progress-stalled"],
    detectedAt: new Date().toISOString(),
    ageMs: 4_000_000,
    lastProgressMs: Date.now() - 400_000,
    ttlMs: 3_600_000,
    progressTimeoutMs: 300_000,
    ...overrides
  };
}

test("renderStatusReport flags stale active jobs inline with human-readable reasons", () => {
  const output = renderStatusReport(
    baseStatusReport({
      staleIds: ["task-stale"],
      running: [
        {
          id: "task-stale",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "1h 6m",
          summary: "long task",
          staleness: staleBothReasons()
        }
      ]
    })
  );

  assert.match(output, /stale: TTL exceeded \([^)]+\), progress stalled \([^)]+\)/);
  assert.match(output, /Stale: TTL exceeded \([^)]+\), progress stalled \([^)]+\)/);
  assert.match(output, /Stale jobs: 1 \(see rows\)/);
  assert.doesNotMatch(output, /ttl-exceeded/);
  assert.doesNotMatch(output, /progress-stalled/);
});

test("renderStatusReport drops unknown stale reasons instead of rendering raw values", () => {
  const injectedReason = "evil|\n<img src=x>";
  const output = renderStatusReport(
    baseStatusReport({
      staleIds: ["task-stale"],
      running: [
        {
          id: "task-stale",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "1h 6m",
          summary: "long task",
          staleness: staleBothReasons({
            reasons: [injectedReason, "ttl-exceeded"]
          })
        }
      ]
    })
  );

  assert.match(output, /stale: TTL exceeded \([^)]+\)/);
  assert.match(output, /^  Stale: TTL exceeded \([^)]+\)$/m);
  assert.doesNotMatch(output, /progress stalled/);
  assert.doesNotMatch(output, /evil/);
  assert.doesNotMatch(output, /<img src=x>/);
});

test("renderStatusReport counts only visible stale rows in the stale summary", () => {
  const output = renderStatusReport(
    baseStatusReport({
      staleIds: ["task-stale", "task-filtered-out"],
      running: [
        {
          id: "task-stale",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "1h 6m",
          summary: "long task",
          staleness: staleBothReasons({
            reasons: ["ttl-exceeded"]
          })
        }
      ]
    })
  );

  assert.match(output, /Stale jobs: 1 \(see rows\)/);
  assert.doesNotMatch(output, /Stale jobs: 2/);
});

test("renderStatusReport suppresses stale markers when all stale reasons are unknown", () => {
  const output = renderStatusReport(
    baseStatusReport({
      staleIds: ["task-stale"],
      running: [
        {
          id: "task-stale",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "1h 6m",
          summary: "long task",
          staleness: staleBothReasons({
            reasons: ["evil|\n<img src=x>"]
          })
        }
      ]
    })
  );

  assert.doesNotMatch(output, /stale:/);
  assert.doesNotMatch(output, /Stale:/);
  assert.doesNotMatch(output, /Stale jobs:/);
  assert.doesNotMatch(output, /evil/);
  assert.doesNotMatch(output, /<img src=x>/);
});

test("renderJobStatusReport shows a stale section for targeted jobs", () => {
  const output = renderJobStatusReport({
    job: {
      id: "task-stale",
      kindLabel: "rescue",
      kind: "task",
      jobClass: "task",
      status: "running",
      phase: "running",
      elapsed: "1h 6m",
      staleness: staleBothReasons()
    },
    staleIds: ["task-stale"],
    reconciliationWarnings: []
  });

  assert.match(output, /^  Stale: TTL exceeded \([^)]+\), progress stalled \([^)]+\)$/m);
  assert.doesNotMatch(output, /ttl-exceeded/);
  assert.doesNotMatch(output, /progress-stalled/);
});

test("renderJobStatusReport drops unknown stale reasons instead of rendering raw values", () => {
  const output = renderJobStatusReport({
    job: {
      id: "task-stale",
      kindLabel: "rescue",
      kind: "task",
      jobClass: "task",
      status: "running",
      phase: "running",
      elapsed: "1h 6m",
      staleness: staleBothReasons({
        reasons: ["progress-stalled", "evil|\n<img src=x>"]
      })
    },
    staleIds: ["task-stale"],
    reconciliationWarnings: []
  });

  assert.match(output, /^  Stale: progress stalled \([^)]+\)$/m);
  assert.doesNotMatch(output, /TTL exceeded/);
  assert.doesNotMatch(output, /evil/);
  assert.doesNotMatch(output, /<img src=x>/);
});

test("renderStatusReport does not render stale markers for normal active jobs", () => {
  const output = renderStatusReport(
    baseStatusReport({
      running: [
        {
          id: "task-running",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "3s",
          summary: "task"
        }
      ]
    })
  );

  assert.doesNotMatch(output, /stale:/);
  assert.doesNotMatch(output, /Stale:/);
  assert.doesNotMatch(output, /Stale jobs:/);
});

test("buildStatusSnapshot counts review invokers across workspace sessions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-snapshot-"));
  const now = Date.parse("2026-05-14T12:00:00.000Z");

  saveState(workspace, { config: { stopReviewGate: false } });
  for (const job of [
    {
      id: "review-current",
      status: "completed",
      jobClass: "review",
      sessionId: "sess-current",
      invoker: "claude-subagent",
      createdAt: "2026-05-14T11:30:00.000Z",
      updatedAt: "2026-05-14T11:30:10.000Z"
    },
    {
      id: "review-other-1",
      status: "completed",
      jobClass: "review",
      sessionId: "sess-other",
      invoker: "claude-subagent",
      createdAt: "2026-05-14T11:40:00.000Z",
      updatedAt: "2026-05-14T11:40:10.000Z"
    },
    {
      id: "review-other-2",
      status: "completed",
      jobClass: "review",
      sessionId: "sess-other",
      invoker: "claude-subagent",
      createdAt: "2026-05-14T11:50:00.000Z",
      updatedAt: "2026-05-14T11:50:10.000Z"
    }
  ]) {
    upsertJob(workspace, job);
  }

  const snapshot = buildStatusSnapshot(workspace, {
    env: { [SESSION_ID_ENV]: "sess-current" },
    now
  });

  assert.equal(snapshot.latestFinished.id, "review-current");
  assert.equal(snapshot.recent.length, 0);
  assert.equal(snapshot.reviewInvokerBreakdown.total, 3);
  assert.equal(snapshot.reviewInvokerBreakdown.byInvoker["claude-subagent"], 3);
});

test("buildStatusSnapshot exposes staleIds for stale active jobs", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-stale-"));
  const jobId = "task-stale-snapshot";

  saveState(workspace, { config: { stopReviewGate: false } });
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    jobClass: "task",
    kind: "task",
    phase: "running",
    startedAt: new Date(Date.now() - 4_000_000).toISOString(),
    updatedAt: new Date(Date.now() - 4_000_000).toISOString(),
    pid: null,
    pidStartTime: null
  });

  const snapshot = buildStatusSnapshot(workspace, {
    env: { [SESSION_ID_ENV]: "" }
  });

  assert.ok(Array.isArray(snapshot.staleIds));
  assert.ok(snapshot.staleIds.includes(jobId));
  assert.ok(snapshot.running.find((job) => job.id === jobId)?.staleness);
});

test("buildStatusSnapshot scopes staleIds to the current session", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-stale-session-"));
  const currentJobId = "task-stale-current";
  const otherJobId = "task-stale-other";
  const staleAt = new Date(Date.now() - 4_000_000).toISOString();

  saveState(workspace, { config: { stopReviewGate: false } });
  for (const job of [
    {
      id: currentJobId,
      sessionId: "sess-current"
    },
    {
      id: otherJobId,
      sessionId: "sess-other"
    }
  ]) {
    upsertJob(workspace, {
      ...job,
      status: "running",
      jobClass: "task",
      kind: "task",
      phase: "running",
      startedAt: staleAt,
      updatedAt: staleAt,
      pid: null,
      pidStartTime: null
    });
  }

  const snapshot = buildStatusSnapshot(workspace, {
    env: { [SESSION_ID_ENV]: "sess-current" }
  });

  assert.ok(snapshot.staleIds.includes(currentJobId));
  assert.equal(snapshot.staleIds.includes(otherJobId), false);
  assert.deepEqual(snapshot.running.map((job) => job.id), [currentJobId]);
});

test("buildSingleJobSnapshot scopes staleIds to the selected job", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-single-stale-"));
  const staleJobId = "task-single-stale";
  const freshJobId = "task-single-fresh";

  saveState(workspace, { config: { stopReviewGate: false } });
  upsertJob(workspace, {
    id: staleJobId,
    status: "running",
    jobClass: "task",
    kind: "task",
    phase: "running",
    startedAt: new Date(Date.now() - 4_000_000).toISOString(),
    updatedAt: new Date(Date.now() - 4_000_000).toISOString(),
    pid: null,
    pidStartTime: null
  });
  upsertJob(workspace, {
    id: freshJobId,
    status: "running",
    jobClass: "task",
    kind: "task",
    phase: "running",
    startedAt: new Date().toISOString(),
    pid: null,
    pidStartTime: null
  });

  assert.deepEqual(buildSingleJobSnapshot(workspace, staleJobId).staleIds, [staleJobId]);
  assert.deepEqual(buildSingleJobSnapshot(workspace, freshJobId).staleIds, []);
});

test("resolveResultJob scopes staleIds to the selected finished job", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-result-stale-"));
  const finishedJobId = "task-result-finished-current";
  const currentStaleJobId = "task-result-stale-current";
  const otherStaleJobId = "task-result-stale-other";
  const staleAt = new Date(Date.now() - 4_000_000).toISOString();
  const originalSessionId = process.env[SESSION_ID_ENV];

  saveState(workspace, { config: { stopReviewGate: false } });
  upsertJob(workspace, {
    id: finishedJobId,
    status: "completed",
    jobClass: "task",
    kind: "task",
    phase: "done",
    sessionId: "sess-current",
    createdAt: "2026-05-14T11:00:00.000Z",
    startedAt: "2026-05-14T11:00:00.000Z",
    completedAt: "2026-05-14T11:05:00.000Z",
    updatedAt: "2026-05-14T11:05:00.000Z"
  });
  for (const job of [
    {
      id: currentStaleJobId,
      sessionId: "sess-current"
    },
    {
      id: otherStaleJobId,
      sessionId: "sess-other"
    }
  ]) {
    upsertJob(workspace, {
      ...job,
      status: "running",
      jobClass: "task",
      kind: "task",
      phase: "running",
      startedAt: staleAt,
      updatedAt: staleAt,
      pid: null,
      pidStartTime: null
    });
  }

  try {
    process.env[SESSION_ID_ENV] = "sess-current";
    const result = resolveResultJob(workspace);

    assert.equal(result.job.id, finishedJobId);
    assert.ok(Array.isArray(result.staleIds));
    assert.deepEqual(result.staleIds, []);
    assert.equal(result.staleIds.includes(currentStaleJobId), false);
    assert.equal(result.staleIds.includes(otherStaleJobId), false);
  } finally {
    if (originalSessionId === undefined) {
      delete process.env[SESSION_ID_ENV];
    } else {
      process.env[SESSION_ID_ENV] = originalSessionId;
    }
  }
});

test("renderActiveJobConflict interpolates the job id into every cancel hint", () => {
  const output = renderActiveJobConflict({
    id: "task-abc123",
    title: "stuck task",
    status: "running",
    phase: "running",
    createdAt: "2026-05-30T00:00:00Z",
    updatedAt: "2026-05-30T00:05:00Z",
    workspaceRoot: "/tmp/ws"
  });

  assert.ok(!output.includes("${id}"), "rendered text must not contain a literal ${id} token");
  assert.ok(
    output.includes("/codex:cancel task-abc123"),
    "rendered text must include the interpolated cancel command for the job id"
  );
  // The stuck-job hint should reference the specific job id, not the literal token.
  assert.match(
    output,
    /If this job is stuck or its process has died, \/codex:cancel task-abc123/
  );
});
