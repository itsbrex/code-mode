import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripFromClaudeJson, stripFromCodexToml } from "../scripts/lib/host-import/apply.mjs";

test("stripFromClaudeJson removes global servers, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }));
  const res = stripFromClaudeJson(p, ["a"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, ["a"]);
  assert.ok(res.backup);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(Object.keys(out.mcpServers), ["b"]);
});

test("stripFromClaudeJson removes project-scoped servers", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ projects: { "/repo": { mcpServers: { gh: { command: "x" } } } } }));
  const res = stripFromClaudeJson(p, ["gh"], join(d, ".bk"), { scope: "project", projectKey: "/repo", stamp: "S" });
  assert.deepEqual(res.removed, ["gh"]);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(out.projects["/repo"].mcpServers, {});
});

test("stripFromCodexToml removes a [mcp_servers.X] table and nested tool tables", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, "config.toml");
  writeFileSync(
    p,
    [
      "[other]",
      'k = "v"',
      "",
      "[mcp_servers.memory]",
      'command = "npx"',
      "",
      "[mcp_servers.context7]",
      'url = "https://x/mcp"',
      "",
      "[mcp_servers.context7.tools.foo]",
      'approval_mode = "never"',
      "",
    ].join("\n")
  );
  const res = stripFromCodexToml(p, ["context7"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, ["context7"]);
  const text = readFileSync(p, "utf8");
  assert.ok(text.includes("[mcp_servers.memory]"));
  assert.ok(!text.includes("[mcp_servers.context7]"));
  assert.ok(!text.includes("mcp_servers.context7.tools.foo"));
  assert.ok(text.includes("[other]"));
});
