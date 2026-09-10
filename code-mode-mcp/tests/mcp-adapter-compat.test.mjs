import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const load = process.env.MCP_COMPAT_FORMAT === "cjs"
  ? createRequire(import.meta.url)
  : (specifier) => import(specifier);
const { UtcpClient } = await load("@utcp/sdk");
await load("@utcp/mcp");

async function fixtureClient(t, mode = "content") {
  const root = mkdtempSync(join(tmpdir(), "adapter-compat-"));
  const client = await UtcpClient.create(root, { manual_call_templates: [] });
  t.after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  const registration = await client.registerManual({
    name: "fixture",
    call_template_type: "mcp",
    config: {
      mcpServers: {
        child: {
          transport: "stdio",
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/adapter-compat-server.mjs", import.meta.url)), mode]
        }
      }
    }
  });
  assert.equal(registration.success, true, JSON.stringify(registration.errors));
  return client;
}

test("MCP registration normalizes shared boolean schemas without changing keyword booleans", async (t) => {
  const client = await fixtureClient(t, "boolean");
  const tools = await client.getTools();
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    for (const name of ["first", "second"]) {
      const input = tool.inputs.properties[name];
      assert.deepEqual(input.properties.anything, {});
      assert.deepEqual(input.properties.nothing, { not: {} });
      assert.equal(input.uniqueItems, true);
    }
  }
});

test("MCP calls preserve content blocks when structured content is also present", async (t) => {
  const client = await fixtureClient(t);
  assert.deepEqual(await client.callTool("fixture.child.mixed", {}), {
    type: "image", data: "aGk=", mimeType: "image/png"
  });
});

test("MCP structured-only fallback preserves the existing result shape", async (t) => {
  const client = await fixtureClient(t);
  assert.deepEqual(await client.callTool("fixture.child.structured", {}), { result: ["one", "two"] });
});
