import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, renderPlanText, run } from "../scripts/host-import-cli.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "cli-"));
  const claudeCode = join(d, ".claude.json");
  const claudeDesktop = join(d, "desktop.json");
  const codex = join(d, "config.toml");
  const utcpPath = join(d, "hide.utcp_config.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", "m"] } } }));
  writeFileSync(claudeDesktop, JSON.stringify({ mcpServers: {} }));
  writeFileSync(codex, '[mcp_servers.context7]\nurl = "https://x/mcp"\n');
  writeFileSync(utcpPath, JSON.stringify({ manual_call_templates: [] }, null, 2));
  return { d, claudeCode, claudeDesktop, codex, utcpPath, backupRoot: join(d, ".bk") };
}

test("parseArgs defaults to dry-run", () => {
  const a = parseArgs([]);
  assert.equal(a.apply, false);
  assert.equal(a.stripHost, false);
  assert.deepEqual(a.risks, ["safe", "partial"]);
});

test("parseArgs reads flags", () => {
  const a = parseArgs(["--apply", "--strip-host", "--risk", "safe", "--only", "memory,github"]);
  assert.equal(a.apply, true);
  assert.equal(a.stripHost, true);
  assert.deepEqual(a.risks, ["safe"]);
  assert.deepEqual(a.only, ["memory", "github"]);
});

test("parseArgs host-path overrides replace defaults (for safe strip/eject rehearsal)", () => {
  const a = parseArgs([
    "--claude-code-path", "/tmp/cc.json",
    "--claude-desktop-path", "/tmp/cd.json",
    "--codex-path", "/tmp/cx.toml",
  ]);
  assert.equal(a.paths.claudeCode, "/tmp/cc.json");
  assert.equal(a.paths.claudeDesktop, "/tmp/cd.json");
  assert.equal(a.paths.codex, "/tmp/cx.toml");
  // unset overrides keep the real default locations
  const d = parseArgs([]);
  assert.ok(d.paths.claudeCode.endsWith("/.claude.json"));
  assert.ok(d.paths.codex.endsWith("/.codex/config.toml"));
});

test("run dry-run produces a plan and writes nothing", () => {
  const fx = fixture();
  const opts = { ...parseArgs([]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  const res = run(opts);
  assert.equal(res.applied, undefined);
  assert.equal(res.plan.items.length, 2);
  const text = renderPlanText(res.plan);
  assert.match(text, /memory/);
  assert.match(text, /context7/);
  // UTCP config untouched
  assert.deepEqual(JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates, []);
});

test("run --apply writes manuals into the UTCP config", () => {
  const fx = fixture();
  const opts = { ...parseArgs(["--apply"]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  const res = run(opts);
  assert.deepEqual(res.applied.added.sort(), ["context7", "memory"]);
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name).sort();
  assert.deepEqual(names, ["context7", "memory"]);
});

test("run --apply --strip-host removes from host configs", () => {
  const fx = fixture();
  const opts = { ...parseArgs(["--apply", "--strip-host"]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  run(opts);
  assert.deepEqual(JSON.parse(readFileSync(fx.claudeCode, "utf8")).mcpServers, {});
  assert.ok(!readFileSync(fx.codex, "utf8").includes("[mcp_servers.context7]"));
});
