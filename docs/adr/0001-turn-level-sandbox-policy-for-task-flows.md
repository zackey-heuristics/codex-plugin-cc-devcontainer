# ADR 0001: Turn-level `sandboxPolicy` forwarding for task-like flows

- Status: Accepted
- Date: 2026-05-13
- Upstream issue: <https://github.com/openai/codex-plugin-cc/issues/107>

## Context

`codex-plugin-cc` is a thin client over the local Codex CLI / app-server.
Today, `runAppServerTurn()` starts or resumes a thread with the `sandbox`
shorthand on `thread/start` / `thread/resume` (one of `read-only`,
`workspace-write`, `danger-full-access`), but the subsequent `turn/start`
request does **not** include `sandboxPolicy`.

App-server, however, exposes a richer, turn-level override surface:
`TurnStartParams.sandboxPolicy` is a tagged union with four variants —
`dangerFullAccess`, `readOnly`, `externalSandbox`, and `workspaceWrite` —
each with its own network-access flag. The `externalSandbox` variant is
specifically intended for environments that are already isolated by an
external mechanism (devcontainer, Docker, EC2-on-rails, etc.), where
Codex's own Linux sandbox (bubblewrap / Landlock) collides with the outer
sandbox and silently breaks task-like flows.

The plugin currently has no documented path to use that surface. Result:
inside a devcontainer, `/codex:rescue`, `/codex:adversarial-review`,
`task`, and `resume` all rely on the thread-level shorthand only, and a
working bubblewrap install. When bubblewrap is unavailable or restricted,
the run fails before any patch is applied — exactly what motivated this
change.

## Decision

1. `runAppServerTurn(cwd, options)` accepts an optional, fully-structured
   `options.sandboxPolicy`. When provided, it is spread into `turn/start`:

   ```js
   client.request("turn/start", {
     threadId,
     input,
     model,
     effort,
     outputSchema,
     ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {})
   })
   ```

   When not provided, the `turn/start` payload is byte-for-byte identical
   to today. **Default behavior is preserved.**

2. The thread-level `sandbox` shorthand on `thread/start` / `thread/resume`
   is left untouched. Thread shorthand and turn-level policy are different
   control surfaces and are not conflated.

3. The plugin reads two environment variables to derive a policy:

   | Env var | Allowed values | Default |
   | --- | --- | --- |
   | `CODEX_PLUGIN_TURN_SANDBOX` | `external-sandbox`, `read-only`, `workspace-write`, `off` (or unset) | unset → no override |
   | `CODEX_PLUGIN_TURN_SANDBOX_NETWORK` | `restricted`, `enabled` | `restricted` |

   - `external-sandbox` → `{ type: "externalSandbox", networkAccess }`.
   - `read-only` → `{ type: "readOnly", networkAccess: <bool> }`.
   - `workspace-write` → `{ type: "workspaceWrite", writableRoots: [],
     networkAccess: <bool>, excludeTmpdirEnvVar: false, excludeSlashTmp: false }`.
   - **Any other value (including `danger-full-access`, `dangerFullAccess`,
     `full-access`, `bypass`, and unrecognized tokens) is refused.** The
     resolver returns `null` (no override) and prints a single-line
     stderr warning. The plugin never emits `dangerFullAccess` on
     `turn/start`. Users who genuinely need full bypass can invoke the
     Codex CLI directly with its documented flag.

4. The resolver is wired into exactly two call sites in
   `plugins/codex/scripts/codex-companion.mjs`:

   - `executeReviewRun()` — adversarial-review branch (not the native
     `/codex:review` branch).
   - `executeTaskRun()` — covers `task`, `rescue`, and `resume`.

   **Prototype-pollution hardening:** The presence check at both call sites
   uses `Object.hasOwn(request, "sandboxPolicy")` rather than the `in`
   operator. The `in` operator observes inherited prototype properties, so a
   polluted `Object.prototype.sandboxPolicy` would bypass the env-driven
   resolver and silently forward an unintended policy to `turn/start`.
   `Object.hasOwn` restricts the check to own properties only, ensuring the
   env-driven `resolveTurnSandboxPolicy()` gate runs whenever the field was
   not explicitly set on the request object itself.

5. `workspaceWrite.writableRoots` defaults to `[]`. The Codex app-server
   interprets that as "use cwd as writable root" — matching the existing
   thread-level shorthand and avoiding the need to plumb cwd resolution
   into the resolver.

6. The new env value, if invalid, is truncated to the first 32 characters
   in the stderr warning to avoid leaking unbounded user input (and, by
   extension, secrets if a user accidentally puts one there).

7. Native `/codex:review` (`runAppServerReview` → `review/start`) is
   intentionally **not** changed. That path uses a different control
   surface and has its own upstream sandbox-override behavior. Bundling
   it into this fix would broaden the blast radius without resolving
   #107 any faster.

## Consequences

**Positive**

- Devcontainer / Docker / externally sandboxed environments can opt into
  `externalSandbox` and the plugin's task-like flows stop fighting the
  outer sandbox. The fix to Issue #107 is then "set one env var in
  `devcontainer.json`."
- Existing users on the existing path see zero behavioral change.
- The fail-closed defaults (no override unless explicit; `networkAccess`
  defaults to restricted; `danger-full-access` is refused) prevent
  accidental weakening.

**Negative / risk**

- A user could opt into `external-sandbox` on a Codex app-server that
  does not understand `sandboxPolicy`. The plugin only sends the field
  when the user explicitly opts in, so this surfaces as a server-side
  error and is recoverable by unsetting the env var. The README
  documents this trade-off.
- Allowing `workspaceWrite` at the turn level lets a user run a task
  with broader writable scope than the thread shorthand would have
  permitted. This is symmetric with what app-server already exposes via
  `turn/start` and not a new attack surface introduced by the plugin.

**Out of scope**

- Fixing Codex CLI's Linux sandbox failures inside containers (upstream
  Codex CLI work, not plugin work).
- Adding an `external` mode to `.codex/config.toml` or the Codex CLI
  flag surface.
- Changing native `/codex:review` / `review/start` behavior.
- Broker / app-server protocol-version compatibility hardening (a
  separate concern that the upstream issue calls out).
