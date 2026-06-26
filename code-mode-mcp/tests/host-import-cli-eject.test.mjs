import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../scripts/host-import-cli.mjs";

test("parseArgs reads pins + eject flags", () => {
  const a = parseArgs(["--pin", "memory", "--pin", "codex:ctx", "--eject", "salesforce-mcp", "--to", "claude-code,codex"]);
  assert.deepEqual(a.pins, ["memory", "codex:ctx"]);
  assert.deepEqual(a.eject, ["salesforce-mcp"]);
  assert.deepEqual(a.to, ["claude-code", "codex"]);
});

test("run import honors --pin (pinned server not migrated)", () => {
  const d = mkdtempSync(join(tmpdir(), "clip-"));
  const claudeCode = join(d, ".claude.json");
  const utcpPath = join(d, "u.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: { memory: { command: "x" }, github: { command: "y" } } }));
  writeFileSync(utcpPath, JSON.stringify({ manual_call_templates: [] }, null, 2));
  const opts = {
    ...parseArgs(["--apply", "--pin", "github"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex: join(d, "z.toml") },
    utcpPath,
    backupRoot: join(d, ".bk"),
  };
  run(opts);
  const names = JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["memory"]);
});

test("run eject moves a manual back to a host and out of UTCP", () => {
  const d = mkdtempSync(join(tmpdir(), "clip-"));
  const claudeCode = join(d, ".claude.json");
  const utcpPath = join(d, "u.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(
    utcpPath,
    JSON.stringify({ manual_call_templates: [{ call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: [], env: {}, transport: "stdio" } } } }] }, null, 2)
  );
  const opts = {
    ...parseArgs(["--eject", "memory", "--to", "claude-code"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex: join(d, "z.toml") },
    utcpPath,
    backupRoot: join(d, ".bk"),
  };
  const res = run(opts);
  assert.deepEqual(res.removed, ["memory"]);
  assert.equal(JSON.parse(readFileSync(claudeCode, "utf8")).mcpServers.memory.command, "npx");
  assert.deepEqual(JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates, []);
});
