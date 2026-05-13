const SANDBOX_ENV = "CODEX_PLUGIN_TURN_SANDBOX";
const NETWORK_ENV = "CODEX_PLUGIN_TURN_SANDBOX_NETWORK";
const REFUSED_ALIASES = new Set([
  "danger-full-access",
  "dangerfullaccess",
  "danger-full",
  "full-access",
  "dangerous",
  "bypass"
]);
const VALUE_TRUNCATE_LIMIT = 32;
// C0 control characters + DEL. Stripped before any env value is written to stderr so a
// malicious value like `bad\nSECOND-LINE` cannot inject extra log lines.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

function normalize(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function safeRedact(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  const truncated =
    trimmed.length <= VALUE_TRUNCATE_LIMIT ? trimmed : `${trimmed.slice(0, VALUE_TRUNCATE_LIMIT)}…`;
  return truncated.replace(CONTROL_CHARS_RE, "?");
}

function warn(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // best-effort; never throw from the resolver
  }
}

function resolveNetworkAccess(env, { boolean }) {
  const raw = env[NETWORK_ENV];
  const normalized = normalize(raw);
  if (normalized === "" || normalized === "restricted") {
    return boolean ? false : "restricted";
  }
  if (normalized === "enabled") {
    return boolean ? true : "enabled";
  }
  warn(
    `codex-plugin: ignoring ${NETWORK_ENV}=${safeRedact(raw ?? "")}: unsupported value (allowed: restricted, enabled). Falling back to restricted.`
  );
  return boolean ? false : "restricted";
}

export function resolveTurnSandboxPolicy(env = process.env) {
  const raw = env[SANDBOX_ENV];
  const normalized = normalize(raw);

  if (normalized === "" || normalized === "off") {
    return null;
  }

  if (REFUSED_ALIASES.has(normalized)) {
    warn(
      `codex-plugin: ignoring ${SANDBOX_ENV}=${safeRedact(raw)}: dangerous bypass values are refused by this plugin. Remove the env var or pick external-sandbox, read-only, or workspace-write.`
    );
    return null;
  }

  switch (normalized) {
    case "external-sandbox":
      return {
        type: "externalSandbox",
        networkAccess: resolveNetworkAccess(env, { boolean: false })
      };
    case "read-only":
      return {
        type: "readOnly",
        networkAccess: resolveNetworkAccess(env, { boolean: true })
      };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: resolveNetworkAccess(env, { boolean: true }),
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    default:
      warn(
        `codex-plugin: ignoring ${SANDBOX_ENV}=${safeRedact(raw)}: unsupported value (allowed: external-sandbox, read-only, workspace-write).`
      );
      return null;
  }
}

export const _internals = { SANDBOX_ENV, NETWORK_ENV };
