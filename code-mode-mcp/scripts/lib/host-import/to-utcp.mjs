import { toManualIdentifier } from "../manual-name.mjs";

// Bridges that must never be federated into code-mode (would route to itself).
export const DENYLIST = new Set(["code-mode", "code-mode-mcp", "attio-code-mode", "attio-code-mode-mcp"]);

function wrap(name, spec) {
  return {
    call_template_type: "mcp",
    config: { mcpServers: { [name]: spec } },
    name: toManualIdentifier(name)
  };
}

// --- Secret harvesting (plan #005 p03) ---------------------------------------
// Literal credentials in host configs must not be copied into the UTCP config.
// Values that look like secrets are replaced with ${VAR} references and returned
// as `harvested` entries for the caller to append to code-mode.env.

const SECRET_KEY = /(key|token|secret|password|passwd|credential|bearer|auth)/i;

export function looksSecret(key, value) {
  if (typeof value !== "string") return false;
  if (value.includes("${")) return false; // already a reference
  if (value.length < 16 || /\s/.test(value)) return false;
  if (/^(https?:|file:|\/|~\/)/.test(value)) return false; // URL or path
  return SECRET_KEY.test(String(key));
}

function envVarNameFor(manualName, key, taken) {
  const base = /^[A-Z][A-Z0-9_]*$/.test(key)
    ? key
    : `${toManualIdentifier(manualName).toUpperCase()}_${key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  taken.add(name);
  return name;
}

/**
 * Replace secret-shaped literals in env/headers with ${VAR} refs.
 * Returns { env, headers, harvested: [{ var, value, from }] }.
 * Header values of the form `Bearer <literal>` keep the Bearer prefix and
 * harvest only the credential tail.
 */
export function harvestSecrets(manualName, { env = {}, headers = {} } = {}) {
  const harvested = [];
  const taken = new Set();
  const outEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (looksSecret(k, v)) {
      const varName = envVarNameFor(manualName, k, taken);
      harvested.push({ var: varName, value: v, from: `env ${k}` });
      outEnv[k] = `\${${varName}}`;
    } else {
      outEnv[k] = v;
    }
  }
  const outHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const bearer = typeof v === "string" ? v.match(/^Bearer\s+(\S+)$/) : null;
    const credential = bearer ? bearer[1] : v;
    if (looksSecret(bearer ? "token" : k, credential)) {
      const varName = envVarNameFor(manualName, k, taken);
      harvested.push({ var: varName, value: credential, from: `header ${k}` });
      outHeaders[k] = bearer ? `Bearer \${${varName}}` : `\${${varName}}`;
    } else {
      outHeaders[k] = v;
    }
  }
  return { env: outEnv, headers: outHeaders, harvested };
}

// --- Conversion (plan #005 p02) ----------------------------------------------
// stdio (command) → 1:1 manual. remote (url) → direct `transport: "http"` manual
// (plan #003 c04 convention); `wrapRemote` keeps the old `npx -y mcp-remote`
// stdio wrapper for OAuth-gated endpoints, which UTCP's header-only http
// transport cannot authenticate against.
export function convertServer(name, server, opts = {}) {
  if (DENYLIST.has(name)) {
    return { ok: false, risk: "manual", reason: "code-mode bridge — must not be federated into itself", harvested: [] };
  }
  if (server.command && !server.url) {
    const { env, harvested } = harvestSecrets(name, { env: server.env ?? {} });
    const spec = { command: server.command, args: server.args ?? [], env, transport: "stdio" };
    return { ok: true, risk: "safe", reason: "stdio server — direct UTCP manual", manual: wrap(name, spec), harvested };
  }
  if (server.url) {
    const baseHeaders = { ...(server.headers ?? {}) };
    if (server.bearerTokenEnvVar) baseHeaders.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
    const { headers, harvested } = harvestSecrets(name, { headers: baseHeaders });

    if (opts.wrapRemote) {
      const args = ["-y", "mcp-remote", server.url];
      for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
      const spec = { command: "npx", args, env: {}, transport: "stdio" };
      return {
        ok: true,
        risk: "partial",
        reason: "remote server wrapped via mcp-remote (OAuth flow handled by the wrapper)",
        manual: wrap(name, spec),
        harvested,
      };
    }

    const spec = { url: server.url, transport: "http" };
    if (Object.keys(headers).length) spec.headers = headers;
    const hasAuth = Object.keys(headers).length > 0;
    return {
      ok: true,
      risk: hasAuth ? "safe" : "partial",
      reason: hasAuth
        ? "remote server — direct http manual"
        : "direct http manual — verify the endpoint is not OAuth-gated (use --wrap-remote if it is)",
      manual: wrap(name, spec),
      harvested,
    };
  }
  return { ok: false, risk: "manual", reason: "server has neither command nor url — cannot convert", harvested: [] };
}
