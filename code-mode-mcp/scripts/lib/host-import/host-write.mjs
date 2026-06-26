import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

export function toClaudeServer(server) {
  const headers = { ...(server.headers ?? {}) };
  if (server.bearerTokenEnvVar) headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
  const type = server.command ? "stdio" : server.url ? "http" : undefined;
  return {
    ...(type ? { type } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function addToClaudeJson(path, name, server, backupRoot, opts = {}) {
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  let bag;
  if (opts.scope === "project" && opts.projectKey) {
    if (!data.projects) data.projects = {};
    if (!data.projects[opts.projectKey]) data.projects[opts.projectKey] = {};
    if (!data.projects[opts.projectKey].mcpServers) data.projects[opts.projectKey].mcpServers = {};
    bag = data.projects[opts.projectKey].mcpServers;
  } else {
    if (!data.mcpServers) data.mcpServers = {};
    bag = data.mcpServers;
  }
  bag[name] = toClaudeServer(server);
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { backup };
}

function tomlString(v) {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function tomlStringArray(arr) {
  return `[${arr.map(tomlString).join(", ")}]`;
}
function tomlInlineObject(obj) {
  return `{ ${Object.entries(obj).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ")} }`;
}

export function renderCodexMcpTable(name, server) {
  const lines = [`[mcp_servers.${name}]`];
  if (server.command) {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) lines.push(`args = ${tomlStringArray(server.args)}`);
    if (server.env && Object.keys(server.env).length) lines.push(`env = ${tomlInlineObject(server.env)}`);
  } else if (server.url) {
    lines.push(`transport = "streamable_http"`);
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.headers && Object.keys(server.headers).length) lines.push(`http_headers = ${tomlInlineObject(server.headers)}`);
    if (server.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
  }
  return lines.join("\n") + "\n";
}

export function addToCodexToml(path, name, server, backupRoot, opts = {}) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^\\[mcp_servers\\.${esc}(?:\\.[^\\]]*)?\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "gm");
  text = text.replace(block, "");
  if (text.length && !text.endsWith("\n")) text += "\n";
  text += (text.length ? "\n" : "") + renderCodexMcpTable(name, server);
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, text);
  pruneBackups(backupRoot);
  return { backup };
}
