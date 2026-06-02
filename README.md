# Codex plugin for Claude Code (devcontainer-hardened fork)

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex — with the rough edges around long-running jobs, devcontainer sandboxes, and resumed sessions sanded down.

This is `openai-codex-devcontainer`, a fork of OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) targeted at Claude Code users running in devcontainer / Docker environments and at workflows that lean heavily on background jobs.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## Why this fork?

The upstream plugin works well for short, foreground-driven Codex use. This fork closes the gaps that show up when you push Codex into long-running background work, multi-session days, and outer-sandboxed dev environments. Four concrete differences:

- **Devcontainer-first sandboxing.** Codex's built-in Linux sandbox (bubblewrap / Landlock) collides with the outer sandbox in devcontainers and breaks `/codex:rescue`, `/codex:adversarial-review`, and task resume. This fork ships an opt-in turn-level `sandboxPolicy` override with a [decision guide](docs/devcontainer-sandbox-settings.md) for picking the right values per environment. See [Devcontainer / Externally Sandboxed Environments](#devcontainer--externally-sandboxed-environments) and [ADR 0001](docs/adr/0001-turn-level-sandbox-policy-for-task-flows.md).
- **Stale-job recovery.** Long-running review records, wedged Codex turns, and queued workers whose host died used to permanently consume Codex's limited active-job capacity, producing the cryptic `no rollout found` on every new launch. This fork adds TTL + progress-timeout staleness classification, a `Stale` column in [`/codex:status`](#codexstatus), a workspace-wide [`/codex:cancel --all-stale`](#codexcancel) sweep, and SessionStart auto-reaping with a bounded lock budget — so a fresh Claude Code session doesn't inherit yesterday's blocked capacity. See [ADR 0006](docs/adr/0006-stale-job-detection-and-reaping.md).
- **Identity-checked PID liveness reconciliation.** A `running` row whose worker died left a phantom that blocked new tasks; resumed Codex threads then hallucinated that the work was already underway. This fork records `pid` + `pidStartTime` at job start and reconciles dead workers identity-aware, so a same-user PID reuse cannot mask a dead worker as alive nor trick reconciliation into signalling an unrelated process. See [ADR 0005](docs/adr/0005-pid-liveness-and-no-op-detection.md).
- **Review subagents enabled by default.** `/codex:setup` materializes the `codex-review` and `codex-adversarial-review` subagents on first run so `Stop` hooks, agent loops, and scheduled jobs can fire reviews programmatically out of the box. Pass `/codex:setup --disable-review-subagents` to opt out. The hardening — read-only tool surface, pinned `Bash(node:*)` call, invoker tagging, optional rate limit — is unchanged from upstream's design; only the default flips. See [Enabling review subagents](#enabling-review-subagents) and [ADR 0002](docs/adr/0002-opt-in-review-subagents-with-invoker-tagging.md).

This fork tracks upstream Codex `1.0.4` as its base; the fork version `1.0.0+base.1.0.4` is the first stable release of the devcontainer-targeted track.

## What You Get

Core commands (slash-command and subagent surface):

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work and manage background jobs
- `/codex:setup` to install / authenticate Codex and toggle plugin features

Fork-only conveniences:

- A `Stale` column in `/codex:status` and a `/codex:cancel --all-stale` sweep so blocked capacity is recoverable from the same surface you already use
- Automatic dead-job reaping and stale tagging on every SessionStart (with a bounded lock budget so the hook never kills Claude Code startup)
- Materialized review subagents enabled by default (opt out with `--disable-review-subagents`), so `Stop` hooks and scheduled jobs can fire `/codex:review` / `/codex:adversarial-review` programmatically
- Opt-in turn-level `sandboxPolicy` forwarding for [devcontainer and other externally sandboxed environments](#devcontainer--externally-sandboxed-environments)

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add zackey-heuristics/codex-plugin-cc-devcontainer
```

Install the plugin:

```bash
/plugin install codex@openai-codex-devcontainer
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`
- `codex-review` and `codex-adversarial-review` subagents in `/agents` — this fork's `/codex:setup` enables them by default (see [Enabling review subagents](#enabling-review-subagents)); opt out with `/codex:setup --disable-review-subagents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

> [!TIP]
> If you are running Claude Code inside a devcontainer, Docker, or another externally sandboxed environment, see [Devcontainer / Externally Sandboxed Environments](#devcontainer--externally-sandboxed-environments) for the env-var opt-in that keeps this command working.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo
- inside a devcontainer or other externally sandboxed environment, see [Devcontainer / Externally Sandboxed Environments](#devcontainer--externally-sandboxed-environments) to enable the turn-level `sandboxPolicy` opt-in

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

When [review subagents are enabled](#enabling-review-subagents) — the default in this fork — `/codex:status` also surfaces the `Invoker` column (`user-slash`, `claude-subagent`, `claude-bash`, `hook`) per review job and an aggregate line showing how many of the recent reviews were Claude-driven vs user-driven.

In this fork, the Active jobs table also gains a `Stale` column that renders the canonical staleness reasons (`ttl-exceeded`, `progress stalled`) for any record that crossed `CODEX_PLUGIN_STALE_TTL_TASK_MS` (default 1 h for task/rescue jobs), `CODEX_PLUGIN_STALE_TTL_REVIEW_MS` (default 15 min for review/adversarial-review jobs), or `CODEX_PLUGIN_PROGRESS_TIMEOUT_MS` (default 5 min since the last heartbeat). A `Stale jobs: N (see rows)` summary line counts the visible stale rows. To clear them in one shot, use [`/codex:cancel --all-stale`](#codexcancel). See [ADR 0006](docs/adr/0006-stale-job-detection-and-reaping.md).

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job — by id, or sweep every stale job in the workspace with `--all-stale`.

Examples:

```bash
/codex:cancel                          # cancel the current / most-recent job
/codex:cancel task-abc123              # cancel a specific job
/codex:cancel --all-stale              # cancel every job tagged stale (fork-only)
/codex:cancel --all-stale --force      # override identity-verification skips
/codex:cancel --all-stale --json       # machine-readable batch summary
```

The `--all-stale` sweep is paired with the [`Stale` column in `/codex:status`](#codexstatus) and with the auto-tagging done by the SessionStart hook. It uses a two-phase tombstone + bounded interrupt race per job so a wedged Codex turn cannot deadlock the batch. See [ADR 0006](docs/adr/0006-stale-job-detection-and-reaping.md).

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate and the opt-in review subagents.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

#### Enabling review subagents

```bash
/codex:setup                              # this fork enables review subagents by default
/codex:setup --disable-review-subagents   # opt out (this fork)
/codex:setup --enable-review-subagents    # explicit re-enable
```

> [!NOTE]
> Upstream defaults review subagents to **off** and requires `--enable-review-subagents` to opt in. This fork inverts the default — a plain `/codex:setup` materializes them automatically — because the workflows this fork targets (devcontainer agents, scheduled `Stop` hooks, long-running rescue loops) need programmatic review access on day one. The hardening below is unchanged.

By default in upstream, `/codex:review` and `/codex:adversarial-review` are slash-command only (`disable-model-invocation: true`), so Claude cannot autonomously fire them. Enabling review subagents materializes two thin-wrapper subagents — `codex-review` and `codex-adversarial-review` — so power-user automation paths (`Stop` hooks, agent loops, scheduled reviews) can invoke reviews programmatically.

The materialized subagents are hardened by design:

- declare `tools: Bash` only — they cannot `Read`, `Glob`, `Grep`, or `Edit`, so the verbatim-return contract is enforced by what they physically can do
- frontmatter starts with `"Use ONLY when explicitly asked"` so Claude does not invoke them as a self-directed "while I'm at it" check
- pinned to a single `node "$CLAUDE_PLUGIN_ROOT/scripts/codex-companion.mjs" <review|adversarial-review> --invoker claude-subagent --` Bash call; `--background` and second commands are forbidden

After toggling, run `/reload-plugins` so Claude Code picks up the change. `setup --json` reports `reviewSubagentsEnabled` from the actual on-disk state of both materialized files (with provenance-marker check), so the value is consistent across workspaces that share the same plugin install.

##### Optional review rate limit

Set `CODEX_PLUGIN_REVIEW_RATE_LIMIT=N/Xmin` (for example `3/15min`) before launching `claude` to cap how many `/codex:review` / `/codex:adversarial-review` calls non-`user-slash` invokers (subagent, hook, raw Bash) may run within a sliding window. User-typed slash commands are **never** rate-limited. Malformed values warn loudly on stderr and refuse non-user reviews rather than silently disabling enforcement. Default is **off** — no rate limit unless the env var is set.

See [ADR 0002](docs/adr/0002-opt-in-review-subagents-with-invoker-tagging.md) for the full design and accepted trade-offs.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Devcontainer / Externally Sandboxed Environments

If you run Claude Code inside a devcontainer, Docker, or any environment that is already isolated by an outer sandbox, Codex's own Linux sandbox (bubblewrap / Landlock) can collide with that outer layer and break task-like flows (`/codex:rescue`, `/codex:adversarial-review`, task / resume).

For task-like flows you can opt in to the documented turn-level `sandboxPolicy` override by setting two env vars before `claude` starts (typically in `devcontainer.json`):

| Env var | Allowed values | Default |
| --- | --- | --- |
| `CODEX_PLUGIN_TURN_SANDBOX` | `external-sandbox`, `read-only`, `workspace-write`, `off` (or unset) | unset → no override |
| `CODEX_PLUGIN_TURN_SANDBOX_NETWORK` | `restricted`, `enabled` | `restricted` |

> See [docs/devcontainer-sandbox-settings.md](docs/devcontainer-sandbox-settings.md) for a decision guide on which values to pick for your environment (devcontainer with a router service for egress control, plain Docker, offline, host, read-only investigation, etc.).

Example `devcontainer.json`:

```jsonc
{
  "containerEnv": {
    "CODEX_PLUGIN_TURN_SANDBOX": "external-sandbox",
    "CODEX_PLUGIN_TURN_SANDBOX_NETWORK": "restricted"
  }
}
```

Notes:

- Default behavior is unchanged. The plugin only forwards `sandboxPolicy` when you opt in.
- `danger-full-access` (and its aliases) are intentionally **refused** by the plugin and never sent on `turn/start`. If you need a full bypass, use the Codex CLI directly with its documented `--dangerously-bypass-approvals-and-sandbox` flag.
- Native `/codex:review` is intentionally **not** covered here; it uses a different control surface (`review/start`). See [ADR 0001](docs/adr/0001-turn-level-sandbox-policy-for-task-flows.md) for the full rationale and upstream issue [openai/codex-plugin-cc#107](https://github.com/openai/codex-plugin-cc/issues/107).
- A very old Codex app-server may reject the `sandboxPolicy` field. Recovery: unset the env var.

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

### Can I run this inside a devcontainer or Docker?

Yes, with an explicit opt-in. Codex CLI's built-in Linux sandbox (bubblewrap / Landlock) can collide with an outer sandbox and break task-like flows (`/codex:rescue`, `/codex:adversarial-review`, task / resume). Set `CODEX_PLUGIN_TURN_SANDBOX=external-sandbox` (and optionally `CODEX_PLUGIN_TURN_SANDBOX_NETWORK=enabled`) in your container env so the plugin forwards a turn-level `sandboxPolicy` on `turn/start`. Default behavior is unchanged when you do not set these vars. See [Devcontainer / Externally Sandboxed Environments](#devcontainer--externally-sandboxed-environments) for the full setup and the security notes, and [docs/devcontainer-sandbox-settings.md](docs/devcontainer-sandbox-settings.md) for a decision guide on which values to pick.
