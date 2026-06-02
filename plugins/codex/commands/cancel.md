---
description: Cancel a Codex job by id, or sweep every stale job with --all-stale
argument-hint: '[job-id|--all-stale] [--force] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`
