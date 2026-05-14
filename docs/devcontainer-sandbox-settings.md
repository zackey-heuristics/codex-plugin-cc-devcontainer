# Choosing `CODEX_PLUGIN_TURN_SANDBOX*` values

This plugin reads two environment variables to decide what `sandboxPolicy` to forward on `turn/start` for task-like flows (`/codex:rescue`, `/codex:adversarial-review`, `task`, `resume`):

| Env var | Allowed values | Default |
| --- | --- | --- |
| `CODEX_PLUGIN_TURN_SANDBOX` | `external-sandbox`, `read-only`, `workspace-write`, `off` (or unset) | unset → no override (plugin sends nothing) |
| `CODEX_PLUGIN_TURN_SANDBOX_NETWORK` | `restricted`, `enabled` | `restricted` |

If `CODEX_PLUGIN_TURN_SANDBOX` is unset or `off`, the plugin behaves exactly like upstream — no `sandboxPolicy` is sent and the network var is ignored.

This document explains **when to set what**, with concrete examples.

## TL;DR decision guide

| Your environment | `CODEX_PLUGIN_TURN_SANDBOX` | `CODEX_PLUGIN_TURN_SANDBOX_NETWORK` |
| --- | --- | --- |
| Plain host machine (no outer sandbox), Codex sandbox works | unset (or `off`) | unset |
| Devcontainer / Docker with **its own egress controls** (router / iptables / firewall in front of the container) | `external-sandbox` | `enabled` |
| Devcontainer / Docker with **no outer egress control**, you want defense-in-depth | `external-sandbox` | `restricted` |
| Air-gapped or fully offline container | `external-sandbox` | `restricted` |
| You want to lock tasks to read-only regardless of environment | `read-only` | `restricted` or `enabled` |
| You want tasks to be able to write outside the workspace (rare) | `workspace-write` | `restricted` or `enabled` |

## What each value actually does

### `CODEX_PLUGIN_TURN_SANDBOX`

This selects which `sandboxPolicy` variant the plugin forwards on `turn/start`.

- **`external-sandbox`** — the right choice when something *outside* Codex (devcontainer, Docker, VM, jail, EC2 hardening) is already enforcing isolation. Codex stops trying to set up its own bubblewrap / Landlock sandbox, which is what collides with an outer sandbox and breaks task-like flows.
- **`read-only`** — tasks can read but not write. Use when you want to use task-flows for investigation only.
- **`workspace-write`** — Codex can write inside the workspace. Equivalent to the existing thread-level `workspace-write` shorthand, but expressed at turn level. Broader than `external-sandbox` in practice — only use if you specifically want to widen the writable scope at turn level.
- **`off`** / unset — plugin sends no `sandboxPolicy`. Identical to upstream behavior.
- **`danger-full-access`** (and aliases like `dangerFullAccess`, `bypass`, `full-access`) — **refused by the plugin** and prints a stderr warning. If you genuinely need full bypass, use the Codex CLI directly with its documented `--dangerously-bypass-approvals-and-sandbox` flag.

### `CODEX_PLUGIN_TURN_SANDBOX_NETWORK`

This is a **declaration to Codex** about the network reachability inside the (external) sandbox. It does not itself open or close a network — your devcontainer / host does that.

- **`restricted`** — tells Codex the turn has no usable network. Codex will avoid or gate commands that need network (`npm install`, `curl`, `git fetch` from a non-local remote, etc.).
- **`enabled`** — tells Codex the turn has usable network. Codex will run network-using commands freely. Whatever sits outside Codex (router, firewall, container egress policy) remains the actual gatekeeper.

The key thing to internalize: `networkAccess` is a **truthful description of the environment**, not an enforcement knob. If your container has network and you set `restricted`, you create friction without adding any security — the network is still there, Codex just refuses to use it. If your container has no network and you set `enabled`, Codex will try things that fail with confusing errors.

**Match this value to what your outer environment actually allows.**

## Worked examples

### Devcontainer with a router service controlling egress

```jsonc
"CODEX_PLUGIN_TURN_SANDBOX": "external-sandbox",
"CODEX_PLUGIN_TURN_SANDBOX_NETWORK": "enabled"
```

This is the pattern where the workload container has no direct egress — typically on an `internal: true` Docker network or equivalent — and all outbound traffic is forced through a separate router service that applies iptables / firewall rules (for example: DNS allowed, RFC1918 / link-local / CGNAT dropped, internet otherwise permitted, with an optional allowlist for private ranges).

- The workload container *does* have working internet (the router permits it) — so `enabled` matches reality.
- The router is the actual egress gatekeeper. Setting `restricted` here would just make Codex refuse or gate commands that need network, without adding any security, because the router is already the single source of truth for network policy.

### A minimal devcontainer with no router and the default Docker bridge

```jsonc
"CODEX_PLUGIN_TURN_SANDBOX": "external-sandbox",
"CODEX_PLUGIN_TURN_SANDBOX_NETWORK": "enabled"
```

A vanilla devcontainer still has full internet access via the default Docker bridge, so `enabled` is accurate. Use `restricted` only if you actually want to suppress Codex's network use as a defense-in-depth layer.

### An offline / air-gapped container

```jsonc
"CODEX_PLUGIN_TURN_SANDBOX": "external-sandbox",
"CODEX_PLUGIN_TURN_SANDBOX_NETWORK": "restricted"
```

There's no network. Telling Codex `enabled` would only produce confusing failures.

### Running Claude Code on the host (no outer sandbox)

Leave both unset. The plugin sends no override and Codex's own bubblewrap / Landlock setup works as upstream intends.

### Using task-flows for investigation only

```bash
export CODEX_PLUGIN_TURN_SANDBOX=read-only
export CODEX_PLUGIN_TURN_SANDBOX_NETWORK=enabled  # or restricted, your call
```

`/codex:rescue` etc. can read code and run reads, but not mutate the workspace.

## How the plugin handles bad values

- Unrecognized `CODEX_PLUGIN_TURN_SANDBOX` values → plugin returns `null` (no override) and prints a one-line stderr warning.
- Unrecognized `CODEX_PLUGIN_TURN_SANDBOX_NETWORK` values → falls back to `restricted` and prints a stderr warning.
- `danger-full-access` and its aliases → refused with a stderr warning, regardless of how they're spelled.
- Values are truncated to 32 characters before being echoed in warnings, and control characters are stripped, so a malicious value cannot inject extra log lines or leak unbounded user input.

See `plugins/codex/scripts/lib/turn-sandbox-policy.mjs` for the resolver implementation and `tests/turn-sandbox-policy.test.mjs` for the full behavior matrix.

## What is *not* affected by these vars

- Native `/codex:review` (`review/start`) — uses a different control surface and is intentionally not touched. See [ADR 0001](adr/0001-turn-level-sandbox-policy-for-task-flows.md) for the rationale.
- Thread-level `sandbox` shorthand on `thread/start` / `thread/resume` — left as upstream.
- Any Codex CLI config in `~/.codex/config.toml` or `.codex/config.toml` — those still apply to model / effort / base URL etc.

## References

- [ADR 0001 — Turn-level `sandboxPolicy` forwarding for task-like flows](adr/0001-turn-level-sandbox-policy-for-task-flows.md)
- README → [Devcontainer / Externally Sandboxed Environments](../README.md#devcontainer--externally-sandboxed-environments)
- Upstream issue: <https://github.com/openai/codex-plugin-cc/issues/107>
