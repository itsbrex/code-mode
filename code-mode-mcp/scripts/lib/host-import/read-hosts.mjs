import { existsSync, readFileSync } from "node:fs";

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// Parse `key = "value"` pairs from an inline TOML object body.
// (Approach from ai-config-sync-manager/bin/ai-config-sync.mjs:5422.)
export function parseInlineTomlObject(body) {
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// Parse a TOML/JSON-ish string array `["-y", "pkg"]` → string[].
export function parseStringArray(value) {
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  } catch {
    /* fall through to a tolerant scan */
  }
  return [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

// Normalize a raw MCP server object into the common shape. Keeps real env/header
// values (migration needs them — no secret redaction).
export function normalizeServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const server = {};
  if (typeof raw.command === "string") server.command = raw.command;
  if (typeof raw.url === "string") server.url = raw.url;
  if (Array.isArray(raw.args)) server.args = raw.args.filter((x) => typeof x === "string");
  if (raw.env && typeof raw.env === "object") server.env = { ...raw.env };
  if (typeof raw.bearerTokenEnvVar === "string" && raw.bearerTokenEnvVar) {
    server.bearerTokenEnvVar = raw.bearerTokenEnvVar;
  } else if (typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var) {
    server.bearerTokenEnvVar = raw.bearer_token_env_var;
  }
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = v;
    if (Object.keys(headers).length) server.headers = headers;
  }
  return server;
}

export function readClaudeCode(path) {
  const data = readJson(path);
  const out = [];
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    const server = normalizeServer(raw);
    if (server) out.push({ host: "claude-code", scope: "global", name, server });
  }
  for (const [projectKey, project] of Object.entries(data.projects ?? {})) {
    for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) {
      const server = normalizeServer(raw);
      if (server) out.push({ host: "claude-code", scope: "project", projectKey, name, server });
    }
  }
  return out;
}

export function readClaudeDesktop(path) {
  const data = readJson(path);
  const out = [];
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    const server = normalizeServer(raw);
    if (server) out.push({ host: "claude-desktop", scope: "global", name, server });
  }
  return out;
}

// Codex TOML: parse [mcp_servers.NAME] tables, folding nested
// [mcp_servers.NAME.env] / [mcp_servers.NAME.http_headers] sub-tables into the
// parent, and skipping servers marked `enabled = false` (migrating a disabled
// server would silently re-activate it under code-mode).
// (Table regex from ai-config-sync-manager/bin/ai-config-sync.mjs:5228.)
export function readCodex(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");

  // Group 1 = top-level server name (no dot/bracket); group 2 = sub-section
  // (".env", ".http_headers", ".tools.foo", …) or ""; group 3 = body, which
  // runs to the next table header of ANY kind (`^\[`) or EOF — so a block never
  // absorbs lines from a following table (e.g. `[history]`). This matches the
  // strip regex in Task 6.
  const tablePattern = /^\[mcp_servers\.([^\].]+)((?:\.[^\]]+)?)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  const servers = new Map(); // name -> { raw, disabled }
  for (const match of text.matchAll(tablePattern)) {
    const name = match[1];
    const sub = match[2];
    const body = match[3];
    let entry = servers.get(name);
    if (!entry) {
      entry = { raw: {}, disabled: false };
      servers.set(name, entry);
    }
    if (sub === "") {
      const command = body.match(/^command\s*=\s*"([^"]*)"/m);
      const url = body.match(/^url\s*=\s*"([^"]*)"/m);
      const args = body.match(/^args\s*=\s*(\[.*\])/m);
      const env = body.match(/^env\s*=\s*(\{.*\})/m);
      const headers = body.match(/^http_headers\s*=\s*(\{.*\})/m);
      const bearer = body.match(/^bearer_token_env_var\s*=\s*"([^"]*)"/m);
      const enabled = body.match(/^enabled\s*=\s*(true|false)\b/m);
      if (command) entry.raw.command = command[1];
      if (url) entry.raw.url = url[1];
      if (args) entry.raw.args = parseStringArray(args[1]);
      if (env) entry.raw.env = { ...parseInlineTomlObject(env[1]), ...(entry.raw.env ?? {}) };
      if (headers) entry.raw.headers = { ...parseInlineTomlObject(headers[1]), ...(entry.raw.headers ?? {}) };
      if (bearer) entry.raw.bearer_token_env_var = bearer[1];
      if (enabled && enabled[1] === "false") entry.disabled = true;
    } else if (sub === ".env") {
      entry.raw.env = { ...(entry.raw.env ?? {}), ...parseInlineTomlObject(body) };
    } else if (sub === ".http_headers") {
      entry.raw.headers = { ...(entry.raw.headers ?? {}), ...parseInlineTomlObject(body) };
    }
    // Other sub-tables ([mcp_servers.NAME.tools.*], etc.) are ignored.
  }

  const out = [];
  for (const [name, entry] of servers) {
    if (entry.disabled) continue; // disabled in the host → don't re-activate under code-mode
    const server = normalizeServer(entry.raw);
    if (server) out.push({ host: "codex", scope: "global", name, server });
  }
  return out;
}

export function defaultHostPaths(home = process.env.HOME || "") {
  return {
    claudeCode: `${home}/.claude.json`,
    claudeDesktop: `${home}/Library/Application Support/Claude/claude_desktop_config.json`,
    codex: `${home}/.codex/config.toml`,
  };
}

export function readAllHosts(paths) {
  return [
    ...readClaudeCode(paths.claudeCode),
    ...readClaudeDesktop(paths.claudeDesktop),
    ...readCodex(paths.codex),
  ];
}
