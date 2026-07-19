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

// Flags that consume the FOLLOWING token as their value, so that value must not
// be mistaken for the positional config path (e.g. `--port 7821`, `--host ::1`).
const VALUE_FLAGS = new Set(["--port", "--host"]);

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
    // Skip a value-taking flag's value so `--port 7821` doesn't read "7821" as
    // the config path (the bug that shadowed UTCP_CONFIG_PATH/_FILE).
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

/**
 * Resolve the source config path with precedence:
 *   1. explicit arg (or CLI arg)   2. environment variable   3. `.env` value
 * Recognizes UTCP_CONFIG_PATH then UTCP_CONFIG_FILE in both env and .env.
 */
export function resolveConfigPath(explicit) {
  const cliArg = explicit ?? parseCliConfigArg(process.argv);
  // Capture the `.env`-parsed values (dotenv.config() does NOT override existing
  // process env). Precedence: explicit/CLI arg, then the environment (an inline
  // `UTCP_CONFIG_PATH=… cmd` or a shell-profile export like ~/.zshrc), then a
  // local `.env`. Environment wins over `.env` so an inline override is never
  // silently shadowed by a stale `.env`. Both UTCP_CONFIG_PATH and the legacy
  // UTCP_CONFIG_FILE are recognized in every source.
  const fromDotenv = dotenv.config().parsed ?? {};
  const resolved =
    cliArg ??
    process.env.UTCP_CONFIG_PATH ??
    process.env.UTCP_CONFIG_FILE ??
    fromDotenv.UTCP_CONFIG_PATH ??
    fromDotenv.UTCP_CONFIG_FILE;

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
 * Mirror the UTCP SDK's manual-name → identifier sanitization. The SDK prefixes
 * each discovered tool with this sanitized form (e.g. "salesforce-mcp" is filed
 * as "salesforce_mcp"), so we normalize a config template name the same way when
 * matching tools back to their template. Without this, every hyphenated manual
 * looks empty AND spawns a duplicate orphan manual under the sanitized name.
 */
function toManualIdentifier(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}

// --- Clean tool-name exposure (mirrors index.ts buildToolAliasIndex) ----------
// Raw MCP tool names are `<sanitizedManual>.<serverKey>.<tool>`. When the manual
// has a single server (or the server segment just duplicates the manual), the
// runtime collapses that to `<sanitizedManual>.<tool>`. We apply the identical
// collapse during discovery so the names written into include_tools/exclude_tools
// match the runtime-exposed names exactly (and aren't doubled).
function sanitizeSegment(name) {
  return toManualIdentifier(name).toLowerCase();
}

function mcpServerNamesOf(tool) {
  const tmpl = tool?.tool_call_template;
  if (!tmpl || tmpl.call_template_type !== "mcp") return [];
  const servers = tmpl.config?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

function aliasCandidateOf(tool) {
  const parts = String(tool.name).split(".");
  if (parts.length < 3) return tool.name;
  const [manualName, serverName, ...toolParts] = parts;
  if (!manualName || !serverName || toolParts.length === 0) return tool.name;
  const servers = mcpServerNamesOf(tool);
  const singleServer = servers.length === 1;
  const duplicateSegment = sanitizeSegment(manualName) === sanitizeSegment(serverName);
  if (!singleServer && !duplicateSegment) return tool.name;
  return `${manualName}.${toolParts.join(".")}`;
}

/** Collapse the redundant server segment, only when the alias stays unique. */
function exposeCleanToolNames(tools) {
  const canonical = new Set(tools.map((t) => t.name));
  const candidates = new Map();
  const counts = new Map();
  for (const tool of tools) {
    const alias = aliasCandidateOf(tool);
    candidates.set(tool.name, alias);
    counts.set(alias, (counts.get(alias) ?? 0) + 1);
  }
  return tools.map((tool) => {
    const alias = candidates.get(tool.name) ?? tool.name;
    const canUse = alias !== tool.name && counts.get(alias) === 1 && !canonical.has(alias);
    return canUse ? { ...tool, name: alias } : tool;
  });
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
          // Give cold-starting stdio servers room to boot + authenticate before
          // discovery times out. The MCP plugin defaults to 30s per operation,
          // too tight for `npx`/`uv`-launched servers that fetch tokens or warm
          // a browser on first run — the main cause of "0 tools" manuals.
          if (server.timeout === undefined) server.timeout = DISCOVERY_TIMEOUT_SECONDS;
        }
      }
    }
  }
  return clone;
}

/** Per-server discovery timeout (seconds) injected for cold-starting servers. */
const DISCOVERY_TIMEOUT_SECONDS = 90;

/** Max discovery passes: 1 initial + (N-1) retries targeting only empty manuals. */
const MAX_DISCOVERY_ATTEMPTS = 3;

/**
 * Deep-clone the config keeping ONLY the named manual templates (all force-enabled
 * and timeout-bumped). Used to re-discover just the manuals that returned no tools,
 * so a retry pass doesn't needlessly relaunch every server.
 */
function withOnlyTemplates(rawConfig, names) {
  const clone = withAllManualsEnabled(rawConfig);
  const keep = new Set(names);
  clone.manual_call_templates = (Array.isArray(clone.manual_call_templates)
    ? clone.manual_call_templates
    : []
  ).filter((t) => t && typeof t === "object" && keep.has(t.name));
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
  const serializer = new UtcpClientConfigSerializer();

  const allTemplateNames = templates
    .map((t) => (typeof t?.name === "string" ? t.name : null))
    .filter((n) => n !== null);

  // Tools merged across attempts, deduped by full tool name so a retry can only
  // ADD tools, never duplicate. Map<manualName, Map<toolName, tool>>.
  const merged = new Map();
  const mergeTools = (tools) => {
    for (const tool of tools) {
      const name = tool?.name;
      if (typeof name !== "string" || name.length === 0) continue;
      const manual = manualNameOf(name);
      if (!merged.has(manual)) merged.set(manual, new Map());
      merged.get(manual).set(name, {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        tags: Array.isArray(tool.tags) ? tool.tags.filter((t) => typeof t === "string") : []
      });
    }
  };
  // Tools are filed under the SDK's sanitized manual identifier, which differs
  // from the config template name (e.g. "salesforce-mcp" → "salesforce_mcp").
  // Look up by both so a hyphenated manual matches its tools instead of looking
  // empty (which would also spawn a duplicate orphan manual + wasted retries).
  const mergedFor = (n) => merged.get(n) ?? merged.get(toManualIdentifier(n));
  const emptyTemplateNames = () =>
    allTemplateNames.filter((n) => {
      const m = mergedFor(n);
      return !m || m.size === 0;
    });

  // Discover with bounded retries. Pass 1 launches everything; each later pass
  // relaunches ONLY the manuals that still returned no tools (the usual victims
  // of a cold-start timeout race), so flaky servers get extra chances without
  // re-paying for the ones that already succeeded.
  for (let attempt = 1; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt++) {
    const missing = attempt === 1 ? allTemplateNames : emptyTemplateNames();
    if (attempt > 1) {
      if (missing.length === 0) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
      onProgress(`Retry ${attempt - 1}/${MAX_DISCOVERY_ATTEMPTS - 1}: re-discovering ${missing.length} manual(s) with no tools…`);
    } else {
      onProgress(`Registering ${templates.length} manual(s) and discovering tools...`);
    }

    const subConfig = attempt === 1
      ? withAllManualsEnabled(rawConfig)
      : withOnlyTemplates(rawConfig, missing);
    try {
      const clientConfig = serializer.validateDict(subConfig);
      const client = await CodeModeUtcpClient.create(scriptDir, clientConfig);
      const tools = exposeCleanToolNames(await client.getTools());
      mergeTools(tools);
    } catch (err) {
      onProgress(`Discovery attempt ${attempt} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Flatten the deduped Map<toolName, tool> stores into plain arrays.
  const byManual = new Map();
  for (const [manualName, toolMap] of merged) {
    byManual.set(manualName, [...toolMap.values()]);
  }
  const totalTools = [...byManual.values()].reduce((sum, list) => sum + list.length, 0);
  onProgress(`Discovered ${totalTools} tool(s).`);

  const manuals = templates.map((template) => {
    const name = typeof template?.name === "string" ? template.name : "(unnamed)";
    const list = (byManual.get(name) ?? byManual.get(toManualIdentifier(name)) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
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
  // Match on the sanitized identifier too, so a template's own tools (filed
  // under the sanitized name) are not re-added as a duplicate orphan manual.
  const knownManualKeys = new Set();
  for (const t of templates) {
    const tn = typeof t?.name === "string" ? t.name : null;
    if (tn) {
      knownManualKeys.add(tn);
      knownManualKeys.add(toManualIdentifier(tn));
    }
  }
  for (const [manualName, list] of byManual) {
    if (!knownManualKeys.has(manualName) && !manuals.some((m) => m.name === manualName)) {
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
    toolCount: totalTools,
    manuals,
    toolsByManual: byManual
  };
}
