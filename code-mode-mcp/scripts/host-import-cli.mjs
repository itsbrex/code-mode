#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readAllHosts, defaultHostPaths } from "./lib/host-import/read-hosts.mjs";
import { buildPlan, selectManuals, readUtcpConfig } from "./lib/host-import/plan.mjs";
import { addManualsToUtcp, stripFromClaudeJson, stripFromCodexToml } from "./lib/host-import/apply.mjs";
import { loadPins } from "./lib/host-import/pins.mjs";
import { ejectManuals } from "./lib/host-import/eject.mjs";
import { resolveConfigPath } from "./lib/utcp-config.mjs";

// resolveConfigPath throws when no UTCP_CONFIG_PATH/UTCP_CONFIG_FILE is set
// (env or .env). Tests construct opts with an explicit utcpPath, so swallow the
// throw here and let main()'s --apply guard surface a clear message instead.
function safeResolveConfigPath() {
  try {
    return resolveConfigPath();
  } catch {
    return "";
  }
}

export function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const risk = val("--risk");
  const only = val("--only");
  const home = process.env.HOME || "";
  return {
    apply: has("--apply"),
    stripHost: has("--strip-host"),
    risks: risk ? risk.split(",").map((s) => s.trim()).filter(Boolean) : ["safe", "partial"],
    only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    pinsFile: val("--pins-file") || `${process.env.HOME || ""}/.host-import-pins.json`,
    pins: argv.reduce((acc, a, i) => (a === "--pin" && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []),
    eject: val("--eject") ? val("--eject").split(",").map((s) => s.trim()).filter(Boolean) : null,
    to: val("--to") ? val("--to").split(",").map((s) => s.trim()).filter(Boolean) : ["claude-code"],
    paths: defaultHostPaths(home),
    utcpPath: safeResolveConfigPath(),
    backupRoot: path.join(home, ".host-import-backups"),
  };
}

export function renderPlanText(plan) {
  const lines = [];
  for (const it of plan.items) {
    const tag = it.duplicate ? "dup " : it.risk.padEnd(4);
    lines.push(`  [${tag}] ${it.host.padEnd(13)} ${it.name.padEnd(28)} ${it.reason}`);
  }
  const sel = selectManuals(plan).length;
  lines.push(`\n  ${plan.items.length} server(s) discovered · ${sel} migratable (non-duplicate safe/partial)`);
  return lines.join("\n");
}

export function run(opts) {
  if (opts.eject && opts.eject.length) {
    const targets = opts.to.map((host) => ({ host, scope: "global" }));
    return ejectManuals(opts.utcpPath, opts.eject, targets, opts.paths, opts.backupRoot);
  }

  let hosts = readAllHosts(opts.paths);
  if (opts.only) {
    const want = new Set(opts.only);
    hosts = hosts.filter((h) => want.has(h.name));
  }
  const utcp = readUtcpConfig(opts.utcpPath);
  const plan = buildPlan(hosts, utcp, loadPins(opts.pinsFile, opts.pins));
  if (!opts.apply) return { plan };

  const manuals = selectManuals(plan, { risks: opts.risks });
  const applied = addManualsToUtcp(opts.utcpPath, manuals, opts.backupRoot);

  const result = { plan, applied };
  if (opts.stripHost) {
    const migrated = new Set(applied.added);
    const stripped = [];
    // group migrated source entries by host/scope so we strip from the right place
    for (const item of plan.items) {
      if (!migrated.has(item.name)) continue;
      if (item.host === "codex") {
        const r = stripFromCodexToml(opts.paths.codex, [item.name], opts.backupRoot);
        stripped.push({ host: "codex", name: item.name, removed: r.removed });
      } else if (item.host === "claude-desktop") {
        const r = stripFromClaudeJson(opts.paths.claudeDesktop, [item.name], opts.backupRoot, { scope: "global" });
        stripped.push({ host: "claude-desktop", name: item.name, removed: r.removed });
      } else {
        const r = stripFromClaudeJson(opts.paths.claudeCode, [item.name], opts.backupRoot, { scope: item.scope, projectKey: item.projectKey });
        stripped.push({ host: "claude-code", name: item.name, removed: r.removed });
      }
    }
    result.stripped = stripped;
  }
  return result;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.stripHost && !opts.apply) {
    console.error("Refusing to --strip-host without --apply (nothing migrated yet).");
    process.exit(1);
  }
  if (opts.apply && !existsSync(opts.utcpPath)) {
    console.error(`Refusing to --apply: UTCP config not found at ${opts.utcpPath}`);
    process.exit(1);
  }
  const res = run(opts);
  if (res.ejected) {
    for (const e of res.ejected) console.log(`Ejected ${e.name} → ${e.wroteTo.join(", ")}`);
    console.log(`Removed ${res.removed.length} manual(s) from ${opts.utcpPath}`);
    return;
  }
  console.log(renderPlanText(res.plan));
  if (res.applied) {
    console.log(`\nApplied: +${res.applied.added.length} manual(s) → ${opts.utcpPath}`);
    if (res.applied.backup) console.log(`Backup: ${res.applied.backup}`);
  }
  if (res.stripped) {
    const n = res.stripped.reduce((a, s) => a + s.removed.length, 0);
    console.log(`Stripped ${n} server(s) from host configs (backed up).`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main();
}
