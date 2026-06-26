import { readFileSync, writeFileSync } from "node:fs";
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
  const backup = backupFile(utcpPath, backupRoot, ...stampArgs(opts));
  writeFileSync(utcpPath, JSON.stringify(config, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { added, skipped, backup };
}
