import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSources,
  recordSources,
  removeSources,
  stableStringify
} from "../scripts/lib/host-import/sources.mjs";
import { parseArgs, run } from "../scripts/host-import-cli.mjs";

test("stableStringify is key-order independent", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: [2, { z: 3, y: 4 }], c: null } }),
    stableStringify({ a: { c: null, d: [2, { y: 4, z: 3 }] }, b: 1 })
  );
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("recordSources merges unique host/scope entries; removeSources drops them", () => {
  const d = mkdtempSync(join(tmpdir(), "his-"));
  const f = join(d, "sources.json");
  recordSources(f, "memory", "/u.json", [{ host: "claude-code", scope: "global", name: "memory" }]);
  recordSources(f, "memory", "/u.json", [
    { host: "claude-code", scope: "global", name: "memory" }, // duplicate — ignored
    { host: "codex", scope: "global", name: "memory" }
  ]);
  const all = loadSources(f);
  assert.deepEqual(all.memory.sources.map((s) => s.host), ["claude-code", "codex"]);
  assert.equal(all.memory.utcpPath, "/u.json");
  removeSources(f, ["memory"]);
  assert.deepEqual(loadSources(f), {});
});

test("parseArgs: --to defaults to null (provenance routing); --sources-file overrides", () => {
  assert.equal(parseArgs(["--eject", "memory"]).to, null);
  assert.deepEqual(parseArgs(["--eject", "m", "--to", "codex"]).to, ["codex"]);
  assert.equal(parseArgs(["--sources-file", "/tmp/s.json"]).sourcesFile, "/tmp/s.json");
});

test("apply records provenance for every host holding an identical config", () => {
  const d = mkdtempSync(join(tmpdir(), "his-"));
  const claudeCode = join(d, ".claude.json");
  const codex = join(d, "config.toml");
  const utcpPath = join(d, "u.json");
  const spec = { command: "npx", args: ["-y", "server-memory"] };
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: { memory: spec } }));
  writeFileSync(codex, `[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "server-memory"]\n`);
  writeFileSync(utcpPath, JSON.stringify({ manual_call_templates: [] }, null, 2));
  const opts = {
    ...parseArgs(["--apply"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex },
    utcpPath,
    backupRoot: join(d, ".bk"),
    pinsFile: join(d, "pins.json"),
    sourcesFile: join(d, "sources.json")
  };
  run(opts);
  const names = JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["memory"]); // one import, not two
  const sources = loadSources(opts.sourcesFile);
  assert.deepEqual(sources.memory.sources.map((s) => s.host).sort(), ["claude-code", "codex"]);
});

test("eject without --to routes back to the recorded source hosts and clears provenance", () => {
  const d = mkdtempSync(join(tmpdir(), "his-"));
  const claudeCode = join(d, ".claude.json");
  const codex = join(d, "config.toml");
  const utcpPath = join(d, "u.json");
  const sourcesFile = join(d, "sources.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(codex, "");
  writeFileSync(
    utcpPath,
    JSON.stringify({ manual_call_templates: [{ call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: [], env: {}, transport: "stdio" } } } }] }, null, 2)
  );
  recordSources(sourcesFile, "memory", utcpPath, [
    { host: "claude-code", scope: "global", name: "memory" },
    { host: "codex", scope: "global", name: "memory" }
  ]);
  const opts = {
    ...parseArgs(["--eject", "memory"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex },
    utcpPath,
    backupRoot: join(d, ".bk"),
    pinsFile: join(d, "pins.json"),
    sourcesFile
  };
  const res = run(opts);
  assert.deepEqual(res.removed, ["memory"]);
  assert.equal(res.ejected[0].fromProvenance, true);
  assert.deepEqual(res.ejected.flatMap((e) => e.wroteTo).sort(), ["claude-code", "codex"]);
  assert.equal(JSON.parse(readFileSync(claudeCode, "utf8")).mcpServers.memory.command, "npx");
  assert.match(readFileSync(codex, "utf8"), /\[mcp_servers\.memory\]/);
  assert.deepEqual(JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates, []);
  assert.deepEqual(loadSources(sourcesFile), {}); // provenance consumed
});

test("eject without --to and no provenance falls back to claude-code", () => {
  const d = mkdtempSync(join(tmpdir(), "his-"));
  const claudeCode = join(d, ".claude.json");
  const utcpPath = join(d, "u.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(
    utcpPath,
    JSON.stringify({ manual_call_templates: [{ call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: [], env: {}, transport: "stdio" } } } }] }, null, 2)
  );
  const opts = {
    ...parseArgs(["--eject", "memory"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex: join(d, "z.toml") },
    utcpPath,
    backupRoot: join(d, ".bk"),
    pinsFile: join(d, "pins.json"),
    sourcesFile: join(d, "sources.json")
  };
  const res = run(opts);
  assert.deepEqual(res.ejected[0].wroteTo, ["claude-code"]);
  assert.equal(res.ejected[0].fromProvenance, false);
  assert.equal(existsSync(join(d, "sources.json")), false); // nothing was ever recorded
});
