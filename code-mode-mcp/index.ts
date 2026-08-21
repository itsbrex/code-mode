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
import { resolveUtcpConfigPath } from "./config-path.mjs";

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
  sanitizeManualName,
  type ToolExclusionRegistry
} from "./tool-exclusion.js";

export * from "./tool-exclusion.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read-only bridge tools advertise MCP annotations so hosts can treat them as
// side-effect-free (ported from upstream's readOnlyHint change onto our
// getToolDefinitions architecture).
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  idempotentHint: true
} as const;

let utcpClient: CodeModeUtcpClient | null = null;
let exclusionAwareClient: CodeModeMcpClientLike | null = null;
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
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };
  handler: (input: any) => Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

interface SerializedToolSummary {
  utcp_name: string;
  access_name: string;
  description: string;
  tags: string[];
}

interface ToolAliasIndex {
  aliasToCanonical: Map<string, string>;
  canonicalToAlias: Map<string, string>;
  canonicalNames: Set<string>;
}

interface ToolNameResolution {
  rawName: string;
  preferredAccessName: string;
  legacyAccessName: string;
  selectedAccessName: string;
  exposedAccessName: string;
}

export function sanitizeIdentifier(name: string): string {
  // Delegates to the canonical sanitizer in tool-exclusion.ts so every TS call
  // site shares one implementation (parity with scripts/lib/manual-name.mjs is
  // test-enforced).
  return sanitizeManualName(name);
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
  const sanitizedManualName = sanitizeIdentifier(manualName);
  const sanitizedServerName = sanitizeIdentifier(serverName);
  const originalToolName = toolParts.map((part) => sanitizeIdentifier(part)).join("_");
  const hasDuplicateToolPrefix = [sanitizedServerName, sanitizedManualName].some(
    (prefix) => prefix.length > 0 && originalToolName.startsWith(`${prefix}_`)
  );

  if (!isSingleServerManual && !isDuplicateServerSegment && !hasDuplicateToolPrefix) {
    return tool.name;
  }

  let conciseToolName = originalToolName;
  for (const prefix of [sanitizedServerName, sanitizedManualName]) {
    if (prefix.length > 0 && conciseToolName.startsWith(`${prefix}_`)) {
      conciseToolName = conciseToolName.slice(prefix.length + 1);
    }
  }

  if (!conciseToolName) {
    conciseToolName = originalToolName;
  }

  return `${sanitizedManualName}.${conciseToolName}`;
}

function encodeAccessNameSuffix(rawName: string): string {
  return Buffer.from(rawName, "utf8").toString("hex");
}

function disambiguateAccessName(accessName: string, rawName: string): string {
  return `${accessName}__raw_${encodeAccessNameSuffix(rawName)}`;
}

function countAccessNames(
  resolutions: ToolNameResolution[],
  selectName: (resolution: ToolNameResolution) => string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const resolution of resolutions) {
    const name = selectName(resolution);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function buildToolAliasIndex(tools: Tool[]): ToolAliasIndex {
  const canonicalNames = new Set(tools.map((tool) => tool.name));
  const resolutions: ToolNameResolution[] = tools.map((tool) => {
    const preferredAccessName = utcpNameToTsInterfaceName(getMcpToolAliasCandidate(tool));
    const legacyAccessName = utcpNameToTsInterfaceName(tool.name);
    return {
      rawName: tool.name,
      preferredAccessName,
      legacyAccessName,
      selectedAccessName: legacyAccessName,
      exposedAccessName: legacyAccessName
    };
  });
  const preferredCounts = countAccessNames(
    resolutions,
    (resolution) => resolution.preferredAccessName
  );
  const legacyCounts = countAccessNames(
    resolutions,
    (resolution) => resolution.legacyAccessName
  );

  for (const resolution of resolutions) {
    const preferredShadowsCanonical =
      (canonicalNames.has(resolution.preferredAccessName) &&
        resolution.preferredAccessName !== resolution.rawName) ||
      (legacyCounts.get(resolution.preferredAccessName) ?? 0) > 0;
    const canUsePreferred =
      resolution.preferredAccessName !== resolution.legacyAccessName &&
      preferredCounts.get(resolution.preferredAccessName) === 1 &&
      !preferredShadowsCanonical;
    resolution.selectedAccessName = canUsePreferred
      ? resolution.preferredAccessName
      : resolution.legacyAccessName;
    resolution.exposedAccessName = resolution.selectedAccessName;
  }

  const selectedCounts = countAccessNames(
    resolutions,
    (resolution) => resolution.selectedAccessName
  );
  const usedAccessNames = new Set<string>();
  for (const resolution of resolutions) {
    if (selectedCounts.get(resolution.selectedAccessName) === 1) {
      usedAccessNames.add(resolution.selectedAccessName);
    }
    if (legacyCounts.get(resolution.legacyAccessName) === 1) {
      usedAccessNames.add(resolution.legacyAccessName);
    }
  }

  for (const resolution of resolutions) {
    if ((selectedCounts.get(resolution.selectedAccessName) ?? 0) > 1) {
      resolution.exposedAccessName = disambiguateAccessName(
        resolution.selectedAccessName,
        resolution.rawName
      );
      while (usedAccessNames.has(resolution.exposedAccessName)) {
        resolution.exposedAccessName = disambiguateAccessName(
          resolution.exposedAccessName,
          resolution.rawName
        );
      }
    }
    usedAccessNames.add(resolution.exposedAccessName);
  }

  const canonicalToAlias = new Map(
    resolutions.map((resolution) => [resolution.rawName, resolution.exposedAccessName])
  );
  const aliasToCanonical = new Map<string, string>();
  for (const resolution of resolutions) {
    if (
      resolution.exposedAccessName !== resolution.rawName &&
      !canonicalNames.has(resolution.exposedAccessName)
    ) {
      aliasToCanonical.set(resolution.exposedAccessName, resolution.rawName);
    }

    if (
      resolution.legacyAccessName !== resolution.rawName &&
      legacyCounts.get(resolution.legacyAccessName) === 1 &&
      !canonicalNames.has(resolution.legacyAccessName) &&
      !aliasToCanonical.has(resolution.legacyAccessName)
    ) {
      aliasToCanonical.set(resolution.legacyAccessName, resolution.rawName);
    }
  }

  return { aliasToCanonical, canonicalToAlias, canonicalNames };
}

function exposeToolAlias(tool: Tool, index: ToolAliasIndex): Tool {
  const alias = index.canonicalToAlias.get(tool.name);
  if (!alias || alias === tool.name) {
    return tool;
  }

  return {
    ...tool,
    name: alias,
    utcp_name: tool.name
  } as Tool;
}

async function findToolWithAliases(
  tools: Tool[],
  name: string
): Promise<{ tool: Tool; utcpName: string } | null> {
  const index = buildToolAliasIndex(tools);
  const canonicalName = index.canonicalNames.has(name)
    ? name
    : index.aliasToCanonical.get(name);

  if (canonicalName) {
    const tool = tools.find((candidate) => candidate.name === canonicalName);
    if (tool) {
      return { tool: exposeToolAlias(tool, index), utcpName: canonicalName };
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
    if (index.canonicalNames.has(toolName)) {
      return toolName;
    }
    return index.aliasToCanonical.get(toolName) ?? toolName;
  };

  const assertNotExcluded = (requestedName: string, canonicalName: string): void => {
    if (isExcluded(canonicalName)) {
      throw new Error(`Tool '${requestedName}' is disabled by the manual exclusion config.`);
    }
  };

  const getTools = async () => {
    const tools = await getVisibleCanonicalTools();
    const index = buildToolAliasIndex(tools);
    return tools.map((tool) => exposeToolAlias(tool, index));
  };

  const searchTools = async (taskDescription: string, limit?: number) => {
    const [matchedTools, visibleTools] = await Promise.all([
      searchCanonicalTools(taskDescription, limit),
      getVisibleCanonicalTools()
    ]);
    const index = buildToolAliasIndex(visibleTools);
    return matchedTools
      .filter((tool) => !isExcluded(tool.name))
      .map((tool) => exposeToolAlias(tool, index));
  };

  const callTool = async (toolName: string, toolArgs: unknown) => {
    const canonical = await resolveToolName(toolName);
    assertNotExcluded(toolName, canonical);
    return callCanonicalTool(canonical, toolArgs);
  };

  const getRequiredVariablesForRegisteredTool = async (toolName: string) => {
    const canonical = await resolveToolName(toolName);
    assertNotExcluded(toolName, canonical);
    return getCanonicalRequiredVariables(canonical);
  };

  const findToolByAlias = async (name: string) => {
    return findToolWithAliases(await getVisibleCanonicalTools(), name);
  };

  const overrides: Record<PropertyKey, unknown> = {
    getTools,
    searchTools,
    callTool,
    getRequiredVariablesForRegisteredTool,
    __findToolByName: findToolByAlias
  };

  return new Proxy(client, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(receiver) : value;
    }
  });
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

You have access to a UTCP Code Mode MCP server that exposes UTCP-native discovery and TypeScript tool execution.

## Workflow: Always Follow This Pattern

### 1. Discover tools first
- Use \`search_tools\` to find relevant UTCP tools for the task.
- Use \`list_tools\` to inspect the currently registered UTCP tool set.
- Use \`tools_info\` to inspect full tool interfaces before writing execution code.
- Use \`get_required_keys_for_tool\` when you need to know which environment variables a tool depends on.
- \`get_required_variables_for_tool\` is a deprecated compatibility alias.

${CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE}

## Execution notes for this server
- \`call_tool_chain\` runs your code as the body of an \`async function\`: \`return\` the value you want and use top-level \`await\` freely.
- Tool calls work both ways — \`manual.tool(args)\` (the host bridges the async call synchronously) or \`await manual.tool(args)\` if you prefer async style. Both are valid; pick whichever reads better.
- Executed code must be valid JavaScript syntax: do not put type annotations (\`: string\`) or \`interface\` declarations in the code you run. The generated TypeScript interfaces are reference documentation for building correct argument objects — they are not runnable syntax and will throw a SyntaxError inside the sandbox.
- Canonical \`call_tool_chain\` returns the upstream \`{ success, nonMcpContentResults, logs }\` text envelope while preserving MCP content blocks.

Remember: discover first, inspect interfaces second, execute code last.`;
}

function serializeToolSummary(tool: Tool): SerializedToolSummary {
  const rawName =
    typeof (tool as Tool & { utcp_name?: unknown }).utcp_name === "string"
      ? ((tool as Tool & { utcp_name: string }).utcp_name)
      : tool.name;
  return {
    utcp_name: rawName,
    access_name: utcpNameToTsInterfaceName(tool.name),
    description: tool.description ?? "",
    tags: Array.isArray(tool.tags) ? tool.tags : []
  };
}

// Cycle-safe JSON serialization. Tool schemas can contain circular references
// (recursive JSON Schemas whose $refs get dereferenced into live object cycles,
// e.g. Salesforce's SOSL/SOQL filter grammar). A plain JSON.stringify throws
// "Converting circular structure to JSON" on those, which would take down the
// entire discovery response. Fast path keeps exact output for the common
// (acyclic) case — including legitimate shared/DAG references — and only falls
// back to a cycle-breaking pass when a real cycle would otherwise crash us.
export function safeJsonStringify(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    const ancestors: unknown[] = [];
    return JSON.stringify(
      value,
      function (this: unknown, _key, val) {
        if (typeof val !== "object" || val === null) {
          return val;
        }
        // Drop objects that are an ancestor of themselves (a true cycle),
        // not merely re-referenced siblings in a DAG.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(val)) {
          return "[Circular]";
        }
        ancestors.push(val);
        return val;
      },
      space
    );
  }
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
        text: truncateText(safeJsonStringify(payload, 2), maxOutputSize)
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

function buildCanonicalCallToolChainResponse(
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

  const plainContent =
    nonMcpResults.length > 1 ? nonMcpResults : nonMcpResults[0];
  content.push({
    type: "text",
    text: truncateText(
      JSON.stringify({
        success: true,
        nonMcpContentResults: plainContent,
        logs
      }),
      maxOutputSize
    )
  });

  return { content };
}

export function getCanonicalToolDefinitions(
  options: ToolRuntimeOptions = {}
): ToolDefinition[] {
  // The canonical seven serve the exclusion-aware client by default: exclusion
  // filtering, clean access-name aliases, and the sandbox tool set all apply on
  // the upstream wire (schemas and envelopes stay snapshot-identical to 1.2.1).
  const getClient = options.getClient ?? initializeExclusionAwareClient;
  const canonicalRegisterManual: ToolDefinition = {
    name: "register_manual",
    title: "Register a UTCP Manual",
    description: "Registers a new tool provider by providing its call template.",
    inputSchema: {
      manual_call_template: CallTemplateSchema.describe(
        "The call template for the UTCP Manual endpoint."
      )
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        // Optional exclude_tools / include_tools / default_disabled fields are
        // recorded in the exclusion registry and stripped before the template
        // reaches the SDK.
        const sanitizedTemplate = applyManualExclusion(
          exclusionRegistry,
          input.manual_call_template as Record<string, unknown>
        );
        const result = await client.registerManual(sanitizedTemplate as any);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ]
        };
      }
    }
  };
  const canonicalDeregisterManual: ToolDefinition = {
    name: "deregister_manual",
    title: "Deregister a UTCP Manual",
    description: "Deregisters a tool provider from the UTCP client.",
    inputSchema: {
      manual_name: z.string().describe("The name of the manual to deregister.")
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        const success = await client.deregisterManual(input.manual_name);
        if (success) {
          // applyManualExclusion registers the rule under BOTH the raw manual
          // name and its sanitized identifier (e.g. "proxyman-mcp" AND
          // "proxyman_mcp") — clear both so no stale rule survives under the
          // sanitized alias.
          exclusionRegistry.delete(input.manual_name);
          exclusionRegistry.delete(sanitizeIdentifier(input.manual_name));
        }
        const message = success
          ? `Manual '${input.manual_name}' deregistered.`
          : `Manual '${input.manual_name}' not found.`;
        return {
          content: [{ type: "text", text: JSON.stringify({ success, message }) }]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ]
        };
      }
    }
  };
  const canonicalSearchTools: ToolDefinition = {
    name: "search_tools",
    annotations: READ_ONLY_ANNOTATIONS,
    title: "Search for UTCP Tools",
    description: "Searches for relevant tools based on a task description.",
    inputSchema: {
      task_description: z.string().describe("A natural language description of the task."),
      limit: z.number().optional().default(10)
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        const tools = await client.searchTools(input.task_description, input.limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: tools.map((tool) => ({
                  name: utcpNameToTsInterfaceName(tool.name),
                  description: tool.description,
                  typescript_interface: client.toolToTypeScriptInterface(tool)
                }))
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ]
        };
      }
    }
  };
  const canonicalListTools: ToolDefinition = {
    name: "list_tools",
    annotations: READ_ONLY_ANNOTATIONS,
    title: "List All Registered UTCP Tools",
    description: "Returns a list of all tool names currently registered.",
    inputSchema: {},
    handler: async () => {
      try {
        const client = await getClient();
        const tools = await client.getTools();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: tools.map((tool) => utcpNameToTsInterfaceName(tool.name))
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }
          ]
        };
      }
    }
  };
  const canonicalRequiredKeys: ToolDefinition = {
    name: "get_required_keys_for_tool",
    annotations: READ_ONLY_ANNOTATIONS,
    title: "Get Required Variables for Tool",
    description: "Get required environment variables for a registered tool.",
    inputSchema: {
      tool_name: z.string().describe("Name of the tool to get required variables for.")
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        const found = await findToolByName(client, input.tool_name);
        if (!found) {
          return {
            isError: true,
            content: [{ type: "text", text: `Tool '${input.tool_name}' not found` }]
          };
        }
        const variables = await client.getRequiredVariablesForRegisteredTool(found.utcpName);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                tool_name: input.tool_name,
                required_variables: variables
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool_name: input.tool_name,
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ]
        };
      }
    }
  };
  const canonicalToolsInfo: ToolDefinition = {
    name: "tools_info",
    annotations: READ_ONLY_ANNOTATIONS,
    title: "Get Tools Information with TypeScript Interface",
    description:
      "Get complete information about a specified list of tools, including TypeScript interface definition.",
    inputSchema: {
      tool_names: z
        .array(z.string())
        .describe("Names of the tools to get complete information for.")
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        const typescriptInterfaces: string[] = [];
        const infos: string[] = [];
        for (const name of input.tool_names) {
          const found = await findToolByName(client, name);
          if (found) {
            typescriptInterfaces.push(client.toolToTypeScriptInterface(found.tool));
          } else {
            infos.push(`// Tool '${name}' not found`);
          }
        }

        if (typescriptInterfaces.length === 0 && infos.length > 0) {
          return { isError: true, content: [{ type: "text", text: infos.join("\n\n") }] };
        }

        let fullContent = typescriptInterfaces.join("\n\n");
        if (infos.length > 0) {
          fullContent += `\n\n${infos.join("\n")}`;
        }
        return { content: [{ type: "text", text: fullContent }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) }
          ]
        };
      }
    }
  };
  const canonicalCallToolChain: ToolDefinition = {
    name: "call_tool_chain",
    title: "Execute TypeScript Code with Tool Access",
    description:
      "Execute TypeScript code with direct access to all registered tools as hierarchical functions (e.g., manual.tool()).",
    inputSchema: {
      code: z
        .string()
        .describe("TypeScript code to execute with access to all registered tools."),
      timeout: z
        .number()
        .optional()
        .default(30_000)
        .describe("Optional timeout in milliseconds (default: 30000)."),
      max_output_size: z
        .number()
        .optional()
        .default(200_000)
        .describe("Optional maximum output size in characters (default: 200000).")
    },
    handler: async (input) => {
      try {
        const client = await getClient();
        const { result, logs } = await client.callToolChain(input.code, input.timeout);
        return buildCanonicalCallToolChainResponse(
          result,
          logs,
          input.max_output_size
        );
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) }
          ]
        };
      }
    }
  };

  return [
    canonicalRegisterManual,
    canonicalDeregisterManual,
    canonicalSearchTools,
    canonicalListTools,
    canonicalRequiredKeys,
    canonicalToolsInfo,
    canonicalCallToolChain
  ];
}

export function getCompatibilityToolDefinitions(
  options: ToolRuntimeOptions = {}
): ToolDefinition[] {
  const getClient = options.getClient ?? initializeExclusionAwareClient;

  return [
    {
      name: "get_required_variables_for_tool",
      annotations: READ_ONLY_ANNOTATIONS,
      title: "Get Required Variables for a UTCP Tool",
      description:
        "Deprecated compatibility alias for get_required_keys_for_tool. Return the required environment variables for a registered UTCP tool.",
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
            access_name: serializeToolSummary(found.tool).access_name,
            required_variables: requiredVariables
          });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
    }
  ];
}

export function getToolDefinitions(options: ToolRuntimeOptions = {}): ToolDefinition[] {
  return [
    ...getCanonicalToolDefinitions(options),
    ...getCompatibilityToolDefinitions(options)
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
        annotations: definition.annotations,
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
    name: "@itsbrex/code-mode-mcp",
    // Keep in sync with package.json "version".
    version: "1.3.0"
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

export function resolveServerConfigPath({
  environment = process.env,
  dotenvValues,
  cwd = process.cwd()
}: {
  environment?: Record<string, string | undefined>;
  dotenvValues?: Record<string, string | undefined>;
  cwd?: string;
} = {}): string | undefined {
  const fromDotenv = dotenvValues ?? dotenv.config().parsed ?? {};
  return resolveUtcpConfigPath({
    environment,
    dotenvValues: fromDotenv,
    cwd
  });
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

  const envConfigPath = resolveServerConfigPath();

  if (envConfigPath) {
    configPath = path.resolve(envConfigPath);
    scriptDir = path.dirname(configPath);

    try {
      await fs.access(configPath);
    } catch {
      console.warn(`UTCP config file from UTCP_CONFIG_FILE/UTCP_CONFIG_PATH not found: ${configPath}`);
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
  utcpClient = await CodeModeUtcpClient.create(scriptDir, clientConfig);
  exclusionAwareClient = createCleanToolNameClient(utcpClient, exclusionRegistry);
  return utcpClient;
}

async function initializeExclusionAwareClient(): Promise<CodeModeMcpClientLike> {
  if (exclusionAwareClient) {
    return exclusionAwareClient;
  }
  const client = await initializeUtcpClient();
  exclusionAwareClient = createCleanToolNameClient(client, exclusionRegistry);
  return exclusionAwareClient;
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
