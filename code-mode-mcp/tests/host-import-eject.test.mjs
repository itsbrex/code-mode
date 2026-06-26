import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeManualsFromUtcp, ejectManuals } from "../scripts/lib/host-import/eject.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "eject-"));
  const utcpPath = join(d, "hide.utcp_config.json");
  const claudeCode = join(d, ".claude.json");
  const codex = join(d, "config.toml");
  writeFileSync(
    utcpPath,
    JSON.stringify({
      manual_call_templates: [
        { call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: {}, transport: "stdio" } } } },
        { call_template_type: "mcp", name: "keep", config: { mcpServers: { keep: { command: "x", args: [], env: {}, transport: "stdio" } } } },
      ],
    }, null, 2)
  );
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(codex, "");
  return { d, utcpPath, claudeCode, codex, backupRoot: join(d, ".bk") };
}

test("removeManualsFromUtcp drops named templates, backs up", () => {
  const fx = fixture();
  const res = removeManualsFromUtcp(fx.utcpPath, ["memory"], fx.backupRoot, { stamp: "S" });
  assert.deepEqual(res.removed, ["memory"]);
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["keep"]);
});

test("ejectManuals writes server to targets and removes from UTCP", () => {
  const fx = fixture();
  const hostPaths = { claudeCode: fx.claudeCode, claudeDesktop: join(fx.d, "desktop.json"), codex: fx.codex };
  const res = ejectManuals(
    fx.utcpPath,
    ["memory"],
    [{ host: "claude-code", scope: "global" }, { host: "codex" }],
    hostPaths,
    fx.backupRoot,
    { stamp: "S" }
  );
  assert.deepEqual(res.removed, ["memory"]);
  assert.deepEqual(res.ejected[0].wroteTo.sort(), ["claude-code", "codex"]);
  // host configs received the server
  assert.equal(JSON.parse(readFileSync(fx.claudeCode, "utf8")).mcpServers.memory.command, "npx");
  assert.ok(readFileSync(fx.codex, "utf8").includes("[mcp_servers.memory]"));
  // removed from UTCP
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["keep"]);
});
