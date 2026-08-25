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

test("direct http manual → url server with headers + bearer (p04)", () => {
  const m = {
    name: "typefully",
    config: { mcpServers: { typefully: { url: "https://mcp.typefully.com/mcp", transport: "http", headers: { Authorization: "Bearer ${TYPEFULLY_API_KEY}", "User-Agent": "Claude-User" } } } },
  };
  assert.deepEqual(manualToHostServer(m), {
    name: "typefully",
    server: { url: "https://mcp.typefully.com/mcp", headers: { "User-Agent": "Claude-User" }, bearerTokenEnvVar: "TYPEFULLY_API_KEY" },
  });
});

test("direct http manual round-trips through convertServer (p02+p04)", async () => {
  const { convertServer } = await import("../scripts/lib/host-import/to-utcp.mjs");
  const original = { url: "https://bee.theswarm.com/mcp", headers: { "x-api-key": "${THE_SWARM_API_KEY}" } };
  const conv = convertServer("the-swarm", original);
  assert.equal(conv.risk, "safe");
  const back = manualToHostServer(conv.manual.config.mcpServers["the-swarm"] && conv.manual);
  assert.deepEqual(back.server, original);
});

test("legacy proxy.js mcp-remote wrap → url server", () => {
  const m = {
    name: "zoominfo-mcp",
    config: { mcpServers: { "zoominfo-mcp": { command: "/n/node", args: ["/n/mcp-remote/dist/proxy.js", "https://mcp.zoominfo.com/mcp", "--header", "User-Agent: Claude-User"], env: {}, transport: "stdio" } } },
  };
  assert.deepEqual(manualToHostServer(m), { name: "zoominfo-mcp", server: { url: "https://mcp.zoominfo.com/mcp", headers: { "User-Agent": "Claude-User" } } });
});
