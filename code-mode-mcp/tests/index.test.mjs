import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPromptText,
  createCleanToolNameClient,
  getToolDefinitions,
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
  assert.match(prompt, /get_required_variables_for_tool/);
  // async/await is a first-class, supported execution style (parity with upstream
  // + the library's own AGENT_PROMPT_TEMPLATE, which this prompt now embeds).
  assert.match(prompt, /async function/);
  assert.match(prompt, /await/);
  // ...but the prompt must still steer to THIS server's tool names, not upstream's.
  assert.doesNotMatch(prompt, /tool_info/);
  assert.doesNotMatch(prompt, /get_required_keys_for_tool/);
});

test("clean wrapper surface exposes only canonical tool names", () => {
  const toolNames = getToolDefinitions().map((definition) => definition.name);
  assert.deepEqual(toolNames, [
    "register_manual",
    "deregister_manual",
    "search_tools",
    "list_tools",
    "tools_info",
    "get_required_variables_for_tool",
    "call_tool_chain"
  ]);
});

test("list_tools returns UTCP names and sandbox access names", async () => {
  const client = createClientStub();
  const listTools = getToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "list_tools"
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

test("list_tools paginates compact output by default", async () => {
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
  const listTools = getToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "list_tools"
  );

  const payload = parseTextPayload(await listTools.handler({}));

  assert.equal(payload.total, 125);
  assert.equal(payload.count, 100);
  assert.equal(payload.next_offset, 100);
  assert.equal(payload.tools.length, 100);
  assert.equal("description" in payload.tools[0], false);
  assert.equal("tags" in payload.tools[0], false);
});

test("list_tools can include metadata for a selected page", async () => {
  const client = createClientStub();
  const listTools = getToolDefinitions({ getClient: async () => client }).find(
    (definition) => definition.name === "list_tools"
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

test("search_tools and tools_info return full UTCP-facing interface details", async () => {
  const client = createClientStub();
  const definitions = getToolDefinitions({ getClient: async () => client });
  const searchTools = definitions.find((definition) => definition.name === "search_tools");
  const toolsInfo = definitions.find((definition) => definition.name === "tools_info");

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
  const definitions = getToolDefinitions({ getClient: async () => client });
  const listTools = definitions.find((definition) => definition.name === "list_tools");
  const toolsInfo = definitions.find((definition) => definition.name === "tools_info");
  const requiredVariables = definitions.find(
    (definition) => definition.name === "get_required_variables_for_tool"
  );

  const listPayload = parseTextPayload(await listTools.handler({}));
  assert.equal(listPayload.tools[0].utcp_name, "typefully_remote_mcp.typefully_list_drafts");
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
      "typefully_remote_mcp.typefully_list_drafts",
      "typefully_remote_mcp.typefully_get_draft"
    ]
  );

  await client.callTool("typefully_remote_mcp.typefully_get_draft", { draft_id: "draft_123" });
  assert.deepEqual(calls.at(-1), {
    kind: "callTool",
    toolName: "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft",
    toolArgs: { draft_id: "draft_123" }
  });

  await requiredVariables.handler({ tool_name: "typefully_remote_mcp.typefully_get_draft" });
  assert.equal(
    calls.at(-1).toolName,
    "typefully_remote_mcp.typefully-remote-mcp.typefully_get_draft"
  );
});

test("MCP clean-name aliases do not shadow existing canonical tool names", async () => {
  const conflictingTools = [
    ...duplicatedMcpTools.slice(0, 1),
    {
      ...duplicatedMcpTools[0],
      name: "typefully_remote_mcp.typefully_list_drafts",
      description: "Existing clean canonical tool."
    }
  ];
  const baseClient = {
    async callTool() {
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
  const definitions = getToolDefinitions({ getClient: async () => client });
  const listTools = definitions.find((definition) => definition.name === "list_tools");

  const listPayload = parseTextPayload(await listTools.handler({}));
  assert.deepEqual(
    listPayload.tools.map((tool) => tool.utcp_name),
    [
      "typefully_remote_mcp.typefully-remote-mcp.typefully_list_drafts",
      "typefully_remote_mcp.typefully_list_drafts"
    ]
  );
});

test("get_required_variables_for_tool reflects UTCP variable semantics", async () => {
  const client = createClientStub();
  const definition = getToolDefinitions({ getClient: async () => client }).find(
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
  const definitions = getToolDefinitions({ getClient: async () => client });
  const searchTools = definitions.find((definition) => definition.name === "search_tools");
  const toolsInfo = definitions.find((definition) => definition.name === "tools_info");
  const callToolChain = definitions.find((definition) => definition.name === "call_tool_chain");

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
