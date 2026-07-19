import { readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";
import { manualToHostServer } from "./from-utcp.mjs";
import { addToClaudeJson, addToCodexToml } from "./host-write.mjs";

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
export function ejectManuals(utcpPath, names, targets, hostPaths, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  const templates = Array.isArray(config.manual_call_templates) ? config.manual_call_templates : [];
  const byName = new Map(templates.map((t) => [t?.name, t]));
  const ejected = [];
  const movable = [];

  for (const name of names) {
    const manual = byName.get(name);
    if (!manual) continue;
    const { server } = manualToHostServer(manual);
    const wroteTo = [];
    for (const target of targets) {
      if (target.host === "codex") {
        addToCodexToml(hostPaths.codex, name, server, backupRoot, opts);
      } else if (target.host === "claude-desktop") {
        addToClaudeJson(hostPaths.claudeDesktop, name, server, backupRoot, { scope: "global", ...opts });
      } else {
        addToClaudeJson(hostPaths.claudeCode, name, server, backupRoot, { scope: target.scope ?? "global", projectKey: target.projectKey, ...opts });
      }
      wroteTo.push(target.host);
    }
    ejected.push({ name, wroteTo });
    movable.push(name);
  }

  const { removed } = removeManualsFromUtcp(utcpPath, movable, backupRoot, opts);
  return { ejected, removed };
}
