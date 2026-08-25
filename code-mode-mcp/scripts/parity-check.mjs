#!/usr/bin/env node
// Parity harness (plan #005 p05) — the gate for config migrations and the
// Worker-bridge export. Registers every manual via discoverManuals() (which
// already retries empty manuals with per-manual diagnostics, so a slow remote
// registration cannot masquerade as a lost namespace — the plan #004 d04
// finding), prints per-manual tool counts, and optionally diffs against a
// saved baseline.
//
//   npm run parity                              # discover + report
//   npm run parity -- --save baseline.json      # also save a baseline snapshot
//   npm run parity -- --baseline baseline.json  # diff against a snapshot
//   npm run parity -- --json                    # machine-readable output
//   npm run parity -- /abs/other.utcp_config.json
//
// Exit codes: 0 clean · 1 structural errors, failed registrations, or
// namespaces lost relative to the baseline.

import { promises as fs } from "fs";
import process from "process";
import { discoverManuals, resolveConfigPath } from "./lib/utcp-config.mjs";

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const baselinePath = flagValue(args, "--baseline");
const savePath = flagValue(args, "--save");

// Positional config path: the first arg that is neither a flag nor a flag's
// value. resolveConfigPath's own argv scan doesn't know this script's flags
// (--save/--baseline take values), so suppress it with a bare argv and pass
// the positional explicitly — env/.env resolution still applies when absent.
const VALUE_FLAGS = new Set(["--baseline", "--save"]);
let positional;
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i])) { i++; continue; }
  if (!args[i].startsWith("-")) { positional = args[i]; break; }
}
const configPath = resolveConfigPath(positional, { argv: process.argv.slice(0, 2) });
const log = jsonOut ? () => {} : (m) => console.error(m);

const result = await discoverManuals(configPath, log);

const snapshot = {};
for (const m of result.manuals) snapshot[m.name] = m.tools.length;

let failures = 0;
const problems = [];
for (const m of result.manuals) {
  const d = m.diagnostics ?? {};
  if (d.structureValid === false) {
    failures++;
    problems.push({ manual: m.name, kind: "invalid-template", errors: d.errors });
  } else if (d.registered === false) {
    failures++;
    problems.push({ manual: m.name, kind: "registration-failed", errors: d.errors });
  }
}

let diff = null;
if (baselinePath) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  const base = baseline.manuals ?? baseline; // accept bare {name:count} too
  diff = { lost: [], gained: [], shrunk: [], grown: [] };
  for (const [name, count] of Object.entries(base)) {
    const now = snapshot[name] ?? 0;
    if (count > 0 && now === 0) diff.lost.push(name);
    else if (now < count) diff.shrunk.push({ manual: name, was: count, now });
    else if (now > count) diff.grown.push({ manual: name, was: count, now });
  }
  for (const name of Object.keys(snapshot)) {
    if (!(name in base) && snapshot[name] > 0) diff.gained.push(name);
  }
  failures += diff.lost.length;
}

if (savePath) {
  await fs.writeFile(savePath, JSON.stringify({ configPath, savedAt: null, manuals: snapshot }, null, 2) + "\n");
}

if (jsonOut) {
  console.log(JSON.stringify({ configPath, toolCount: result.toolCount, manuals: snapshot, problems, diff }, null, 2));
} else {
  console.log(`\nconfig: ${configPath}`);
  console.log(`tools:  ${result.toolCount} across ${result.manuals.filter((m) => m.tools.length).length} manual(s)`);
  const width = Math.max(...result.manuals.map((m) => m.name.length));
  for (const m of [...result.manuals].sort((a, b) => a.name.localeCompare(b.name))) {
    const d = m.diagnostics ?? {};
    const mark = d.structureValid === false ? "✗ invalid" : d.registered === false ? "✗ failed" : m.tools.length === 0 ? "· empty" : "✓";
    console.log(`  ${m.name.padEnd(width)}  ${String(m.tools.length).padStart(4)}  ${mark}`);
  }
  for (const p of problems) console.log(`\n${p.manual}: ${p.kind}\n  ${(p.errors ?? []).join("\n  ").slice(0, 500)}`);
  if (diff) {
    if (diff.lost.length) console.log(`\nLOST vs baseline: ${diff.lost.join(", ")}`);
    if (diff.shrunk.length) console.log(`shrunk: ${diff.shrunk.map((s) => `${s.manual} ${s.was}→${s.now}`).join(", ")}`);
    if (diff.gained.length) console.log(`gained: ${diff.gained.join(", ")}`);
    if (!diff.lost.length && !diff.shrunk.length) console.log("\nbaseline: no losses ✓");
  }
}

process.exit(failures ? 1 : 0);
