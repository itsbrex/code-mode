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

test("manual identifier is sanitized while original host name remains as provenance", () => {
  const r = convertServer("my-server.one", { command: "node", args: ["server.js"] });
  assert.equal(r.manual.name, "my_server_one");
  assert.deepEqual(Object.keys(r.manual.config.mcpServers), ["my-server.one"]);
});

test("remote server without auth → direct http manual, partial (may be OAuth-gated)", () => {
  const r = convertServer("context7", { url: "https://mcp.context7.com/mcp" });
  assert.equal(r.risk, "partial");
  assert.deepEqual(r.manual.config.mcpServers.context7, {
    url: "https://mcp.context7.com/mcp",
    transport: "http",
  });
});

test("remote server with header + bearer → safe direct http manual with headers", () => {
  const r = convertServer("ctx", {
    url: "https://x/mcp",
    headers: { "X-Key": "abc" },
    bearerTokenEnvVar: "TOK",
  });
  assert.equal(r.risk, "safe");
  assert.deepEqual(r.manual.config.mcpServers.ctx, {
    url: "https://x/mcp",
    transport: "http",
    headers: { "X-Key": "abc", Authorization: "Bearer ${TOK}" },
  });
});

test("wrapRemote forces the mcp-remote stdio wrapper (OAuth endpoints)", () => {
  const r = convertServer(
    "cloudflare-api",
    { url: "https://mcp.cloudflare.com/mcp", headers: { "X-Key": "abc" } },
    { wrapRemote: true },
  );
  assert.equal(r.risk, "partial");
  assert.deepEqual(r.manual.config.mcpServers["cloudflare-api"], {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.cloudflare.com/mcp", "--header", "X-Key: abc"],
    env: {},
    transport: "stdio",
  });
});

test("literal env secrets are harvested to ${VAR} refs (p03)", () => {
  const r = convertServer("svc", {
    command: "npx",
    args: ["-y", "svc-mcp"],
    env: { SVC_API_KEY: "sk_live_0123456789abcdef", SVC_RETRY_MAX: "5" },
  });
  assert.deepEqual(r.manual.config.mcpServers.svc.env, {
    SVC_API_KEY: "${SVC_API_KEY}",
    SVC_RETRY_MAX: "5",
  });
  assert.deepEqual(r.harvested, [
    { var: "SVC_API_KEY", value: "sk_live_0123456789abcdef", from: "env SVC_API_KEY" },
  ]);
});

test("literal header secrets are harvested, Bearer prefix preserved (p03)", () => {
  const r = convertServer("svc", {
    url: "https://x/mcp",
    headers: {
      Authorization: "Bearer sk_live_0123456789abcdef",
      "x-api-key": "0123456789abcdef0123",
      "User-Agent": "Claude-User",
    },
  });
  assert.deepEqual(r.manual.config.mcpServers.svc.headers, {
    Authorization: "Bearer ${SVC_AUTHORIZATION}",
    "x-api-key": "${SVC_X_API_KEY}",
    "User-Agent": "Claude-User",
  });
  assert.equal(r.harvested.length, 2);
  assert.equal(r.risk, "safe");
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
