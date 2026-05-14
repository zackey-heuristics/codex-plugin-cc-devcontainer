import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderSetupReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

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
