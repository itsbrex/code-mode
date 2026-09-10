import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { toManualIdentifier } from "../manual-name.mjs";

// Bridges that must never be federated into code-mode (would route to itself).
export const DENYLIST = new Set(["code-mode", "code-mode-mcp", "attio-code-mode", "attio-code-mode-mcp"]);

// --- Bridge auto-detection --------------------------------------------------
// The exact-name denylist misses bridge instances registered under arbitrary
// names (brandjet, forge-stack, snoooz, …). Three tiers, cheapest first:
//   1. exact name in DENYLIST;
//   2. spec heuristics — any command/arg mentioning code-mode/code_mode
//      (repo paths, package names, code-mode.env) or the bridge's own
//      UTCP_CONFIG_FILE / UTCP_CONFIG_PATH env vars;
//   3. content probe — absolute script paths in command/args are read (≤8MB,
//      cached) and scanned for the code-mode wire markers every bridge build
//      contains; a marker-free entry file additionally has its RELATIVE
//      imports followed one level (unbundled dist/ entries put the tool
//      registration in a sibling module). Catches forks living in repos
//      whose path says nothing.
const BRIDGE_MARKERS = /call_tool_chain|@utcp\/code-mode|CodeModeUtcpClient/;
const RELATIVE_SPEC = /\b(?:from\s+|import\s*(?:\(\s*)?|(require)\s*\(\s*)["'](\.\.?(?:\/[^"']*)?)["']/g;
const bridgeProbeCache = new Map();
function readSmallFile(p) {
  try {
    const st = statSync(p);
    if (st.isFile() && st.size <= 8 * 1024 * 1024) return readFileSync(p, "utf8");
  } catch {
    /* unreadable/missing — not a signal */
  }
  return null;
}
function fileLooksLikeBridge(p) {
  let signature;
  try {
    const stat = statSync(p, { bigint: true });
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    bridgeProbeCache.delete(p);
    return false;
  }
  const cached = bridgeProbeCache.get(p);
  if (cached?.signature === signature) return cached.hit;
  const text = readSmallFile(p);
  const hit = text !== null && BRIDGE_MARKERS.test(text);
  bridgeProbeCache.set(p, { signature, hit });
  return hit;
}
function firstProbeFile(paths) {
  for (const path of paths) {
    try { if (statSync(path).isFile()) return path; } catch { /* try the next candidate */ }
  }
  return null;
}
const commonJsFiles = (path) => [path, `${path}.js`, `${path}.json`, `${path}.node`];
const commonJsIndex = (path) => commonJsFiles(resolvePath(path, "index")).slice(1);
function commonJsProbePath(path, directoryOnly = false) {
  // Follow Node's file/main/index order without require.resolve's process-wide
  // path/package caches or executing modules. Package metadata stays bounded.
  const file = directoryOnly ? null : firstProbeFile(commonJsFiles(path));
  if (file) return file;
  const metadata = readSmallFile(resolvePath(path, "package.json"));
  if (metadata !== null) {
    let main;
    try { main = JSON.parse(metadata)?.main; } catch { return null; }
    if (typeof main === "string" && main) {
      const target = resolvePath(path, main);
      const entry = firstProbeFile([...commonJsFiles(target), ...commonJsIndex(target)]);
      if (entry) return entry;
    }
  }
  return firstProbeFile(commonJsIndex(path));
}
function scriptLooksLikeBridge(p) {
  if (fileLooksLikeBridge(p)) return true;
  const text = readSmallFile(p);
  if (text === null) return false;
  let followed = 0;
  for (const m of text.matchAll(RELATIVE_SPEC)) {
    if (++followed > 16) break;
    const relative = resolvePath(dirname(p), m[2]);
    const directoryOnly = /(?:^|[\\/])\.\.?$|[\\/]$/.test(m[2]);
    const candidate = m[1] ? commonJsProbePath(relative, directoryOnly) : relative;
    if (candidate && fileLooksLikeBridge(candidate)) return true;
  }
  return false;
}

export function isCodeModeBridge(name, server = {}) {
  if (DENYLIST.has(name)) return true;
  const tokens = [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(
    (t) => typeof t === "string"
  );
  if (tokens.some((t) => /code[-_]mode/i.test(t))) return true;
  const env = server.env && typeof server.env === "object" ? server.env : {};
  if ("UTCP_CONFIG_FILE" in env || "UTCP_CONFIG_PATH" in env) return true;
  for (const t of tokens) {
    if (isAbsolute(t) && scriptLooksLikeBridge(t)) return true;
  }
  return false;
}

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
  if (isCodeModeBridge(name, server)) {
    return {
      ok: false,
      bridge: true,
      risk: "manual",
      reason: "code-mode bridge (auto-detected) — must not be federated into itself, never stripped",
      harvested: []
    };
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
