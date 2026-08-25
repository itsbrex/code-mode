import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import "@utcp/mcp";
import { CallTemplateSerializer, ensureCorePluginsInitialized } from "@utcp/sdk";
import { backupFile, pruneBackups } from "./backup.mjs";
import { toManualIdentifier } from "../manual-name.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

// Append manuals to the UTCP config (deduped by name), backing up first.
export function addManualsToUtcp(utcpPath, manuals, backupRoot, opts = {}) {
  ensureCorePluginsInitialized();
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

    const serializer = new CallTemplateSerializer();
    try {
      serializer.validateDict(JSON.parse(JSON.stringify(m)));
    } catch (error) {
      const name = typeof m?.name === "string" ? m.name : "(unnamed)";
      throw new Error(
        `Invalid generated UTCP manual '${name}': ${error instanceof Error ? error.message : String(error)}`
      );
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

// --- Harvested-secret env writing (plan #005 p03) ----------------------------
// Append harvested secrets to code-mode.env in the plan-#003 convention: the
// plain var plus per-manual namespaced forms (`<sanitized>_VAR`, and the
// dashes-doubled `the__swarm`-style variant when the manual name has dashes).
// Existing vars are never overwritten — a conflicting value is reported and
// skipped so a re-run cannot clobber a rotated credential.
export function envFormsFor(manualName, varName) {
  const forms = new Set([varName, `${toManualIdentifier(manualName)}_${varName}`]);
  if (manualName.includes("-")) forms.add(`${manualName.replace(/-/g, "__")}_${varName}`);
  return [...forms];
}

export function appendHarvestedEnv(envPath, entries, backupRoot, opts = {}) {
  if (!entries.length) return { written: [], skipped: [], conflicts: [], backup: null };
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const have = new Map();
  for (const line of existing.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) have.set(m[1], m[2].replace(/^"|"$/g, ""));
  }
  const written = [];
  const skipped = [];
  const conflicts = [];
  const lines = [];
  for (const { manual, var: varName, value } of entries) {
    for (const form of envFormsFor(manual, varName)) {
      if (have.has(form)) {
        (have.get(form) === value ? skipped : conflicts).push(form);
        continue;
      }
      lines.push(`${form}=${value}`);
      have.set(form, value);
      written.push(form);
    }
  }
  if (!lines.length) return { written, skipped, conflicts, backup: null };
  const backup = existsSync(envPath) ? backupFile(envPath, backupRoot, ...stampArgs(opts)) : null;
  const next =
    (existing.length && !existing.endsWith("\n") ? existing + "\n" : existing) +
    `# harvested by host-import ${opts.stamp ?? ""}\n`.trimEnd() + "\n" +
    lines.join("\n") + "\n";
  writeFileSync(envPath, next);
  chmodSync(envPath, 0o600);
  if (backup) pruneBackups(backupRoot);
  return { written, skipped, conflicts, backup };
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
