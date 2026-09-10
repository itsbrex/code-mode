import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodeModeBridge, convertServer } from "../scripts/lib/host-import/to-utcp.mjs";
import { buildPlan } from "../scripts/lib/host-import/plan.mjs";

test("isCodeModeBridge: exact-name denylist", () => {
  assert.equal(isCodeModeBridge("code-mode", { command: "node" }), true);
  assert.equal(isCodeModeBridge("attio-code-mode-mcp", {}), true);
});

test("isCodeModeBridge: code-mode substring in command/args (paths, packages, env files)", () => {
  assert.equal(isCodeModeBridge("linkedin", {
    command: "/usr/local/bin/op",
    args: ["run", "--env-file=/x/linkedin-code-mode-mcp/.env", "--", "node", "dist/index.js"]
  }), true);
  assert.equal(isCodeModeBridge("x", { command: "npx", args: ["-y", "@itsbrex/code-mode-mcp"] }), true);
});

test("isCodeModeBridge: UTCP config env vars", () => {
  assert.equal(isCodeModeBridge("anything", { command: "node", args: ["/srv/app.js"], env: { UTCP_CONFIG_FILE: "/x.json" } }), true);
  assert.equal(isCodeModeBridge("anything", { command: "node", env: { UTCP_CONFIG_PATH: "/x.json" } }), true);
});

test("isCodeModeBridge: content probe finds wire markers in the entry script", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  const entry = join(d, "index.js");
  writeFileSync(entry, 'server.tool("call_tool_chain", async () => {});\n');
  assert.equal(isCodeModeBridge("mybridge", { command: "node", args: [entry] }), true);
});

test("isCodeModeBridge: content probe follows relative imports one level", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  mkdirSync(join(d, "server"));
  const entry = join(d, "index.js");
  writeFileSync(entry, 'import { startStdioServer } from "./server/stdio.js";\nstartStdioServer();\n');
  writeFileSync(join(d, "server", "stdio.js"), 'registerTool("call_tool_chain");\n');
  assert.equal(isCodeModeBridge("forked-bridge", { command: "node", args: [entry] }), true);
});

test("isCodeModeBridge: plain servers stay plain", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  const entry = join(d, "plain.js");
  writeFileSync(entry, 'import { x } from "./missing.js";\nconsole.log("hello mcp server");\n');
  assert.equal(isCodeModeBridge("memory", { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }), false);
  assert.equal(isCodeModeBridge("local", { command: "node", args: [entry] }), false);
  assert.equal(isCodeModeBridge("remote", { url: "https://mcp.context7.com/mcp" }), false);
});

test("convertServer refuses a detected bridge with bridge:true", () => {
  const conv = convertServer("brandjet", { command: "node", args: ["/x.js"], env: { UTCP_CONFIG_FILE: "/c.json" } });
  assert.equal(conv.ok, false);
  assert.equal(conv.bridge, true);
  assert.match(conv.reason, /auto-detected/);
});

test("buildPlan: bridge outranks duplicate — never migratable, reason says bridge", () => {
  const hosts = [{
    host: "claude-code", scope: "global", name: "hookmark",
    server: { command: "node", args: ["/x/hook.js"], env: { UTCP_CONFIG_FILE: "/c.json" } }
  }];
  const utcp = { manual_call_templates: [{ name: "hookmark" }] }; // federated name collision
  const { items } = buildPlan(hosts, utcp, []);
  assert.equal(items[0].bridge, true);
  assert.equal(items[0].duplicate, true);
  assert.equal(items[0].manual, undefined);
  assert.match(items[0].reason, /bridge/);
});
