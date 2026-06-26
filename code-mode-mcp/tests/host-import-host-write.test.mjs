import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toClaudeServer, addToClaudeJson, renderCodexMcpTable, addToCodexToml } from "../scripts/lib/host-import/host-write.mjs";

test("toClaudeServer renders stdio + remote shapes", () => {
  assert.deepEqual(toClaudeServer({ command: "npx", args: ["-y"], env: { A: "1" } }), { type: "stdio", command: "npx", args: ["-y"], env: { A: "1" } });
  assert.deepEqual(toClaudeServer({ url: "https://x/mcp", bearerTokenEnvVar: "TOK" }), { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${TOK}" } });
});

test("addToClaudeJson writes global + project, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "hw-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ mcpServers: {} }));
  addToClaudeJson(p, "memory", { command: "npx" }, join(d, ".bk"), { stamp: "S" });
  addToClaudeJson(p, "gh", { command: "x" }, join(d, ".bk"), { scope: "project", projectKey: "/repo", stamp: "S2" });
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(out.mcpServers.memory.command, "npx");
  assert.equal(out.projects["/repo"].mcpServers.gh.command, "x");
});

test("renderCodexMcpTable emits stdio + remote tables", () => {
  assert.equal(
    renderCodexMcpTable("memory", { command: "npx", args: ["-y", "m"], env: { A: "1" } }),
    '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "m"]\nenv = { A = "1" }\n'
  );
  assert.equal(
    renderCodexMcpTable("ctx", { url: "https://x/mcp", headers: { K: "v" } }),
    '[mcp_servers.ctx]\ntransport = "streamable_http"\nurl = "https://x/mcp"\nhttp_headers = { K = "v" }\n'
  );
});

test("addToCodexToml replaces existing table or appends", () => {
  const d = mkdtempSync(join(tmpdir(), "hw-"));
  const p = join(d, "config.toml");
  writeFileSync(p, '[other]\nk = "v"\n');
  addToCodexToml(p, "memory", { command: "npx" }, join(d, ".bk"), { stamp: "S" });
  const text = readFileSync(p, "utf8");
  assert.ok(text.includes("[other]"));
  assert.ok(text.includes("[mcp_servers.memory]"));
});
