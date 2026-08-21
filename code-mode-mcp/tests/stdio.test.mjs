import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(projectRoot, "dist", "index.js");

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.UTCP_CONFIG_FILE;
  delete environment.UTCP_CONFIG_PATH;
  return { ...environment, ...overrides };
}

test("packed server seam completes real stdio handshake with canonical wire", async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "code-mode-mcp-stdio-"));
  const configPath = join(fixtureDir, ".utcp_config.json");
  writeFileSync(configPath, JSON.stringify({ manual_call_templates: [] }));
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: fixtureDir,
    env: cleanEnvironment({ UTCP_CONFIG_FILE: configPath }),
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "code-mode-mcp-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });

  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), {
    name: "@itsbrex/code-mode-mcp",
    version: "1.3.0"
  });
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "register_manual",
      "deregister_manual",
      "search_tools",
      "list_tools",
      "get_required_keys_for_tool",
      "tools_info",
      "call_tool_chain",
      "get_required_variables_for_tool"
    ]
  );
  const canonicalSnapshot = JSON.parse(
    readFileSync(
      join(projectRoot, "tests", "fixtures", "canonical-wire-1.2.1.json"),
      "utf8"
    )
  );
  assert.deepEqual(listed.tools.slice(0, 7), canonicalSnapshot);

  const result = await client.callTool({ name: "list_tools", arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { tools: [] });

  const timeoutResult = await client.callTool({
    name: "call_tool_chain",
    arguments: {
      code: "await new Promise(() => {}); return 'unreachable';",
      timeout: 50,
      max_output_size: 1_000
    }
  });
  assert.equal(timeoutResult.isError, undefined);
  const timeoutPayload = JSON.parse(timeoutResult.content[0].text);
  assert.equal(timeoutPayload.success, true);
  assert.equal(timeoutPayload.nonMcpContentResults, null);
  assert.match(timeoutPayload.logs.join("\n"), /timeout after 50ms/i);

  assert.equal(stderr.join("").includes("Failed to start"), false);
});

test("stdio calls fail closed on divergent config variables without protocol noise", async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "code-mode-mcp-conflict-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: fixtureDir,
    env: cleanEnvironment({
      UTCP_CONFIG_FILE: join(fixtureDir, "canonical.json"),
      UTCP_CONFIG_PATH: join(fixtureDir, "legacy.json")
    }),
    stderr: "pipe"
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "code-mode-mcp-conflict-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });

  await client.connect(transport);
  const result = await client.callTool({ name: "list_tools", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Conflicting UTCP config paths/);
  assert.equal(stderr.join("").includes("Unexpected token"), false);
});
