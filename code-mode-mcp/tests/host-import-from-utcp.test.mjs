import { test } from "node:test";
import assert from "node:assert/strict";
import { manualToHostServer } from "../scripts/lib/host-import/from-utcp.mjs";

test("stdio manual → command/args/env server", () => {
  const m = { name: "memory", config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: { A: "1" }, transport: "stdio" } } } };
  assert.deepEqual(manualToHostServer(m), { name: "memory", server: { command: "npx", args: ["-y", "m"], env: { A: "1" } } });
});

test("npx mcp-remote wrap → url server with headers + bearer", () => {
  const m = {
    name: "ctx",
    config: { mcpServers: { ctx: { command: "npx", args: ["-y", "mcp-remote", "https://x/mcp", "--header", "X-Key: abc", "--header", "Authorization: Bearer ${TOK}"], env: {}, transport: "stdio" } } },
  };
  assert.deepEqual(manualToHostServer(m), { name: "ctx", server: { url: "https://x/mcp", headers: { "X-Key": "abc" }, bearerTokenEnvVar: "TOK" } });
});

test("legacy proxy.js mcp-remote wrap → url server", () => {
  const m = {
    name: "zoominfo-mcp",
    config: { mcpServers: { "zoominfo-mcp": { command: "/n/node", args: ["/n/mcp-remote/dist/proxy.js", "https://mcp.zoominfo.com/mcp", "--header", "User-Agent: Claude-User"], env: {}, transport: "stdio" } } },
  };
  assert.deepEqual(manualToHostServer(m), { name: "zoominfo-mcp", server: { url: "https://mcp.zoominfo.com/mcp", headers: { "User-Agent": "Claude-User" } } });
});
