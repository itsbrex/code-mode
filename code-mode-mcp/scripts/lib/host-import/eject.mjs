import { readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";
import { manualToHostServer } from "./from-utcp.mjs";
import { addToClaudeJson, addToCodexToml } from "./host-write.mjs";
import { destinationFileIdentity } from "./file-identity.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

export function removeManualsFromUtcp(utcpPath, names, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  const drop = new Set(names);
  const before = Array.isArray(config.manual_call_templates) ? config.manual_call_templates : [];
  const removed = before.filter((t) => drop.has(t?.name)).map((t) => t.name);
  config.manual_call_templates = before.filter((t) => !drop.has(t?.name));
  if (!removed.length) return { removed, backup: null }; // untouched — don't rewrite/backup
  const backup = backupFile(utcpPath, backupRoot, ...stampArgs(opts));
  writeFileSync(utcpPath, JSON.stringify(config, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { removed, backup };
}

// Move manuals out into one or more hosts, then remove them from the UTCP config.
export function readEjectableManuals(utcpPath, names) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  const templates = Array.isArray(config.manual_call_templates) ? config.manual_call_templates : [];
  return [...new Set(names)].flatMap((name) => {
    const matches = templates.filter((template) => template?.name === name);
    if (!matches.length) return [];
    const [manual] = matches;
    const servers = manual?.config?.mcpServers;
    const invalid = () => new Error(`Manual '${name}' cannot be ejected as a single MCP server`);
    if (matches.length !== 1 || manual.call_template_type !== "mcp" || !servers ||
      typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length !== 1) throw invalid();
    const [spec] = Object.values(servers);
    if (!spec || typeof spec !== "object" || Array.isArray(spec) || (spec.command !== undefined && spec.url !== undefined)) throw invalid();
    const { server } = manualToHostServer(manual);
    if (!(typeof server.command === "string" && server.command.trim()) &&
      !(typeof server.url === "string" && server.url.trim())) throw invalid();
    return [{ name, server }];
  });
}

function validateTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.some((target) => !target ||
    !["claude-code", "claude-desktop", "codex"].includes(target.host) ||
    (target.scope !== undefined && !["global", "project"].includes(target.scope)) ||
    (target.scope === "project" && (target.host !== "claude-code" || typeof target.projectKey !== "string" || !target.projectKey.trim())) ||
    (target.name !== undefined && (typeof target.name !== "string" || !target.name.trim())))) {
    throw new Error("Ejection requires explicit supported host targets and project scope");
  }
}

// A shared target array preserves the original API; a per-manual Map lets the
// CLI route provenance as one batch, with every destination checked up front.
export function ejectManuals(utcpPath, names, targets, hostPaths, backupRoot, opts = {}) {
  if (!(targets instanceof Map)) validateTargets(targets);
  // Validate the entire selection before writing any destination or removing a
  // manual. Other UTCP protocols and multi-server MCP configs cannot round-trip.
  const entries = readEjectableManuals(utcpPath, names);
  const routed = entries.map((entry) => ({ ...entry, targets: targets instanceof Map ? targets.get(entry.name) : targets }));
  const destinations = new Map();
  const formats = new Map();
  for (const { name, targets: routes } of routed) {
    validateTargets(routes);
    for (const target of routes) {
      const file = target.host === "codex" ? hostPaths.codex : target.host === "claude-desktop" ? hostPaths.claudeDesktop : hostPaths.claudeCode;
      const destination = destinationFileIdentity(file);
      const format = target.host === "codex" ? "toml" : "json";
      if (formats.has(destination) && formats.get(destination) !== format) {
        throw new Error("Host formats cannot share an ejection destination file");
      }
      formats.set(destination, format);
      const scope = target.scope ?? "global";
      const key = JSON.stringify([destination, scope, scope === "project" ? target.projectKey : "", target.name ?? name]);
      if (destinations.has(key) && destinations.get(key) !== name) {
        throw new Error(`Ejection destination collision between '${destinations.get(key)}' and '${name}'`);
      }
      destinations.set(key, name);
    }
  }
  const ejected = [];
  for (const { name, server, targets } of routed) {
    const wroteTo = [];
    for (const target of targets) {
      const sourceName = target.name ?? name;
      if (target.host === "codex") {
        addToCodexToml(hostPaths.codex, sourceName, server, backupRoot, opts);
      } else if (target.host === "claude-desktop") {
        addToClaudeJson(hostPaths.claudeDesktop, sourceName, server, backupRoot, { scope: "global", ...opts });
      } else {
        addToClaudeJson(hostPaths.claudeCode, sourceName, server, backupRoot, { scope: target.scope ?? "global", projectKey: target.projectKey, ...opts });
      }
      wroteTo.push(target.host);
    }
    ejected.push({ name, wroteTo });
  }

  const { removed } = removeManualsFromUtcp(utcpPath, entries.map((entry) => entry.name), backupRoot, opts);
  return { ejected, removed };
}
