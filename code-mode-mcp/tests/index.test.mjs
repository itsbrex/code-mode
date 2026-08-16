import test from "node:test";
import assert from "node:assert/strict";
import { CodeModeUtcpClient } from "@utcp/code-mode";

import {
  buildPromptText,
  createCleanToolNameClient,
  findToolByName,
  getBridgeExtensionDefinitions,
  getCanonicalToolDefinitions,
  getCompatibilityToolDefinitions,
  getToolDefinitions,
  resolveServerConfigPath,
  utcpNameToTsInterfaceName
} from "../dist/index.js";

const sampleTools = [
  {
    name: "weather.get_current",
    description: "Get the current weather for a city.",
    tags: ["weather", "forecast"],
    inputs: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" }
      },
      required: ["city"]
    },
    outputs: {
      type: "object",
      properties: {
        temperature_c: { type: "number" }
      },
      required: ["temperature_c"]
    }
  },
  {
    name: "reporting.generate_insights",
    description: "Generate summary insights for a report.",
    tags: ["reporting"],
    inputs: {
      type: "object",
      properties: {
        account_id: { type: "string" }
      },
      required: ["account_id"]
    },
    outputs: {
      type: "object",
      properties: {
        summary: { type: "string" }
      },
      required: ["summary"]
    }
  }
];

const duplicatedMcpTools = [
  {
    name: "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts",
    description: "List Typefully drafts.",
    tags: ["typefully"],
    inputs: {
      type: "object",
      properties: {}
    },
    outputs: {
      type: "object",
      properties: {}
    },
    tool_call_template: {
      name: "typefully_remote_mcp",
      call_template_type: "mcp",
      config: {
        mcpServers: {
          "typefully-remote-mcp": {
            transport: "stdio",
            command: "typefully-remote-mcp"
          }
        }
      }
    }
  },
  {
    name: "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft",
    description: "Get a Typefully draft.",
    tags: ["typefully"],
    inputs: {
      type: "object",
      properties: {
        draft_id: { type: "string" }
      },
      required: ["draft_id"]
    },
    outputs: {
      type: "object",
      properties: {}
    },
    tool_call_template: {
      name: "typefully_remote_mcp",
      call_template_type: "mcp",
      config: {
        mcpServers: {
          "typefully-remote-mcp": {
            transport: "stdio",
            command: "typefully-remote-mcp"
          }
        }
      }
    }
  }
];

const duplicatePrefixMcpTools = [
  {
    name: "google_sheets.google_sheets.google_sheets_read_range",
    description: "Read a Google Sheets range.",
    tags: ["sheets"],
    inputs: {
      type: "object",
      properties: {
        range: { type: "string" }
      },
      required: ["range"]
    },
    outputs: {
      type: "object",
      properties: {}
    },
    tool_call_template: {
      name: "google_sheets",
      call_template_type: "mcp",
      config: {
        mcpServers: {
          google_sheets: {
            transport: "stdio",
            command: "google-sheets-mcp"
          }
        }
      }
    }
  }
];

const aliasCollisionMcpTools = [
  {
    ...duplicatePrefixMcpTools[0],
    name: "docs.server-a.read",
    description: "Read from server-a.",
    tool_call_template: {
      ...duplicatePrefixMcpTools[0].tool_call_template,
      config: {
        mcpServers: {
          "server-a": {
            transport: "stdio",
            command: "server-a"
          }
        }
      }
    }
  },
  {
    ...duplicatePrefixMcpTools[0],
    name: "docs.server_a.read",
    description: "Read from server_a.",
    tool_call_template: {
      ...duplicatePrefixMcpTools[0].tool_call_template,
      config: {
        mcpServers: {
          server_a: {
            transport: "stdio",
            command: "server-a-underscore"
          }
        }
      }
    }
  }
];

function createNameMapClient(tools) {
  const calls = [];
  const client = {
    calls,
    async callTool(toolName, toolArgs) {
      calls.push({ kind: "callTool", toolName, toolArgs });
      return { ok: true };
    },
    async callToolChain(code, timeout, memoryLimit) {
      calls.push({ kind: "callToolChain", code, timeout, memoryLimit });
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
      return `// Access as: ${utcpNameToTsInterfaceName(tool.name)}(args)`;
    }
  };
  return client;
}

function createClientStub() {
  const calls = [];
  const client = {
    calls,
    async callToolChain(code, timeout, memoryLimit) {
      calls.push({ kind: "callToolChain", code, timeout, memoryLimit });
      return {
        result: {
          summary: "ok",
          code
        },
        logs: ["executed"]
      };
    },
    async deregisterManual(manualName) {
      calls.push({ kind: "deregisterManual", manualName });
      return true;
    },
    async getRequiredVariablesForRegisteredTool(toolName) {
      calls.push({ kind: "getRequiredVariablesForRegisteredTool", toolName });
      return ["API_KEY", "ACCOUNT_ID"];
    },
    async getTools() {
      calls.push({ kind: "getTools" });
      return sampleTools;
    },
    async registerManual(manualCallTemplate) {
      calls.push({ kind: "registerManual", manualCallTemplate });
      return { registered: true };
    },
    async searchTools(taskDescription, limit) {
      calls.push({ kind: "searchTools", taskDescription, limit });
      return sampleTools.slice(0, limit);
    },
    toolToTypeScriptInterface(tool) {
      return `// Access as: ${utcpNameToTsInterfaceName(tool.name)}(args)`;
    }
  };

  return client;
}

function parseTextPayload(response) {
  assert.equal(response.content.length > 0, true);
  const textBlock = response.content.find((block) => block.type === "text");
  assert.ok(textBlock, "expected a text content block");
  return JSON.parse(textBlock.text);
}

test("prompt text teaches the UTCP model with async/await support", () => {
  const prompt = buildPromptText();
  assert.match(prompt, /tools_info/);
  assert.match(prompt, /get_required_keys_for_tool/);
  assert.match(prompt, /get_required_variables_for_tool.*deprecated/i);
  // async/await is a first-class, supported execution style (parity with upstream
  // + the library's own AGENT_PROMPT_TEMPLATE, which this prompt now embeds).
  assert.match(prompt, /async function/);
  assert.match(prompt, /await/);
  // Prompt must steer to registered canonical names, not upstream's stale typo.
  assert.doesNotMatch(prompt, /tool_info/);
});

test("canonical MCP wire exposes exact upstream 1.2.1 tool names", () => {
  const definitions = getCanonicalToolDefinitions();
  assert.deepEqual(
    definitions.map((definition) => ({
      name: definition.name,
      inputKeys: Object.keys(definition.inputSchema),
      annotations: definition.annotations
    })),
    [
      {
        name: "register_manual",
        inputKeys: ["manual_call_template"],
        annotations: undefined
      },
      {
        name: "deregister_manual",
        inputKeys: ["manual_name"],
        annotations: undefined
      },
      {
        name: "search_tools",
        inputKeys: ["task_description", "limit"],
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          idempotentHint: true
        }
      },
      {
        name: "list_tools",
        inputKeys: [],
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          idempotentHint: true
        }
      },
      {
        name: "get_required_keys_for_tool",
        inputKeys: ["tool_name"],
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          idempotentHint: true
        }
      },
      {
        name: "tools_info",
        inputKeys: ["tool_names"],
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          idempotentHint: true
        }
      },
      {
        name: "call_tool_chain",
        inputKeys: ["code", "timeout", "max_output_size"],
        annotations: undefined
      }
    ]
  );
});

test("compatibility alias and Local Bridge additions stay outside canonical wire", () => {
  assert.deepEqual(
    getCompatibilityToolDefinitions().map((definition) => definition.name),
    ["get_required_variables_for_tool"]
  );
  assert.deepEqual(
    getBridgeExtensionDefinitions().map((definition) => definition.name),
    [
      "bridge_v1_register_manual",
      "bridge_v1_search_tools",
      "bridge_v1_list_tools",
      "bridge_v1_tools_info",
      "bridge_v1_call_tool_chain"
    ]
  );
});

test("canonical list_tools matches upstream 1.2.1 request and result", async () => {
  const client = createClientStub();
  const listTools = getCanonicalToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "list_tools"
  );

  assert.deepEqual(Object.keys(listTools.inputSchema), []);
  assert.deepEqual(listTools.annotations, {
    readOnlyHint: true,
    openWorldHint: false,
    idempotentHint: true
  });
  assert.deepEqual(parseTextPayload(await listTools.handler({})), {
    tools: ["weather.get_current", "reporting.generate_insights"]
  });
});

test("canonical search_tools matches upstream 1.2.1 discovery envelope", async () => {
  const client = createClientStub();
  const searchTools = getCanonicalToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "search_tools"
  );

  assert.deepEqual(Object.keys(searchTools.inputSchema), ["task_description", "limit"]);
  assert.deepEqual(
    parseTextPayload(
      await searchTools.handler({ task_description: "weather", limit: 1 })
    ),
    {
      tools: [
        {
          name: "weather.get_current",
          description: "Get the current weather for a city.",
          typescript_interface: "// Access as: weather.get_current(args)"
        }
      ]
    }
  );
});

test("canonical get_required_keys_for_tool matches upstream 1.2.1 envelope", async () => {
  const client = createClientStub();
  const requiredKeys = getCanonicalToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "get_required_keys_for_tool"
  );

  assert.deepEqual(Object.keys(requiredKeys.inputSchema), ["tool_name"]);
  assert.deepEqual(
    parseTextPayload(await requiredKeys.handler({ tool_name: "weather.get_current" })),
    {
      success: true,
      tool_name: "weather.get_current",
      required_variables: ["API_KEY", "ACCOUNT_ID"]
    }
  );
});

test("canonical tools_info returns interfaces as text and reports missing tools", async () => {
  const client = createClientStub();
  const toolsInfo = getCanonicalToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "tools_info"
  );

  const response = await toolsInfo.handler({
    tool_names: ["weather.get_current", "missing.tool"]
  });
  assert.equal(response.isError, undefined);
  assert.equal(
    response.content[0].text,
    "// Access as: weather.get_current(args)\n\n// Tool 'missing.tool' not found"
  );
});

test("canonical registration handlers match upstream 1.2.1 envelopes", async () => {
  const client = createClientStub();
  const definitions = getCanonicalToolDefinitions({ getClient: async () => client });
  const registerManual = definitions.find((definition) => definition.name === "register_manual");
  const deregisterManual = definitions.find(
    (definition) => definition.name === "deregister_manual"
  );
  const template = { name: "weather", call_template_type: "http" };

  assert.deepEqual(
    parseTextPayload(await registerManual.handler({ manual_call_template: template })),
    { registered: true }
  );
  assert.deepEqual(
    parseTextPayload(await deregisterManual.handler({ manual_name: "weather" })),
    { success: true, message: "Manual 'weather' deregistered." }
  );
});

test("canonical call_tool_chain preserves MCP blocks and upstream result envelope", async () => {
  const client = {
    ...createClientStub(),
    async callToolChain(code, timeout, memoryLimit) {
      this.calls.push({ kind: "callToolChain", code, timeout, memoryLimit });
      return {
        result: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { summary: "ok" }
        ],
        logs: ["executed"]
      };
    }
  };
  const callToolChain = getCanonicalToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "call_tool_chain"
  );

  assert.deepEqual(Object.keys(callToolChain.inputSchema), [
    "code",
    "timeout",
    "max_output_size"
  ]);
  const response = await callToolChain.handler({
    code: "return weather.get_current({ city: 'London' });",
    timeout: 1_000,
    max_output_size: 10_000
  });
  assert.deepEqual(response.content[0], {
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png"
  });
  assert.deepEqual(JSON.parse(response.content.at(-1).text), {
    success: true,
    nonMcpContentResults: { summary: "ok" },
    logs: ["executed"]
  });
  assert.deepEqual(client.calls.at(-1), {
    kind: "callToolChain",
    code: "return weather.get_current({ city: 'London' });",
    timeout: 1_000,
    memoryLimit: undefined
  });
});

test("canonical call_tool_chain preserves single and multiple MCP content blocks", async () => {
  const callWithResult = async (result) => {
    const client = {
      ...createClientStub(),
      async callToolChain() {
        return { result, logs: ["executed"] };
      }
    };
    const definition = getCanonicalToolDefinitions({
      getClient: async () => client
    }).find((tool) => tool.name === "call_tool_chain");

    return definition.handler({
      code: "return value;",
      timeout: 1_000,
      max_output_size: 10_000
    });
  };

  const single = await callWithResult({ type: "text", text: "native" });
  assert.deepEqual(single.content[0], { type: "text", text: "native" });
  assert.deepEqual(JSON.parse(single.content[1].text), {
    success: true,
    logs: ["executed"]
  });

  const multiple = await callWithResult([
    { type: "text", text: "first" },
    { type: "resource_link", name: "artifact", uri: "file:///tmp/artifact" }
  ]);
  assert.deepEqual(multiple.content.slice(0, 2), [
    { type: "text", text: "first" },
    { type: "resource_link", name: "artifact", uri: "file:///tmp/artifact" }
  ]);
  assert.deepEqual(JSON.parse(multiple.content[2].text), {
    success: true,
    logs: ["executed"]
  });
});

test("canonical call_tool_chain returns raw errors and marks capped output", async () => {
  const failingClient = {
    ...createClientStub(),
    async callToolChain() {
      throw new Error("execution exploded");
    }
  };
  const failingDefinition = getCanonicalToolDefinitions({
    getClient: async () => failingClient
  }).find((tool) => tool.name === "call_tool_chain");
  assert.deepEqual(
    await failingDefinition.handler({
      code: "throw new Error();",
      timeout: 1_000,
      max_output_size: 100
    }),
    {
      isError: true,
      content: [{ type: "text", text: "execution exploded" }]
    }
  );

  const cappedDefinition = getCanonicalToolDefinitions({
    getClient: async () => createClientStub()
  }).find((tool) => tool.name === "call_tool_chain");
  const capped = await cappedDefinition.handler({
    code: "return value;",
    timeout: 1_000,
    max_output_size: 10
  });
  assert.match(capped.content.at(-1).text, /\.\.\.\nmax_output_size exceeded$/);
});

test("bridge_v1_list_tools returns UTCP names and sandbox access names", async () => {
  const client = createClientStub();
  const listTools = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const payload = parseTextPayload(await listTools.handler({}));
  assert.equal(payload.total, 2);
  assert.equal(payload.count, 2);
  assert.equal(payload.offset, 0);
  assert.equal(payload.limit, 100);
  assert.equal(payload.tools[0].utcp_name, "weather.get_current");
  assert.equal(payload.tools[0].access_name, "weather.get_current");
  assert.equal("description" in payload.tools[0], false);
  assert.equal("tags" in payload.tools[0], false);
});

test("bridge_v1_list_tools paginates compact output by default", async () => {
  const manyTools = Array.from({ length: 125 }, (_, index) => ({
    name: `manual.tool_${index}`,
    description: "Large description ".repeat(100),
    tags: ["large", "metadata"],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} }
  }));
  const client = {
    ...createClientStub(),
    async getTools() {
      return manyTools;
    }
  };
  const listTools = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const payload = parseTextPayload(await listTools.handler({}));

  assert.equal(payload.total, 125);
  assert.equal(payload.count, 100);
  assert.equal(payload.next_offset, 100);
  assert.equal(payload.tools.length, 100);
  assert.equal("description" in payload.tools[0], false);
  assert.equal("tags" in payload.tools[0], false);
});

test("bridge_v1_list_tools can include metadata for a selected page", async () => {
  const client = createClientStub();
  const listTools = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const payload = parseTextPayload(
    await listTools.handler({ limit: 1, offset: 1, include_metadata: true })
  );

  assert.equal(payload.total, 2);
  assert.equal(payload.count, 1);
  assert.equal(payload.offset, 1);
  assert.equal(payload.next_offset, undefined);
  assert.equal(payload.tools[0].utcp_name, "reporting.generate_insights");
  assert.equal(payload.tools[0].description, "Generate summary insights for a report.");
  assert.deepEqual(payload.tools[0].tags, ["reporting"]);
});

test("bridge_v1 discovery tools return full UTCP-facing interface details", async () => {
  const client = createClientStub();
  const definitions = getBridgeExtensionDefinitions({ getClient: async () => client });
  const searchTools = definitions.find(
    (definition) => definition.name === "bridge_v1_search_tools"
  );
  const toolsInfo = definitions.find(
    (definition) => definition.name === "bridge_v1_tools_info"
  );

  const searchPayload = parseTextPayload(
    await searchTools.handler({ task_description: "weather", limit: 1 })
  );
  assert.equal(searchPayload.tools.length, 1);
  assert.equal(searchPayload.tools[0].utcp_name, "weather.get_current");
  assert.equal(searchPayload.tools[0].access_name, "weather.get_current");
  assert.match(searchPayload.tools[0].typescript_interface, /Access as:/);

  const infoPayload = parseTextPayload(
    await toolsInfo.handler({ tool_names: [searchPayload.tools[0].access_name, "missing.tool"] })
  );
  assert.equal(infoPayload.tools.length, 1);
  assert.equal(infoPayload.tools[0].description, "Get the current weather for a city.");
  assert.deepEqual(infoPayload.missing_tools, ["missing.tool"]);
});

test("MCP tools expose clean manual.tool names when manual and server names duplicate", async () => {
  const calls = [];
  const baseClient = {
    async callTool(toolName, toolArgs) {
      calls.push({ kind: "callTool", toolName, toolArgs });
      return { ok: true };
    },
    async callToolChain(code, timeout, memoryLimit) {
      calls.push({ kind: "callToolChain", code, timeout, memoryLimit });
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
      return duplicatedMcpTools;
    },
    async registerManual() {
      return { registered: true };
    },
    async searchTools() {
      return duplicatedMcpTools;
    },
    toolToTypeScriptInterface(tool) {
      return `// Access as: ${utcpNameToTsInterfaceName(tool.name)}(args)`;
    }
  };

  const client = createCleanToolNameClient(baseClient);
  const definitions = getBridgeExtensionDefinitions({ getClient: async () => client });
  const listTools = definitions.find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );
  const toolsInfo = definitions.find(
    (definition) => definition.name === "bridge_v1_tools_info"
  );
  const requiredVariables = getCompatibilityToolDefinitions({
    getClient: async () => client
  }).find(
    (definition) => definition.name === "get_required_variables_for_tool"
  );

  const listPayload = parseTextPayload(await listTools.handler({}));
  assert.equal(
    listPayload.tools[0].utcp_name,
    "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts"
  );
  assert.equal(listPayload.tools[0].access_name, "typefully_remote_mcp.typefully_list_drafts");

  const infoPayload = parseTextPayload(
    await toolsInfo.handler({
      tool_names: [
        "typefully_remote_mcp.typefully_list_drafts",
        "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft"
      ]
    })
  );
  assert.deepEqual(
    infoPayload.tools.map((tool) => tool.utcp_name),
    [
      "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts",
      "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft"
    ]
  );

  await client.callTool("typefully_remote_mcp.typefully_get_draft", { draft_id: "draft_123" });
  assert.deepEqual(calls.at(-1), {
    kind: "callTool",
    toolName: "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft",
    toolArgs: { draft_id: "draft_123" }
  });

  const requiredPayload = parseTextPayload(
    await requiredVariables.handler({ tool_name: "typefully_remote_mcp.typefully_get_draft" })
  );
  assert.equal(
    requiredPayload.access_name,
    "typefully_remote_mcp.typefully_get_draft"
  );
  assert.equal(
    calls.at(-1).toolName,
    "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft"
  );
});

test("clean access-name wrapper leaves canonical client tool names unchanged", async () => {
  const baseClient = {
    async callTool() {},
    async callToolChain() {
      return { result: null, logs: [] };
    },
    async deregisterManual() {
      return true;
    },
    async getRequiredVariablesForRegisteredTool() {
      return [];
    },
    async getTools() {
      return duplicatedMcpTools;
    },
    async registerManual() {},
    async searchTools() {
      return duplicatedMcpTools;
    },
    toolToTypeScriptInterface(tool) {
      return tool.name;
    }
  };
  const cleanClient = createCleanToolNameClient(baseClient);

  assert.equal(
    (await cleanClient.getTools())[0].name,
    "typefully_remote_mcp.typefully_list_drafts"
  );
  assert.equal(
    (await baseClient.getTools())[0].name,
    "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts"
  );
});

test("MCP name map removes duplicated server and tool prefixes without changing raw identity", async () => {
  const baseClient = createNameMapClient(duplicatePrefixMcpTools);
  const client = createCleanToolNameClient(baseClient);
  const [exposed] = await client.getTools();
  const [searched] = await client.searchTools("sheets");

  assert.equal(exposed.name, "google_sheets.read_range");
  assert.equal(exposed.utcp_name, "google_sheets.google_sheets.google_sheets_read_range");
  assert.equal(searched.name, "google_sheets.read_range");
  assert.equal(
    duplicatePrefixMcpTools[0].name,
    "google_sheets.google_sheets.google_sheets_read_range"
  );
  assert.equal("utcp_name" in duplicatePrefixMcpTools[0], false);
});

test("MCP name map keeps access names unique across alias and sanitizer collisions", async () => {
  const baseClient = createNameMapClient(aliasCollisionMcpTools);
  const client = createCleanToolNameClient(baseClient);
  const listTools = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const payload = parseTextPayload(await listTools.handler({}));
  const accessNames = payload.tools.map((tool) => tool.access_name);

  assert.equal(new Set(accessNames).size, aliasCollisionMcpTools.length);
  assert.deepEqual(
    payload.tools.map((tool) => tool.utcp_name),
    aliasCollisionMcpTools.map((tool) => tool.name)
  );
  assert.equal(await findToolByName(client, "docs.server_a_read"), null);

  const reversedClient = createCleanToolNameClient(
    createNameMapClient([...aliasCollisionMcpTools].reverse())
  );
  const reversedListTools = getBridgeExtensionDefinitions({
    getClient: async () => reversedClient
  }).find((definition) => definition.name === "bridge_v1_list_tools");
  const reversedPayload = parseTextPayload(await reversedListTools.handler({}));
  assert.deepEqual(
    Object.fromEntries(payload.tools.map((tool) => [tool.utcp_name, tool.access_name])),
    Object.fromEntries(reversedPayload.tools.map((tool) => [tool.utcp_name, tool.access_name]))
  );

  for (const [index, accessName] of accessNames.entries()) {
    await client.callTool(accessName, { index });
  }
  assert.deepEqual(
    baseClient.calls.filter((call) => call.kind === "callTool").map((call) => call.toolName),
    aliasCollisionMcpTools.map((tool) => tool.name)
  );
});

test("legacy aliases cannot overwrite collision-disambiguated access routes", async () => {
  const firstRawName = aliasCollisionMcpTools[0].name;
  const encodedFirstRawName = Buffer.from(firstRawName, "utf8").toString("hex");
  const legacyCollisionTool = {
    ...duplicatePrefixMcpTools[0],
    name: `docs.server_a_read_.raw_${encodedFirstRawName}`,
    description: "Owns a legacy name matching another tool's first disambiguation.",
    tool_call_template: {
      ...duplicatePrefixMcpTools[0].tool_call_template,
      config: {
        mcpServers: {
          server_a_read_: {
            transport: "stdio",
            command: "legacy-collision-server"
          }
        }
      }
    }
  };
  const tools = [...aliasCollisionMcpTools, legacyCollisionTool];
  const baseClient = createNameMapClient(tools);
  const client = createCleanToolNameClient(baseClient);
  const listTools = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const payload = parseTextPayload(await listTools.handler({}));
  const firstAccessName = payload.tools.find(
    (tool) => tool.utcp_name === firstRawName
  ).access_name;

  assert.equal(new Set(payload.tools.map((tool) => tool.access_name)).size, tools.length);
  await client.callTool(firstAccessName, { route: "disambiguated" });
  assert.deepEqual(baseClient.calls.filter((call) => call.kind === "callTool"), [
    {
      kind: "callTool",
      toolName: firstRawName,
      toolArgs: { route: "disambiguated" }
    }
  ]);
});

test("MCP name map preserves legacy lookup and routes raw, legacy, and access calls to raw names", async () => {
  const rawName = duplicatePrefixMcpTools[0].name;
  const legacyName = "google_sheets.google_sheets_google_sheets_read_range";
  const accessName = "google_sheets.read_range";
  const baseClient = createNameMapClient(duplicatePrefixMcpTools);
  const client = createCleanToolNameClient(baseClient);
  const toolsInfo = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_tools_info"
  );

  const infoPayload = parseTextPayload(
    await toolsInfo.handler({ tool_names: [rawName, legacyName, accessName] })
  );
  assert.deepEqual(
    infoPayload.tools.map((tool) => tool.utcp_name),
    [rawName, rawName, rawName]
  );

  await client.callTool(rawName, { route: "raw" });
  await client.callTool(legacyName, { route: "legacy" });
  await client.callTool(accessName, { route: "access" });
  assert.deepEqual(
    baseClient.calls.filter((call) => call.kind === "callTool").map((call) => call.toolName),
    [rawName, rawName, rawName]
  );
});

test("bridge_v1_call_tool_chain routes concise sandbox access through canonical raw tool name", async () => {
  const rawName = duplicatePrefixMcpTools[0].name;
  const calls = [];
  const baseClient = Object.assign(Object.create(CodeModeUtcpClient.prototype), {
    async callTool(toolName, toolArgs) {
      calls.push({ toolName, toolArgs });
      return { routed: toolName, range: toolArgs.range };
    },
    async deregisterManual() {
      return true;
    },
    async getRequiredVariablesForRegisteredTool() {
      return [];
    },
    async getTools() {
      return duplicatePrefixMcpTools;
    },
    async registerManual() {
      return { registered: true };
    },
    async searchTools() {
      return duplicatePrefixMcpTools;
    },
    toolToTypeScriptInterface(tool) {
      return `// Access as: ${utcpNameToTsInterfaceName(tool.name)}(args)`;
    }
  });
  const client = createCleanToolNameClient(baseClient);
  const callToolChain = getBridgeExtensionDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "bridge_v1_call_tool_chain"
  );

  const payload = parseTextPayload(
    await callToolChain.handler({
      code: 'return google_sheets.read_range({ range: "Sheet1!A1:B2" });',
      timeout: 5_000,
      memory_limit: 64,
      max_output_size: 10_000
    })
  );

  assert.deepEqual(payload.result, { routed: rawName, range: "Sheet1!A1:B2" });
  assert.deepEqual(calls, [
    { toolName: rawName, toolArgs: { range: "Sheet1!A1:B2" } }
  ]);
});

test("tool definition aggregation routes canonical and extension handlers to separate clients", async () => {
  const calls = [];
  const canonicalClient = {
    ...createClientStub(),
    async getTools() {
      calls.push("canonical");
      return sampleTools;
    }
  };
  const extensionClient = {
    ...createClientStub(),
    async getTools() {
      calls.push("extension");
      return sampleTools;
    }
  };
  const definitions = getToolDefinitions({
    getClient: async () => canonicalClient,
    getExtensionClient: async () => extensionClient
  });

  await definitions.find((definition) => definition.name === "list_tools").handler({});
  await definitions
    .find((definition) => definition.name === "bridge_v1_list_tools")
    .handler({});
  assert.deepEqual(calls, ["canonical", "extension"]);
});

test("server config resolution accepts equal legacy value and rejects conflicts", () => {
  assert.equal(
    resolveServerConfigPath({
      environment: {
        UTCP_CONFIG_FILE: "/tmp/config.json",
        UTCP_CONFIG_PATH: "/tmp/config.json"
      },
      dotenvValues: {},
      cwd: "/workspace"
    }),
    "/tmp/config.json"
  );
  assert.throws(
    () =>
      resolveServerConfigPath({
        environment: { UTCP_CONFIG_FILE: "/tmp/canonical.json" },
        dotenvValues: { UTCP_CONFIG_PATH: "/tmp/legacy.json" },
        cwd: "/workspace"
      }),
    /Conflicting UTCP config paths/
  );
});

test("MCP clean-name aliases do not shadow existing canonical tool names", async () => {
  const calls = [];
  const conflictingTools = [
    ...duplicatedMcpTools.slice(0, 1),
    {
      ...duplicatedMcpTools[0],
      name: "typefully_remote_mcp.typefully_list_drafts",
      description: "Existing clean canonical tool."
    }
  ];
  const baseClient = {
    async callTool(toolName, toolArgs) {
      calls.push({ toolName, toolArgs });
      return { ok: true };
    },
    async callToolChain() {
      return { result: { ok: true }, logs: [] };
    },
    async deregisterManual() {
      return true;
    },
    async getRequiredVariablesForRegisteredTool() {
      return [];
    },
    async getTools() {
      return conflictingTools;
    },
    async registerManual() {
      return { registered: true };
    },
    async searchTools() {
      return conflictingTools;
    },
    toolToTypeScriptInterface(tool) {
      return `// Access as: ${utcpNameToTsInterfaceName(tool.name)}(args)`;
    }
  };

  const client = createCleanToolNameClient(baseClient);
  const definitions = getBridgeExtensionDefinitions({ getClient: async () => client });
  const listTools = definitions.find(
    (definition) => definition.name === "bridge_v1_list_tools"
  );

  const listPayload = parseTextPayload(await listTools.handler({}));
  assert.deepEqual(
    listPayload.tools.map((tool) => tool.utcp_name),
    [
      "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts",
      "typefully_remote_mcp.typefully_list_drafts"
    ]
  );
  assert.equal(new Set(listPayload.tools.map((tool) => tool.access_name)).size, 2);
  assert.deepEqual(
    Object.fromEntries(listPayload.tools.map((tool) => [tool.utcp_name, tool.access_name])),
    {
      "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts":
        "typefully_remote_mcp.typefully_remote_mcp_typefully_list_drafts",
      "typefully_remote_mcp.typefully_list_drafts":
        "typefully_remote_mcp.typefully_list_drafts"
    }
  );

  await client.callTool("typefully_remote_mcp.typefully_list_drafts", { route: "canonical" });
  assert.deepEqual(calls, [
    {
      toolName: "typefully_remote_mcp.typefully_list_drafts",
      toolArgs: { route: "canonical" }
    }
  ]);
});

test("get_required_variables_for_tool reflects UTCP variable semantics", async () => {
  const client = createClientStub();
  const definition = getCompatibilityToolDefinitions({ getClient: async () => client }).find(
    (tool) => tool.name === "get_required_variables_for_tool"
  );

  const payload = parseTextPayload(
    await definition.handler({ tool_name: "weather.get_current" })
  );
  assert.equal(payload.utcp_name, "weather.get_current");
  assert.deepEqual(payload.required_variables, ["API_KEY", "ACCOUNT_ID"]);
});

test("wrapper flow supports inspect then execute with sync call_tool_chain output", async () => {
  const client = createClientStub();
  const definitions = getBridgeExtensionDefinitions({ getClient: async () => client });
  const searchTools = definitions.find(
    (definition) => definition.name === "bridge_v1_search_tools"
  );
  const toolsInfo = definitions.find(
    (definition) => definition.name === "bridge_v1_tools_info"
  );
  const callToolChain = definitions.find(
    (definition) => definition.name === "bridge_v1_call_tool_chain"
  );

  const searchPayload = parseTextPayload(
    await searchTools.handler({ task_description: "weather", limit: 1 })
  );
  const accessName = searchPayload.tools[0].access_name;

  const infoPayload = parseTextPayload(
    await toolsInfo.handler({ tool_names: [accessName] })
  );
  assert.equal(infoPayload.tools[0].access_name, accessName);

  const executionPayload = parseTextPayload(
    await callToolChain.handler({
      code: `return ${accessName}({ city: "London" });`,
      timeout: 1_000,
      memory_limit: 64,
      max_output_size: 10_000
    })
  );

  assert.equal(executionPayload.result.summary, "ok");
  assert.deepEqual(executionPayload.logs, ["executed"]);
  assert.deepEqual(client.calls.at(-1), {
    kind: "callToolChain",
    code: `return ${accessName}({ city: "London" });`,
    timeout: 1_000,
    memoryLimit: 64
  });
});
