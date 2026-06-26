import { test } from "node:test";
import assert from "node:assert/strict";
import { convertServer, DENYLIST } from "../scripts/lib/host-import/to-utcp.mjs";

test("stdio server → safe direct manual", () => {
  const r = convertServer("memory", { command: "npx", args: ["-y", "m"], env: { A: "1" } });
  assert.equal(r.ok, true);
  assert.equal(r.risk, "safe");
  assert.deepEqual(r.manual, {
    call_template_type: "mcp",
    config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: { A: "1" }, transport: "stdio" } } },
    name: "memory",
  });
});

test("remote server without auth → safe mcp-remote wrap", () => {
  const r = convertServer("context7", { url: "https://mcp.context7.com/mcp" });
  assert.equal(r.risk, "safe");
  assert.deepEqual(r.manual.config.mcpServers.context7, {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.context7.com/mcp"],
    env: {},
    transport: "stdio",
  });
});

test("remote server with header + bearer → partial, headers become --header args", () => {
  const r = convertServer("ctx", {
    url: "https://x/mcp",
    headers: { "X-Key": "abc" },
    bearerTokenEnvVar: "TOK",
  });
  assert.equal(r.risk, "partial");
  assert.deepEqual(r.manual.config.mcpServers.ctx.args, [
    "-y",
    "mcp-remote",
    "https://x/mcp",
    "--header",
    "X-Key: abc",
    "--header",
    "Authorization: Bearer ${TOK}",
  ]);
});

test("denylisted bridge → manual, no manual emitted", () => {
  assert.ok(DENYLIST.has("code-mode"));
  const r = convertServer("code-mode", { command: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.risk, "manual");
  assert.equal(r.manual, undefined);
});

test("server with neither command nor url → manual", () => {
  const r = convertServer("weird", { env: { A: "1" } });
  assert.equal(r.ok, false);
  assert.equal(r.risk, "manual");
});
