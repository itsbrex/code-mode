#!/usr/bin/env node

import util from "util";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContentBlock, ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import dotenv from "dotenv";

import "@utcp/http";
import "@utcp/text";
import "@utcp/mcp";
import "@utcp/cli";
import "@utcp/dotenv-loader";
import "@utcp/file";

import {
  CallTemplateSchema,
  UtcpClientConfigSerializer,
  ensureCorePluginsInitialized,
  type Tool,
  type UtcpClientConfig
} from "@utcp/sdk";
import { CodeModeUtcpClient } from "@utcp/code-mode";

import {
  applyManualExclusion,
  buildExclusionRegistryFromConfig,
  isToolExcluded,
  type ToolExclusionRegistry
} from "./tool-exclusion.js";

export * from "./tool-exclusion.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOOL_NAMES = [
  "register_manual",
  "deregister_manual",
  "search_tools",
  "list_tools",
  "tools_info",
  "get_required_variables_for_tool",
  "call_tool_chain"
] as const;

const DEFAULT_LIST_TOOLS_LIMIT = 100;
const MAX_LIST_TOOLS_LIMIT = 500;

let utcpClient: CodeModeUtcpClient | null = null;
let exclusionRegistry: ToolExclusionRegistry = new Map();

export interface CodeModeMcpClientLike {
  callToolChain(code: string, timeout?: number, memoryLimit?: number): Promise<{ result: unknown; logs: string[] }>;
  deregisterManual(manualName: string): Promise<boolean>;
  getRequiredVariablesForRegisteredTool(toolName: string): Promise<string[]>;
  getTools(): Promise<Tool[]>;
  registerManual(manualCallTemplate: unknown): Promise<unknown>;
  searchTools(taskDescription: string, limit?: number): Promise<Tool[]>;
  toolToTypeScriptInterface(tool: Tool): string;
  __findToolByName?: (name: string) => Promise<{ tool: Tool; utcpName: string } | null>;
}

export interface ToolRuntimeOptions {
  getClient?: () => Promise<CodeModeMcpClientLike>;
}

interface ToolDefinition {
  name: (typeof TOOL_NAMES)[number];
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (input: any) => Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

interface SerializedToolSummary {
  utcp_name: string;
  access_name: string;
  description: string;
  tags: string[];
}

interface SerializedToolListItem {
  utcp_name: string;
  access_name: string;
  description?: string;
  tags?: string[];
}

interface SerializedToolInfo extends SerializedToolSummary {
  inputs: unknown;
  outputs: unknown;
  typescript_interface: string;
}

interface ToolAliasIndex {
  aliasToCanonical: Map<string, string>;
  canonicalToAlias: Map<string, string>;
}

export function sanitizeIdentifier(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&");
}

export function utcpNameToTsInterfaceName(utcpName: string): string {
  if (utcpName.includes(".")) {
    const parts = utcpName.split(".");
    const manualName = parts[0]!;
    const toolParts = parts.slice(1);
    const sanitizedManualName = sanitizeIdentifier(manualName);
    const toolName = toolParts.map((part) => sanitizeIdentifier(part)).join("_");
    return `${sanitizedManualName}.${toolName}`;
  }

  return sanitizeIdentifier(utcpName);
}

function normalizeToolNameSegment(name: string): string {
  return sanitizeIdentifier(name).toLowerCase();
}

function getMcpServerNames(tool: Tool): string[] {
  const toolCallTemplate = (tool as any).tool_call_template;
  if (toolCallTemplate?.call_template_type !== "mcp") {
    return [];
  }

  const mcpServers = toolCallTemplate.config?.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") {
    return [];
  }

  return Object.keys(mcpServers);
}

function getMcpToolAliasCandidate(tool: Tool): string {
  const parts = tool.name.split(".");
  if (parts.length < 3) {
    return tool.name;
  }

  const [manualName, serverName, ...toolParts] = parts;
  if (!manualName || !serverName || toolParts.length === 0) {
    return tool.name;
  }

  const serverNames = getMcpServerNames(tool);
  const isSingleServerManual = serverNames.length === 1;
  const isDuplicateServerSegment =
    normalizeToolNameSegment(manualName) === normalizeToolNameSegment(serverName);

  if (!isSingleServerManual && !isDuplicateServerSegment) {
    return tool.name;
  }

  return `${manualName}.${toolParts.join(".")}`;
}

function buildToolAliasIndex(tools: Tool[]): ToolAliasIndex {
  const canonicalNames = new Set(tools.map((tool) => tool.name));
  const aliasCandidates = new Map<string, string>();
  const aliasCounts = new Map<string, number>();

  for (const tool of tools) {
    const alias = getMcpToolAliasCandidate(tool);
    aliasCandidates.set(tool.name, alias);
    aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }

  const aliasToCanonical = new Map<string, string>();
  const canonicalToAlias = new Map<string, string>();

  for (const tool of tools) {
    const alias = aliasCandidates.get(tool.name) ?? tool.name;
    const canUseAlias =
      alias !== tool.name &&
      aliasCounts.get(alias) === 1 &&
      !canonicalNames.has(alias);

    const exposedName = canUseAlias ? alias : tool.name;
    canonicalToAlias.set(tool.name, exposedName);

    if (canUseAlias) {
      aliasToCanonical.set(exposedName, tool.name);
    }
  }

  return { aliasToCanonical, canonicalToAlias };
}

function exposeToolAlias(tool: Tool, index: ToolAliasIndex): Tool {
  const alias = index.canonicalToAlias.get(tool.name);
  if (!alias || alias === tool.name) {
    return tool;
  }

  return {
    ...tool,
    name: alias
  };
}

async function findToolWithAliases(
  tools: Tool[],
  name: string
): Promise<{ tool: Tool; utcpName: string } | null> {
  const index = buildToolAliasIndex(tools);

  for (const tool of tools) {
    const aliasTool = exposeToolAlias(tool, index);
    const names = new Set([
      tool.name,
      aliasTool.name,
      utcpNameToTsInterfaceName(tool.name),
      utcpNameToTsInterfaceName(aliasTool.name)
    ]);

    if (names.has(name)) {
      return { tool: aliasTool, utcpName: aliasTool.name };
    }
  }

  return null;
}

export function createCleanToolNameClient(
  baseClient: CodeModeUtcpClient,
  registry: ToolExclusionRegistry = new Map()
): CodeModeMcpClientLike {
  const client = baseClient as CodeModeUtcpClient & {
    callTool(toolName: string, toolArgs: unknown): Promise<unknown>;
    __findToolByName?: (name: string) => Promise<{ tool: Tool; utcpName: string } | null>;
  };

  const getCanonicalTools = client.getTools.bind(client);
  const searchCanonicalTools = client.searchTools.bind(client);
  const callCanonicalTool = client.callTool.bind(client);
  const getCanonicalRequiredVariables = client.getRequiredVariablesForRegisteredTool.bind(client);

  const isExcluded = (toolName: string): boolean =>
    isToolExcluded(toolName, utcpNameToTsInterfaceName(toolName), registry);

  const getVisibleCanonicalTools = async (): Promise<Tool[]> => {
    const tools = await getCanonicalTools();
    return tools.filter((tool) => !isExcluded(tool.name));
  };

  const getAliasIndex = async () => buildToolAliasIndex(await getVisibleCanonicalTools());

  const resolveToolName = async (toolName: string): Promise<string> => {
    const index = await getAliasIndex();
    return index.aliasToCanonical.get(toolName) ?? toolName;
  };

  const assertNotExcluded = (requestedName: string, canonicalName: string): void => {
    if (isExcluded(canonicalName)) {
      throw new Error(`Tool '${requestedName}' is disabled by the manual exclusion config.`);
    }
  };

  client.getTools = async () => {
    const tools = await getVisibleCanonicalTools();
    const index = buildToolAliasIndex(tools);
    return tools.map((tool) => exposeToolAlias(tool, index));
  };

  client.searchTools = async (taskDescription: string, limit?: number) => {
    const [matchedTools, visibleTools] = await Promise.all([
      searchCanonicalTools(taskDescription, limit),
      getVisibleCanonicalTools()
    ]);
    const index = buildToolAliasIndex(visibleTools);
    return matchedTools
      .filter((tool) => !isExcluded(tool.name))
      .map((tool) => exposeToolAlias(tool, index));
  };

  client.callTool = async (toolName: string, toolArgs: unknown) => {
    const canonical = await resolveToolName(toolName);
    assertNotExcluded(toolName, canonical);
    return callCanonicalTool(canonical, toolArgs);
  };

  client.getRequiredVariablesForRegisteredTool = async (toolName: string) => {
    const canonical = await resolveToolName(toolName);
    assertNotExcluded(toolName, canonical);
    return getCanonicalRequiredVariables(canonical);
  };

  client.__findToolByName = async (name: string) => {
    return findToolWithAliases(await getVisibleCanonicalTools(), name);
  };

  return client;
}

export async function findToolByName(
  client: Pick<CodeModeMcpClientLike, "getTools">,
  name: string
): Promise<{ tool: Tool; utcpName: string } | null> {
  const aliasAwareClient = client as Pick<CodeModeMcpClientLike, "getTools"> & {
    __findToolByName?: (name: string) => Promise<{ tool: Tool; utcpName: string } | null>;
  };

  if (aliasAwareClient.__findToolByName) {
    const found = await aliasAwareClient.__findToolByName(name);
    if (found) {
      return found;
    }
  }

  const allTools = await client.getTools();
  for (const tool of allTools) {
    if (tool.name === name || utcpNameToTsInterfaceName(tool.name) === name) {
      return { tool, utcpName: tool.name };
    }
  }

  return null;
}

export function buildPromptText(): string {
  return `# UTCP Code Mode MCP Server Usage Guide

You have access to a UTCP Code Mode MCP server that exposes UTCP-native discovery and synchronous TypeScript tool execution.

## Workflow: Always Follow This Pattern

### 1. Discover tools first
- Use \`search_tools\` to find relevant UTCP tools for the task.
- Use \`list_tools\` to inspect the currently registered UTCP tool set.
- Use \`tools_info\` to inspect full tool interfaces before writing execution code.
- Use \`get_required_variables_for_tool\` when you need to know which environment variables a tool depends on.

## Tool access & execution model
- Tools are namespaced as \`manual.tool\` (e.g. \`manual_name.tool_name\`); use the full name to avoid collisions.
- Inspect \`__interfaces\` (all interface definitions) or \`__getToolInterface('manual.tool')\` for a specific contract before writing code.
- Call tools synchronously: \`manual.tool({ param: value })\` — no \`await\` needed; the host bridges async work internally.
- Standard JS globals are available (\`console\`, \`JSON\`, \`Math\`, \`Date\`). All \`console\` output is captured and returned.
- Chain calls by passing one result into the next, wrap calls in try/catch, and \`return\` the final value.

### 2. Execute code with the actual runtime model
- \`call_tool_chain\` executes TypeScript with synchronous \`manual.tool(args)\` access.
- Do not use \`await\` for sandbox tool calls.
- Return the value you want from the code block directly.
- The MCP text payload reports the library's actual result shape: \`{ result, logs }\`.

Remember: this wrapper follows the UTCP library contract exactly. Discover first, inspect interfaces second, execute sync sandbox code last.`;
}

function serializeToolSummary(tool: Tool): SerializedToolSummary {
  return {
    utcp_name: tool.name,
    access_name: utcpNameToTsInterfaceName(tool.name),
    description: tool.description ?? "",
    tags: Array.isArray(tool.tags) ? tool.tags : []
  };
}

function serializeToolListItem(tool: Tool, includeMetadata: boolean): SerializedToolListItem {
  const summary = serializeToolSummary(tool);
  if (includeMetadata) {
    return summary;
  }

  return {
    utcp_name: summary.utcp_name,
    access_name: summary.access_name
  };
}

function normalizeListToolsPagination(input: any): { limit: number; offset: number } {
  const rawLimit = Number.isInteger(input?.limit) ? input.limit : DEFAULT_LIST_TOOLS_LIMIT;
  const rawOffset = Number.isInteger(input?.offset) ? input.offset : 0;

  return {
    limit: Math.min(Math.max(rawLimit, 1), MAX_LIST_TOOLS_LIMIT),
    offset: Math.max(rawOffset, 0)
  };
}

function serializeToolInfo(
  client: Pick<CodeModeMcpClientLike, "toolToTypeScriptInterface">,
  tool: Tool
): SerializedToolInfo {
  return {
    ...serializeToolSummary(tool),
    inputs: tool.inputs ?? null,
    outputs: tool.outputs ?? null,
    typescript_interface: client.toolToTypeScriptInterface(tool)
  };
}

function truncateText(text: string, maxOutputSize: number): string {
  if (text.length <= maxOutputSize) {
    return text;
  }

  return `${text.slice(0, maxOutputSize)}...\nmax_output_size exceeded`;
}

function textResponse(payload: unknown, maxOutputSize = 200_000): { content: ContentBlock[] } {
  return {
    content: [
      {
        type: "text",
        text: truncateText(JSON.stringify(payload, null, 2), maxOutputSize)
      }
    ]
  };
}

function errorResponse(message: string): { content: ContentBlock[]; isError: true } {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message }, null, 2)
      }
    ]
  };
}

function buildCallToolChainResponse(
  result: unknown,
  logs: string[],
  maxOutputSize: number
): { content: ContentBlock[] } {
  const content: ContentBlock[] = [];
  const nonMcpResults: unknown[] = [];

  if (Array.isArray(result)) {
    for (const item of result) {
      if (ContentBlockSchema.safeParse(item).success) {
        content.push(item as ContentBlock);
      } else {
        nonMcpResults.push(item);
      }
    }
  } else if (ContentBlockSchema.safeParse(result).success) {
    content.push(result as ContentBlock);
  } else {
    nonMcpResults.push(result);
  }

  const plainResult =
    nonMcpResults.length === 0
      ? null
      : nonMcpResults.length === 1
        ? nonMcpResults[0]
        : nonMcpResults;

  content.push({
    type: "text",
    text: truncateText(
      JSON.stringify(
        {
          result: plainResult,
          logs
        },
        null,
        2
      ),
      maxOutputSize
    )
  });

  return { content };
}

export function getToolDefinitions(options: ToolRuntimeOptions = {}): ToolDefinition[] {
  const getClient = options.getClient ?? initializeUtcpClient;

  return [
    {
      name: "register_manual",
      title: "Register a UTCP Manual",
      description: "Register a UTCP manual call template with the current UTCP client.",
      inputSchema: {
        manual_call_template: CallTemplateSchema.describe(
          "The UTCP manual call template to register. Optional exclude_tools / include_tools / default_disabled fields control which of this manual's tools are exposed."
        )
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const sanitizedTemplate = applyManualExclusion(
            exclusionRegistry,
            input.manual_call_template as Record<string, unknown>
          );
          const result = await client.registerManual(sanitizedTemplate as any);
          return textResponse({ success: true, result });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "deregister_manual",
      title: "Deregister a UTCP Manual",
      description: "Remove a registered UTCP manual from the current UTCP client.",
      inputSchema: {
        manual_name: z.string().describe("The UTCP manual name to deregister.")
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const success = await client.deregisterManual(input.manual_name);
          if (success) {
            exclusionRegistry.delete(input.manual_name);
          }
          return textResponse({
            success,
            manual_name: input.manual_name,
            message: success
              ? `Manual '${input.manual_name}' deregistered.`
              : `Manual '${input.manual_name}' not found.`
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "search_tools",
      title: "Search UTCP Tools",
      description: "Search registered UTCP tools and return access names plus full TypeScript interfaces.",
      inputSchema: {
        task_description: z.string().describe("Natural-language description of the task or tool you need."),
        limit: z.number().int().positive().max(50).optional().default(10)
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const tools = await client.searchTools(input.task_description, input.limit);
          return textResponse({
            tools: tools.map((tool) => serializeToolInfo(client, tool))
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "list_tools",
      title: "List Registered UTCP Tools",
      description: "List registered UTCP tools with compact, paginated names by default.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIST_TOOLS_LIMIT)
          .optional()
          .describe(`Maximum number of tools to return. Defaults to ${DEFAULT_LIST_TOOLS_LIMIT}.`),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Zero-based offset for pagination."),
        include_metadata: z
          .boolean()
          .optional()
          .describe("Include descriptions and tags for the returned page. Defaults to false.")
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const tools = await client.getTools();
          const { limit, offset } = normalizeListToolsPagination(input);
          const page = tools.slice(offset, offset + limit);
          const nextOffset = offset + page.length < tools.length ? offset + page.length : undefined;

          return textResponse({
            total: tools.length,
            count: page.length,
            offset,
            limit,
            next_offset: nextOffset,
            tools: page.map((tool) => serializeToolListItem(tool, input?.include_metadata === true))
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "tools_info",
      title: "Inspect UTCP Tool Interfaces",
      description: "Return full UTCP tool interface details for a set of tool names or access names.",
      inputSchema: {
        tool_names: z.array(z.string()).min(1).describe("UTCP names or sandbox access names to inspect.")
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const tools: SerializedToolInfo[] = [];
          const missing_tools: string[] = [];

          for (const name of input.tool_names) {
            const found = await findToolByName(client, name);
            if (found) {
              tools.push(serializeToolInfo(client, found.tool));
            } else {
              missing_tools.push(name);
            }
          }

          if (tools.length === 0) {
            return errorResponse(`Tools not found: ${missing_tools.join(", ")}`);
          }

          return textResponse({
            tools,
            missing_tools
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "get_required_variables_for_tool",
      title: "Get Required Variables for a UTCP Tool",
      description: "Return the required environment variables for a registered UTCP tool.",
      inputSchema: {
        tool_name: z.string().describe("UTCP name or sandbox access name for the tool.")
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const found = await findToolByName(client, input.tool_name);
          if (!found) {
            return errorResponse(`Tool '${input.tool_name}' not found`);
          }

          const requiredVariables = await client.getRequiredVariablesForRegisteredTool(found.utcpName);
          return textResponse({
            tool_name: input.tool_name,
            utcp_name: found.utcpName,
            access_name: utcpNameToTsInterfaceName(found.utcpName),
            required_variables: requiredVariables
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    },
    {
      name: "call_tool_chain",
      title: "Execute Sync TypeScript with UTCP Tools",
      description: "Execute TypeScript with synchronous UTCP tool access and return the library result shape { result, logs }.",
      inputSchema: {
        code: z.string().describe("TypeScript code to execute. Use synchronous manual.tool(args) calls inside the sandbox."),
        timeout: z.number().int().positive().optional().default(30_000).describe("Execution timeout in milliseconds."),
        memory_limit: z.number().int().positive().optional().default(128).describe("Sandbox memory limit in MB."),
        max_output_size: z.number().int().positive().optional().default(200_000).describe("Maximum size of the final text payload in characters.")
      },
      handler: async (input) => {
        try {
          const client = await getClient();
          const timeout = input.timeout ?? 30_000;
          const memoryLimit = input.memory_limit ?? 128;
          const maxOutputSize = input.max_output_size ?? 200_000;
          const { result, logs } = await client.callToolChain(input.code, timeout, memoryLimit);
          return buildCallToolChainResponse(result, logs, maxOutputSize);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    }
  ];
}

export function registerMcpTools(server: McpServer, options: ToolRuntimeOptions = {}): void {
  server.registerPrompt(
    "utcp_codemode_usage",
    {
      title: "UTCP Code Mode Usage Guide",
      description: "Guide for UTCP-native tool discovery, interface inspection, and synchronous code execution."
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildPromptText()
          }
        }
      ]
    })
  );

  for (const definition of getToolDefinitions(options)) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        // Cast is types-only: SDK 1.29 regressed registerTool's generic
        // inference over the Zod inputSchema shape, producing TS2589
        // ("Type instantiation is excessively deep"). Casting just the
        // inputSchema breaks the deep inference without altering runtime
        // behavior or loosening the surrounding config object.
        inputSchema: definition.inputSchema as any
      },
      definition.handler
    );
  }
}

export function createMcpServer(options: ToolRuntimeOptions = {}): McpServer {
  const server = new McpServer({
    name: "code-mode-mcp",
    version: "1.2.0"
  });

  registerMcpTools(server, options);
  return server;
}

function configureStdioLogging(): void {
  console.log = (...args: any[]) => {
    process.stderr.write(util.format(...args) + "\n");
  };
  console.warn = (...args: any[]) => {
    process.stderr.write(util.format(...args) + "\n");
  };
}

async function initializeUtcpClient(): Promise<CodeModeUtcpClient> {
  if (utcpClient) {
    return utcpClient;
  }

  ensureCorePluginsInitialized();

  const cwd = process.cwd();
  const packageDir = __dirname;

  let configPath: string;
  let scriptDir: string;

  // Resolve the config path from (precedence): the environment — an inline
  // `UTCP_CONFIG_PATH=… code-mode-mcp` or a shell-profile export (e.g. ~/.zshrc)
  // — then the same keys from a local `.env`. Both UTCP_CONFIG_PATH and the
  // legacy UTCP_CONFIG_FILE are accepted. dotenv.config() does not override the
  // process env, so an inline override always wins over a stale `.env`.
  const dotenvParsed = dotenv.config().parsed ?? {};
  const envConfigPath =
    process.env.UTCP_CONFIG_PATH ??
    process.env.UTCP_CONFIG_FILE ??
    dotenvParsed.UTCP_CONFIG_PATH ??
    dotenvParsed.UTCP_CONFIG_FILE;

  if (envConfigPath) {
    configPath = path.resolve(envConfigPath);
    scriptDir = path.dirname(configPath);

    try {
      await fs.access(configPath);
    } catch {
      console.warn(`UTCP config file from UTCP_CONFIG_PATH/UTCP_CONFIG_FILE not found: ${configPath}`);
    }
  } else {
    configPath = path.resolve(cwd, ".utcp_config.json");
    scriptDir = cwd;

    try {
      await fs.access(configPath);
    } catch {
      configPath = path.resolve(packageDir, ".utcp_config.json");
      scriptDir = packageDir;
    }
  }

  let rawConfig: Record<string, unknown> = {};
  try {
    const configFileContent = await fs.readFile(configPath, "utf-8");
    rawConfig = JSON.parse(configFileContent) as Record<string, unknown>;
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read or parse .utcp_config.json. Error: ${error.message}`);
    }
  }

  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig(rawConfig);
  exclusionRegistry = registry;
  const clientConfig = new UtcpClientConfigSerializer().validateDict(sanitizedConfig) as UtcpClientConfig;
  utcpClient = createCleanToolNameClient(
    await CodeModeUtcpClient.create(scriptDir, clientConfig),
    exclusionRegistry
  ) as CodeModeUtcpClient;
  return utcpClient;
}

export async function startServer(options: ToolRuntimeOptions = {}): Promise<void> {
  configureStdioLogging();
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isExecutedDirectly(): boolean {
  const entrypoint = process.argv[1];
  return typeof entrypoint === "string" && path.resolve(entrypoint) === __filename;
}

if (isExecutedDirectly()) {
  startServer().catch((error) => {
    console.error("Failed to start code-mode-mcp:", error);
    process.exit(1);
  });
}
