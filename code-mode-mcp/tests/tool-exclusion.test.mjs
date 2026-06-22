import test from "node:test";
import assert from "node:assert/strict";

import {
  parseExclusionRule,
  stripExclusionKeys,
  getManualNameFromToolName,
  getToolShortName,
  isToolExcluded,
  applyManualExclusion,
  buildExclusionRegistryFromConfig
} from "../dist/index.js";

test("parseExclusionRule returns null when no exclusion keys present", () => {
  assert.equal(parseExclusionRule({ name: "m", call_template_type: "mcp" }), null);
  assert.equal(parseExclusionRule(null), null);
});

test("parseExclusionRule reads denylist and allowlist fields", () => {
  const rule = parseExclusionRule({
    name: "m",
    exclude_tools: ["a", "b"],
    include_tools: ["c"],
    default_disabled: true
  });
  assert.deepEqual(rule, { defaultDisabled: true, exclude: ["a", "b"], include: ["c"] });
});

test("parseExclusionRule defaults missing arrays and flag", () => {
  const rule = parseExclusionRule({ exclude_tools: ["a"] });
  assert.deepEqual(rule, { defaultDisabled: false, exclude: ["a"], include: [] });
});

test("stripExclusionKeys removes only the three custom keys", () => {
  const stripped = stripExclusionKeys({
    name: "m",
    call_template_type: "mcp",
    exclude_tools: ["a"],
    include_tools: ["b"],
    default_disabled: true
  });
  assert.deepEqual(stripped, { name: "m", call_template_type: "mcp" });
});

test("getManualNameFromToolName / getToolShortName split on first dot", () => {
  assert.equal(getManualNameFromToolName("proxyman_mcp.get_flows"), "proxyman_mcp");
  assert.equal(getManualNameFromToolName("solo"), "solo");
  assert.equal(getToolShortName("proxyman_mcp.get_flows", "proxyman_mcp"), "get_flows");
  assert.equal(getToolShortName("proxyman_mcp.srv.get_flows", "proxyman_mcp"), "srv.get_flows");
});

test("isToolExcluded denylist hides listed tools by short, full, or access name", () => {
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: false, exclude: ["get_flows"], include: [] }]
  ]);
  assert.equal(isToolExcluded("proxyman_mcp.get_flows", "proxyman_mcp.get_flows", registry), true);
  assert.equal(isToolExcluded("proxyman_mcp.get_version", "proxyman_mcp.get_version", registry), false);
});

test("isToolExcluded allowlist hides everything except include list", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: true, exclude: [], include: ["mail_list"] }]
  ]);
  assert.equal(isToolExcluded("msgcli.mail_list", "msgcli.mail_list", registry), false);
  assert.equal(isToolExcluded("msgcli.mail_send", "msgcli.mail_send", registry), true);
});

test("isToolExcluded returns false when manual has no rule", () => {
  assert.equal(isToolExcluded("other.tool", "other.tool", new Map()), false);
});

test("isToolExcluded denylist matches 3-segment mcp names by bare tool name", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: false, exclude: ["mail_delete"], include: [] }]
  ]);
  // Real MCP canonical names are manual.server.tool; the config uses the bare tool name.
  assert.equal(isToolExcluded("msgcli.msgcli.mail_delete", "msgcli.msgcli_mail_delete", registry), true);
  // The clean alias form (manual.tool) also matches.
  assert.equal(isToolExcluded("msgcli.msgcli.mail_delete", "msgcli.mail_delete", registry), true);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_list", "msgcli.msgcli_mail_list", registry), false);
});

test("isToolExcluded allowlist on 3-segment mcp names keeps only bare-listed tools", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: true, exclude: [], include: ["mail_list"] }]
  ]);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_list", "msgcli.msgcli_mail_list", registry), false);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_send", "msgcli.msgcli_mail_send", registry), true);
});

test("applyManualExclusion records the rule and strips keys", () => {
  const registry = new Map();
  const sanitized = applyManualExclusion(registry, {
    name: "m",
    call_template_type: "mcp",
    exclude_tools: ["a"]
  });
  assert.deepEqual(sanitized, { name: "m", call_template_type: "mcp" });
  assert.deepEqual(registry.get("m"), { defaultDisabled: false, exclude: ["a"], include: [] });
});

test("applyManualExclusion clears a stale rule when keys removed", () => {
  const registry = new Map([["m", { defaultDisabled: false, exclude: ["a"], include: [] }]]);
  applyManualExclusion(registry, { name: "m", call_template_type: "mcp" });
  assert.equal(registry.has("m"), false);
});

test("buildExclusionRegistryFromConfig builds registry and sanitized config", () => {
  const raw = {
    manual_call_templates: [
      { name: "m1", call_template_type: "mcp", exclude_tools: ["x"] },
      { name: "m2", call_template_type: "http" }
    ]
  };
  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig(raw);
  assert.deepEqual(registry.get("m1"), { defaultDisabled: false, exclude: ["x"], include: [] });
  assert.equal(registry.has("m2"), false);
  assert.deepEqual(sanitizedConfig.manual_call_templates[0], { name: "m1", call_template_type: "mcp" });
  assert.deepEqual(sanitizedConfig.manual_call_templates[1], { name: "m2", call_template_type: "http" });
});

test("buildExclusionRegistryFromConfig tolerates missing manual_call_templates", () => {
  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig({});
  assert.equal(registry.size, 0);
  assert.deepEqual(sanitizedConfig, {});
});

import { createCleanToolNameClient } from "../dist/index.js";

function makeBaseClient(tools, calls) {
  return {
    async callTool(toolName, toolArgs) {
      calls.push({ kind: "callTool", toolName, toolArgs });
      return { ok: true };
    },
    async callToolChain() {
      return { result: { ok: true }, logs: [] };
    },
    async deregisterManual() {
      return true;
    },
    async getRequiredVariablesForRegisteredTool(toolName) {
      calls.push({ kind: "getRequiredVariablesForRegisteredTool", toolName });
      return [];
    },
    async getTools() {
      return tools;
    },
    async registerManual() {
      return { registered: true };
    },
    async searchTools() {
      return tools;
    },
    toolToTypeScriptInterface(tool) {
      return `// ${tool.name}`;
    }
  };
}

const exclusionTools = [
  { name: "proxyman_mcp.get_flows", description: "flows", tags: [], inputs: {}, outputs: {} },
  { name: "proxyman_mcp.get_version", description: "version", tags: [], inputs: {}, outputs: {} }
];

test("wrapper getTools hides excluded tools", async () => {
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: false, exclude: ["get_flows"], include: [] }]
  ]);
  const client = createCleanToolNameClient(makeBaseClient(exclusionTools, []), registry);
  const visible = await client.getTools();
  assert.deepEqual(visible.map((t) => t.name), ["proxyman_mcp.get_version"]);
});

test("wrapper searchTools hides excluded tools", async () => {
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: true, exclude: [], include: ["get_version"] }]
  ]);
  const client = createCleanToolNameClient(makeBaseClient(exclusionTools, []), registry);
  const found = await client.searchTools("anything", 10);
  assert.deepEqual(found.map((t) => t.name), ["proxyman_mcp.get_version"]);
});

test("wrapper callTool blocks excluded tools and allows visible ones", async () => {
  const calls = [];
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: false, exclude: ["get_flows"], include: [] }]
  ]);
  const client = createCleanToolNameClient(makeBaseClient(exclusionTools, calls), registry);

  await assert.rejects(
    () => client.callTool("proxyman_mcp.get_flows", {}),
    /disabled by the manual exclusion config/
  );
  await client.callTool("proxyman_mcp.get_version", {});
  assert.deepEqual(calls.at(-1), {
    kind: "callTool",
    toolName: "proxyman_mcp.get_version",
    toolArgs: {}
  });
});

test("wrapper getRequiredVariablesForRegisteredTool blocks excluded tools", async () => {
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: false, exclude: ["get_flows"], include: [] }]
  ]);
  const client = createCleanToolNameClient(makeBaseClient(exclusionTools, []), registry);
  await assert.rejects(
    () => client.getRequiredVariablesForRegisteredTool("proxyman_mcp.get_flows"),
    /disabled by the manual exclusion config/
  );
});

test("wrapper with no registry leaves all tools visible (back-compat)", async () => {
  const client = createCleanToolNameClient(makeBaseClient(exclusionTools, []));
  const visible = await client.getTools();
  assert.equal(visible.length, 2);
});

import { getToolDefinitions } from "../dist/index.js";

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("register_manual strips exclusion keys before delegating to the SDK", async () => {
  const received = [];
  const baseClient = {
    async callTool() { return {}; },
    async callToolChain() { return { result: null, logs: [] }; },
    async deregisterManual() { return true; },
    async getRequiredVariablesForRegisteredTool() { return []; },
    async getTools() { return []; },
    async registerManual(template) {
      received.push(template);
      return { registered: true };
    },
    async searchTools() { return []; },
    toolToTypeScriptInterface(tool) { return `// ${tool.name}`; }
  };
  const client = createCleanToolNameClient(baseClient);
  const definitions = getToolDefinitions({ getClient: async () => client });
  const registerManual = definitions.find((d) => d.name === "register_manual");

  const payload = parseText(
    await registerManual.handler({
      manual_call_template: {
        name: "demo",
        call_template_type: "mcp",
        config: { mcpServers: { demo: { command: "x", transport: "stdio" } } },
        exclude_tools: ["secret_tool"]
      }
    })
  );

  assert.equal(payload.success, true);
  assert.equal(received.length, 1);
  assert.equal("exclude_tools" in received[0], false, "SDK must not receive custom keys");
  assert.equal(received[0].name, "demo");
});

import { z as zod } from "zod";

test("register_manual inputSchema preserves exclusion keys (schema is not stripping them)", () => {
  const registerManual = getToolDefinitions().find((d) => d.name === "register_manual");
  // Reproduce how the MCP SDK validates incoming args: z.object(shape).parse(...)
  const parsed = zod.object(registerManual.inputSchema).parse({
    manual_call_template: {
      name: "demo",
      call_template_type: "mcp",
      config: { mcpServers: { demo: { command: "x", transport: "stdio" } } },
      exclude_tools: ["secret_tool"]
    }
  });
  assert.deepEqual(parsed.manual_call_template.exclude_tools, ["secret_tool"]);
});
