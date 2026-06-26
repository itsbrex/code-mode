import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeServer,
  parseInlineTomlObject,
  parseStringArray,
  readClaudeCode,
  readClaudeDesktop,
  readCodex,
  readAllHosts,
} from "../scripts/lib/host-import/read-hosts.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "hostimport-"));
}

test("normalizeServer keeps command/args/env/url/headers, drops junk", () => {
  assert.deepEqual(
    normalizeServer({ command: "node", args: ["x", 1], env: { A: "1" }, junk: true }),
    { command: "node", args: ["x"], env: { A: "1" } }
  );
  assert.deepEqual(
    normalizeServer({ url: "https://x/mcp", bearer_token_env_var: "TOK" }),
    { url: "https://x/mcp", bearerTokenEnvVar: "TOK" }
  );
  assert.equal(normalizeServer(null), null);
});

test("parseInlineTomlObject + parseStringArray", () => {
  assert.deepEqual(parseInlineTomlObject('{ A = "1", B = "two" }'), { A: "1", B: "two" });
  assert.deepEqual(parseStringArray('["-y", "pkg"]'), ["-y", "pkg"]);
  assert.deepEqual(parseStringArray('["a", 2, "b"]'), ["a", "b"]);
});

test("readClaudeCode reads global + project mcpServers", () => {
  const d = tmp();
  const p = join(d, ".claude.json");
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: { memory: { command: "npx", args: ["-y", "server-memory"] } },
      projects: { "/repo": { mcpServers: { github: { command: "gh-mcp" } } } },
    })
  );
  const out = readClaudeCode(p);
  assert.equal(out.length, 2);
  const memory = out.find((e) => e.name === "memory");
  assert.deepEqual(memory, {
    host: "claude-code",
    scope: "global",
    name: "memory",
    server: { command: "npx", args: ["-y", "server-memory"] },
  });
  const github = out.find((e) => e.name === "github");
  assert.equal(github.scope, "project");
  assert.equal(github.projectKey, "/repo");
});

test("readClaudeDesktop reads mcpServers", () => {
  const d = tmp();
  const p = join(d, "claude_desktop_config.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { hookmark: { command: "node", args: ["i.js"] } } }));
  const out = readClaudeDesktop(p);
  assert.deepEqual(out, [
    { host: "claude-desktop", scope: "global", name: "hookmark", server: { command: "node", args: ["i.js"] } },
  ]);
});

test("readCodex parses [mcp_servers.X] TOML tables incl. remote", () => {
  const d = tmp();
  const p = join(d, "config.toml");
  writeFileSync(
    p,
    [
      "[mcp_servers.memory]",
      'command = "npx"',
      'args = ["-y","@modelcontextprotocol/server-memory"]',
      'env = { MEMORY_FILE_PATH = "/x/m.jsonl" }',
      "",
      "[mcp_servers.context7]",
      'transport = "streamable_http"',
      'url = "https://mcp.context7.com/mcp"',
      'http_headers = { CONTEXT7_API_KEY = "ctx7sk-abc" }',
      "",
      // A non-mcp table after the last server — its `command` must NOT leak
      // into context7's body.
      "[history]",
      'command = "should-not-leak"',
      "",
      // Nested env sub-table (real Codex node_repl shape) — folds into parent.
      "[mcp_servers.node_repl]",
      'command = "/r/node_repl"',
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      'A = "1"',
      'B = "2"',
      "",
      // Disabled server — must be skipped (migrating would re-activate it).
      "[mcp_servers.disabledsrv]",
      'command = "x"',
      "enabled = false",
      "",
    ].join("\n")
  );
  const out = readCodex(p);
  assert.equal(out.length, 3); // [history] not a server; disabledsrv skipped
  const memory = out.find((e) => e.name === "memory");
  assert.deepEqual(memory.server, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { MEMORY_FILE_PATH: "/x/m.jsonl" },
  });
  const context7 = out.find((e) => e.name === "context7");
  assert.deepEqual(context7.server, {
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "ctx7sk-abc" },
  });
  const nodeRepl = out.find((e) => e.name === "node_repl");
  assert.deepEqual(nodeRepl.server, { command: "/r/node_repl", args: [], env: { A: "1", B: "2" } });
  assert.equal(out.find((e) => e.name === "disabledsrv"), undefined);
});

test("readAllHosts tolerates missing files", () => {
  const out = readAllHosts({ claudeCode: "/nope/a.json", claudeDesktop: "/nope/b.json", codex: "/nope/c.toml" });
  assert.deepEqual(out, []);
});
