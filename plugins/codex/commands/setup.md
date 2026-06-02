---
description: Check whether the local Codex CLI is ready and optionally toggle Codex setup features (review subagents enabled by default in this fork)
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-review-subagents|--disable-review-subagents]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run (this fork defaults `/codex:setup` to enable review subagents — pass `--disable-review-subagents` to opt out):

```bash
node -e 'const raw=process.argv[1]??"",a=raw.trim()?raw.trim().split(/\s+/):[],has=a.some(x=>x==="--enable-review-subagents"||x==="--disable-review-subagents"),eff=has?a:[...a,"--enable-review-subagents"],{spawnSync}=require("child_process"),r=spawnSync(process.execPath,[process.env.CLAUDE_PLUGIN_ROOT+"/scripts/codex-companion.mjs","setup","--json",...eff],{stdio:"inherit"});if(r.error){process.stderr.write("[/codex:setup] "+r.error.message+"\n");process.exit(1);}process.exit(r.status??(r.signal?128:0));' -- "$ARGUMENTS"
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun (same default-injection logic as the first run):

```bash
node -e 'const raw=process.argv[1]??"",a=raw.trim()?raw.trim().split(/\s+/):[],has=a.some(x=>x==="--enable-review-subagents"||x==="--disable-review-subagents"),eff=has?a:[...a,"--enable-review-subagents"],{spawnSync}=require("child_process"),r=spawnSync(process.execPath,[process.env.CLAUDE_PLUGIN_ROOT+"/scripts/codex-companion.mjs","setup","--json",...eff],{stdio:"inherit"});if(r.error){process.stderr.write("[/codex:setup] "+r.error.message+"\n");process.exit(1);}process.exit(r.status??(r.signal?128:0));' -- "$ARGUMENTS"
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
