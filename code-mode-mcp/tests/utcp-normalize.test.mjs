import test from "node:test";
import assert from "node:assert/strict";
import {
  inferMcpTransport,
  normalizeManualCallTemplate,
  normalizeUtcpConfig
} from "../dist/utcp-normalize.js";

test("infers mcp transport from the server shape", () => {
  assert.equal(inferMcpTransport({ command: "uv", args: ["run", "x"] }), "stdio");
  assert.equal(inferMcpTransport({ url: "https://example.com/mcp" }), "http");
  assert.equal(inferMcpTransport({ url: "https://example.com/sse", type: "sse" }), "http");
  assert.equal(inferMcpTransport({}), undefined);
});

test("config normalization fills transport and auth_tools without mutating input", () => {
  const raw = {
    manual_call_templates: [
      {
        name: "keep",
        call_template_type: "mcp",
        config: { mcpServers: { keep: { url: "https://keep.md/mcp" } } }
      },
      {
        name: "keep_rest",
        call_template_type: "http",
        url: "https://keep.md/openapi.json",
        auth: {
          auth_type: "api_key",
          api_key: "Bearer ${KEEP_API_KEY}",
          var_name: "Authorization",
          location: "header"
        }
      }
    ]
  };
  const { value, changes } = normalizeUtcpConfig(raw);

  assert.equal(value.manual_call_templates[0].config.mcpServers.keep.transport, "http");
  // `auth` only authenticates the OpenAPI spec fetch; tools carry `auth_tools`.
  assert.deepEqual(value.manual_call_templates[1].auth_tools, raw.manual_call_templates[1].auth);
  assert.equal(changes.length, 2);
  assert.equal(raw.manual_call_templates[0].config.mcpServers.keep.transport, undefined);
  assert.equal(raw.manual_call_templates[1].auth_tools, undefined);
});

test("register_manual templates get the same treatment", () => {
  const { value, changes } = normalizeManualCallTemplate({
    name: "remote",
    call_template_type: "mcp",
    config: { mcpServers: { remote: { url: "https://example.com/mcp" } } }
  });
  assert.equal(value.config.mcpServers.remote.transport, "http");
  assert.equal(changes.length, 1);
});

test("explicit values and auth-free manuals are left alone", () => {
  const { changes } = normalizeUtcpConfig({
    manual_call_templates: [
      { name: "m", call_template_type: "mcp", config: { mcpServers: { m: { command: "x", transport: "stdio" } } } },
      { name: "open", call_template_type: "http", url: "https://example.com/openapi.json" }
    ]
  });
  assert.deepEqual(changes, []);
});

test("tolerates configs with no manuals", () => {
  assert.deepEqual(normalizeUtcpConfig({}).changes, []);
  assert.deepEqual(normalizeUtcpConfig({ manual_call_templates: "nope" }).changes, []);
});
