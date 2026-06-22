#!/usr/bin/env node
/**
 * generate-exclusion-configs.mjs
 *
 * Reads a UTCP config (`.utcp_config.json`), registers every manual it declares,
 * discovers the actual tools each manual exposes, and emits two derived configs
 * under `configs/`:
 *
 *   1. all-tools-excluded.utcp_config.json
 *        Every manual gets an `exclude_tools` array listing ALL of its tools
 *        (a full denylist — registers the manual but hides every tool).
 *
 *   2. all-tools-included-default-disabled.utcp_config.json
 *        Every manual gets `default_disabled: true` plus an `include_tools`
 *        array listing ALL of its tools (allowlist form — behaves the same as
 *        the original config, but in explicit opt-in shape you can prune).
 *
 * The source config path is resolved with this precedence:
 *   1. CLI arg            — `node scripts/generate-exclusion-configs.mjs <path>`
 *                           or `--config <path>` / `--config=<path>`
 *   2. `.env` file        — `UTCP_CONFIG_PATH=...` (or `UTCP_CONFIG_FILE=...`)
 *   3. Environment vars   — `UTCP_CONFIG_PATH` (fallback `UTCP_CONFIG_FILE`)
 *
 * Tool names are written in canonical form (`manual.server.tool`), which the
 * exclusion matcher always recognizes. Edit the generated arrays to taste.
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

const OUTPUT_DIR_NAME = "configs";
const OUTPUT_FILES = {
  excludeAll: "all-tools-excluded.utcp_config.json",
  includeAll: "all-tools-included-default-disabled.utcp_config.json"
};

function parseCliConfigArg(argv) {
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

function resolveConfigPath() {
  const cliArg = parseCliConfigArg(process.argv);
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
        "  CLI:  node scripts/generate-exclusion-configs.mjs <path-to-.utcp_config.json>\n" +
        "  .env: UTCP_CONFIG_PATH=/abs/path/.utcp_config.json\n" +
        "  env:  UTCP_CONFIG_PATH=/abs/path/.utcp_config.json node scripts/generate-exclusion-configs.mjs"
    );
  }
  return path.resolve(resolved);
}

function groupToolNamesByManual(tools) {
  /** @type {Map<string, Set<string>>} */
  const byManual = new Map();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const dotIndex = name.indexOf(".");
    const manualName = dotIndex === -1 ? name : name.slice(0, dotIndex);
    if (!byManual.has(manualName)) {
      byManual.set(manualName, new Set());
    }
    byManual.get(manualName).add(name);
  }
  return byManual;
}

function toolsForTemplate(template, byManual) {
  const manualName = typeof template?.name === "string" ? template.name : undefined;
  if (!manualName) {
    return [];
  }
  const set = byManual.get(manualName);
  return set ? [...set].sort() : [];
}

function buildExcludeAllConfig(rawConfig, templates, byManual) {
  return {
    ...rawConfig,
    manual_call_templates: templates.map((template) => ({
      ...template,
      exclude_tools: toolsForTemplate(template, byManual)
    }))
  };
}

function buildIncludeAllConfig(rawConfig, templates, byManual) {
  return {
    ...rawConfig,
    manual_call_templates: templates.map((template) => ({
      ...template,
      default_disabled: true,
      include_tools: toolsForTemplate(template, byManual)
    }))
  };
}

async function main() {
  const configPath = resolveConfigPath();
  console.log(`Source config: ${configPath}`);

  const raw = await fs.readFile(configPath, "utf-8");
  const rawConfig = JSON.parse(raw);

  const templates = Array.isArray(rawConfig.manual_call_templates)
    ? rawConfig.manual_call_templates
    : [];
  if (templates.length === 0) {
    throw new Error(`No manual_call_templates found in ${configPath}`);
  }

  ensureCorePluginsInitialized();

  const scriptDir = path.dirname(configPath);
  const clientConfig = new UtcpClientConfigSerializer().validateDict(rawConfig);

  console.log(`Registering ${templates.length} manual(s) and discovering tools...`);
  const client = await CodeModeUtcpClient.create(scriptDir, clientConfig);
  const tools = await client.getTools();
  console.log(`Discovered ${tools.length} tool(s).`);

  const byManual = groupToolNamesByManual(tools);
  for (const template of templates) {
    const count = toolsForTemplate(template, byManual).length;
    if (count === 0) {
      console.warn(`  warning: manual '${template?.name}' exposed 0 tools (none to list).`);
    } else {
      console.log(`  ${template?.name}: ${count} tool(s)`);
    }
  }

  const outputDir = path.resolve(process.cwd(), OUTPUT_DIR_NAME);
  await fs.mkdir(outputDir, { recursive: true });

  const excludeAllPath = path.join(outputDir, OUTPUT_FILES.excludeAll);
  const includeAllPath = path.join(outputDir, OUTPUT_FILES.includeAll);

  await fs.writeFile(
    excludeAllPath,
    JSON.stringify(buildExcludeAllConfig(rawConfig, templates, byManual), null, 2) + "\n"
  );
  await fs.writeFile(
    includeAllPath,
    JSON.stringify(buildIncludeAllConfig(rawConfig, templates, byManual), null, 2) + "\n"
  );

  console.log("Wrote:");
  console.log(`  ${excludeAllPath}`);
  console.log(`  ${includeAllPath}`);
}

main().catch((error) => {
  console.error(`generate-exclusion-configs failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
