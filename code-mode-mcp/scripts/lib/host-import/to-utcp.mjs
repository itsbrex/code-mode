// Bridges that must never be federated into code-mode (would route to itself).
export const DENYLIST = new Set(["code-mode", "code-mode-mcp", "attio-code-mode", "attio-code-mode-mcp"]);

function wrap(name, spec) {
  return { call_template_type: "mcp", config: { mcpServers: { [name]: spec } }, name };
}

function headerArgs(server) {
  const headers = { ...(server.headers ?? {}) };
  if (server.bearerTokenEnvVar) headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
  const args = [];
  for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
  return args;
}

// Convert one normalized host server into a UTCP `mcp` manual + risk tag.
// stdio (command) → 1:1 manual. remote (url) → `npx -y mcp-remote <url> --header …`
// (same pattern as the existing zoominfo/databar manuals).
export function convertServer(name, server) {
  if (DENYLIST.has(name)) {
    return { ok: false, risk: "manual", reason: "code-mode bridge — must not be federated into itself" };
  }
  if (server.command && !server.url) {
    const spec = { command: server.command, args: server.args ?? [], env: server.env ?? {}, transport: "stdio" };
    return { ok: true, risk: "safe", reason: "stdio server — direct UTCP manual", manual: wrap(name, spec) };
  }
  if (server.url) {
    const extra = headerArgs(server);
    const spec = {
      command: "npx",
      args: ["-y", "mcp-remote", server.url, ...extra],
      env: {},
      transport: "stdio",
    };
    const needsAuth = extra.length > 0;
    return {
      ok: true,
      risk: needsAuth ? "partial" : "safe",
      reason: needsAuth
        ? "remote server wrapped via mcp-remote — verify auth headers/env carry over"
        : "remote server wrapped via mcp-remote",
      manual: wrap(name, spec),
    };
  }
  return { ok: false, risk: "manual", reason: "server has neither command nor url — cannot convert" };
}
