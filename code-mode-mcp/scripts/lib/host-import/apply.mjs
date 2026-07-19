import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

// Append manuals to the UTCP config (deduped by name), backing up first.
export function addManualsToUtcp(utcpPath, manuals, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  if (!Array.isArray(config.manual_call_templates)) config.manual_call_templates = [];
  const have = new Set(config.manual_call_templates.map((t) => t?.name));
  const added = [];
  const skipped = [];
  for (const m of manuals) {
    if (have.has(m.name)) {
      skipped.push(m.name);
      continue;
    }
    config.manual_call_templates.push(m);
    have.add(m.name);
    added.push(m.name);
  }
  if (!added.length) return { added, skipped, backup: null }; // nothing to write
  const backup = backupFile(utcpPath, backupRoot, ...stampArgs(opts));
  writeFileSync(utcpPath, JSON.stringify(config, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { added, skipped, backup };
}

// --- Host-config stripping (opt-in, destructive, backed-up) -------------------

export function stripFromClaudeJson(path, names, backupRoot, opts = {}) {
  if (!existsSync(path)) return { removed: [], backup: null };
  const data = JSON.parse(readFileSync(path, "utf8"));
  const removed = [];
  const bag =
    opts.scope === "project" && opts.projectKey
      ? data.projects?.[opts.projectKey]?.mcpServers
      : data.mcpServers;
  if (bag) {
    for (const n of names) {
      if (n in bag) {
        delete bag[n];
        removed.push(n);
      }
    }
  }
  if (!removed.length) return { removed, backup: null }; // untouched — don't rewrite/backup
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { removed, backup };
}

// Remove [mcp_servers.NAME] tables (and nested [mcp_servers.NAME.*] tables) from
// a Codex config.toml. A table block runs from its header line to the next line
// that starts a new `[` table, or end-of-file.
export function stripFromCodexToml(path, names, backupRoot, opts = {}) {
  if (!existsSync(path)) return { removed: [], backup: null };
  let text = readFileSync(path, "utf8");
  const removed = [];
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(`^\\[mcp_servers\\.${esc}(?:\\.[^\\]]*)?\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "gm");
    if (block.test(text)) removed.push(name);
    text = text.replace(block, "");
  }
  if (!removed.length) return { removed: [], backup: null }; // untouched — don't rewrite/backup
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, text);
  pruneBackups(backupRoot);
  return { removed: [...new Set(removed)], backup };
}
