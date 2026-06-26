// Inverse of to-utcp.convertServer: a UTCP `mcp` manual → { name, server }.
// Un-wraps an mcp-remote stdio wrapper back into a remote `url` server.
export function manualToHostServer(manual) {
  const servers = manual?.config?.mcpServers ?? {};
  const name = manual?.name ?? Object.keys(servers)[0];
  const spec = servers[name] ?? Object.values(servers)[0] ?? {};
  const args = Array.isArray(spec.args) ? spec.args : [];

  // Detect the mcp-remote proxy entry: a bare "mcp-remote" arg (npx form) or a
  // path ending in mcp-remote/.../proxy.js (legacy node form). The URL follows.
  const idx = args.findIndex((a) => a === "mcp-remote" || /(^|\/)mcp-remote(\/|$)/.test(String(a)));
  if (idx !== -1 && typeof args[idx + 1] === "string") {
    const server = { url: args[idx + 1] };
    const headers = {};
    let bearerTokenEnvVar;
    for (let i = idx + 2; i < args.length; i++) {
      if (args[i] !== "--header" || typeof args[i + 1] !== "string") continue;
      const raw = args[i + 1];
      const sep = raw.indexOf(":");
      const key = raw.slice(0, sep).trim();
      const value = raw.slice(sep + 1).trim();
      const bearer = value.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (/^authorization$/i.test(key) && bearer) bearerTokenEnvVar = bearer[1];
      else headers[key] = value;
      i++;
    }
    if (Object.keys(headers).length) server.headers = headers;
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar;
    return { name, server };
  }

  const server = {};
  if (typeof spec.command === "string") server.command = spec.command;
  if (Array.isArray(spec.args)) server.args = spec.args.filter((x) => typeof x === "string");
  if (spec.env && typeof spec.env === "object" && Object.keys(spec.env).length) server.env = { ...spec.env };
  return { name, server };
}
