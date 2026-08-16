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
 * Configured paths from environment and `.env` are validated together first.
 * Equal values are accepted; divergent `UTCP_CONFIG_FILE` / `UTCP_CONFIG_PATH`
 * values fail closed. After validation, an explicit CLI arg wins; otherwise
 * `UTCP_CONFIG_FILE` is canonical and `UTCP_CONFIG_PATH` is its legacy fallback.
 *
 * Tool names are written in canonical form (`manual.server.tool`), which the
 * exclusion matcher always recognizes. Edit the generated arrays to taste.
 *
 * For an interactive UI over the same data, use `npm run config-builder`.
 */

import { promises as fs } from "fs";
import path from "path";
import process from "process";

import { resolveConfigPath, discoverManuals } from "./lib/utcp-config.mjs";

const OUTPUT_DIR_NAME = "configs";
const OUTPUT_FILES = {
  excludeAll: "all-tools-excluded.utcp_config.json",
  includeAll: "all-tools-included-default-disabled.utcp_config.json"
};

function toolNamesByManual(manuals) {
  const map = new Map();
  for (const manual of manuals) {
    map.set(manual.name, manual.tools.map((tool) => tool.name).sort());
  }
  return map;
}

function toolsForTemplate(template, byManual) {
  const name = typeof template?.name === "string" ? template.name : undefined;
  return name ? byManual.get(name) ?? [] : [];
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

  const { rawConfig, templates, manuals, toolCount } = await discoverManuals(configPath, (msg) =>
    console.log(msg)
  );

  const byManual = toolNamesByManual(manuals);
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

  console.log(`Discovered ${toolCount} tool(s) across ${manuals.length} manual(s).`);
  console.log("Wrote:");
  console.log(`  ${excludeAllPath}`);
  console.log(`  ${includeAllPath}`);
}

main().catch((error) => {
  console.error(`generate-exclusion-configs failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
