/**
 * Shared UTCP config helpers for the exclusion tooling (generator + config builder).
 *
 * Resolves a `.utcp_config.json` path, registers its manuals, and discovers the
 * real tools each manual exposes. The `.utcp_config.json` only declares manuals;
 * tool names are only known after registration, so discovery requires creating a
 * client.
 */

import { promises as fs } from "fs";
import path from "path";
import process from "process";

import dotenv from "dotenv";

// UTCP protocol plugins — imported for their side-effect registration so the
// client can construct HTTP / MCP / CLI / file / text manuals from the config.
import "@utcp/http";
import "@utcp/text";
import "@utcp/mcp";
import "@utcp/cli";
import "@utcp/dotenv-loader";
import "@utcp/file";

import { UtcpClientConfigSerializer, ensureCorePluginsInitialized } from "@utcp/sdk";
import { CodeModeUtcpClient } from "@utcp/code-mode";

/** Parse a config path from argv: first positional, or `--config <path>` / `-c <path>` / `--config=<path>`. */
export function parseCliConfigArg(argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      return args[i + 1];
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

/**
 * Resolve the source config path with precedence:
 *   1. explicit arg (or CLI arg)   2. `.env` value   3. environment variable
 * Recognizes UTCP_CONFIG_PATH then UTCP_CONFIG_FILE in both .env and env.
 */
export function resolveConfigPath(explicit) {
  const cliArg = explicit ?? parseCliConfigArg(process.argv);
  // dotenv.config() does NOT override existing env vars; capture the .env-parsed
  // value separately so a `.env` entry wins over a pre-existing environment var.
  const fromDotenv = dotenv.config().parsed ?? {};
  const resolved =
    cliArg ??
    fromDotenv.UTCP_CONFIG_PATH ??
    fromDotenv.UTCP_CONFIG_FILE ??
    process.env.UTCP_CONFIG_PATH ??
    process.env.UTCP_CONFIG_FILE;

  if (!resolved) {
    throw new Error(
      "No UTCP config path provided.\n" +
        "Provide one via:\n" +
        "  CLI:  <command> <path-to-.utcp_config.json>\n" +
        "  .env: UTCP_CONFIG_PATH=/abs/path/.utcp_config.json\n" +
        "  env:  UTCP_CONFIG_PATH=/abs/path/.utcp_config.json <command>"
    );
  }
  return path.resolve(resolved);
}

/** Read and parse the raw config JSON, returning { rawConfig, templates }. */
export async function loadConfig(configPath) {
  const raw = await fs.readFile(configPath, "utf-8");
  const rawConfig = JSON.parse(raw);
  const templates = Array.isArray(rawConfig.manual_call_templates)
    ? rawConfig.manual_call_templates
    : [];
  return { rawConfig, templates };
}

function manualNameOf(toolName) {
  const dotIndex = toolName.indexOf(".");
  return dotIndex === -1 ? toolName : toolName.slice(0, dotIndex);
}

/**
 * Force-enable every manual and MCP server so discovery sees all their tools,
 * regardless of `enabled: false` / `disabled: true` flags in the source config.
 * Operates on a deep clone — the original config is untouched (so the generated
 * output preserves the user's enabled/disabled settings).
 */
export function withAllManualsEnabled(rawConfig) {
  const clone = JSON.parse(JSON.stringify(rawConfig));
  const templates = Array.isArray(clone.manual_call_templates) ? clone.manual_call_templates : [];
  for (const template of templates) {
    if (!template || typeof template !== "object") continue;
    template.enabled = true;
    delete template.disabled;
    const servers = template.config?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const server of Object.values(servers)) {
        if (server && typeof server === "object") {
          server.enabled = true;
          delete server.disabled;
        }
      }
    }
  }
  return clone;
}

/**
 * Register every manual in the config and discover its tools.
 *
 * Returns:
 *   {
 *     configPath, rawConfig, templates, toolCount,
 *     manuals: [{ name, type, defaultDisabled, exclude_tools, include_tools,
 *                 tools: [{ name, description, tags }] }],
 *     toolsByManual: Map<manualName, Tool[]>
 *   }
 *
 * `onProgress(message)` is called with human-readable status lines.
 */
export async function discoverManuals(configPath, onProgress = () => {}) {
  const { rawConfig, templates } = await loadConfig(configPath);
  if (templates.length === 0) {
    throw new Error(`No manual_call_templates found in ${configPath}`);
  }

  ensureCorePluginsInitialized();

  const scriptDir = path.dirname(configPath);
  const clientConfig = new UtcpClientConfigSerializer().validateDict(withAllManualsEnabled(rawConfig));

  onProgress(`Registering ${templates.length} manual(s) and discovering tools...`);
  const client = await CodeModeUtcpClient.create(scriptDir, clientConfig);
  const tools = await client.getTools();
  onProgress(`Discovered ${tools.length} tool(s).`);

  const byManual = new Map();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const manual = manualNameOf(name);
    if (!byManual.has(manual)) {
      byManual.set(manual, []);
    }
    byManual.get(manual).push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      tags: Array.isArray(tool.tags) ? tool.tags.filter((t) => typeof t === "string") : []
    });
  }

  const manuals = templates.map((template) => {
    const name = typeof template?.name === "string" ? template.name : "(unnamed)";
    const list = (byManual.get(name) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return {
      name,
      type: typeof template?.call_template_type === "string" ? template.call_template_type : "unknown",
      defaultDisabled: template?.default_disabled === true,
      exclude_tools: Array.isArray(template?.exclude_tools) ? template.exclude_tools : [],
      include_tools: Array.isArray(template?.include_tools) ? template.include_tools : [],
      tools: list
    };
  });

  // Surface any discovered manuals that have no matching template (rare).
  for (const [manualName, list] of byManual) {
    if (!manuals.some((m) => m.name === manualName)) {
      manuals.push({
        name: manualName,
        type: "unknown",
        defaultDisabled: false,
        exclude_tools: [],
        include_tools: [],
        tools: list.slice().sort((a, b) => a.name.localeCompare(b.name))
      });
    }
  }

  return {
    configPath,
    rawConfig,
    templates,
    toolCount: tools.length,
    manuals,
    toolsByManual: byManual
  };
}
