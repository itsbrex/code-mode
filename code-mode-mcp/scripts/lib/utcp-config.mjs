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
import { resolveUtcpConfigPath } from "../../config-path.mjs";

// UTCP protocol plugins — imported for their side-effect registration so the
// client can construct HTTP / MCP / CLI / file / text manuals from the config.
import "@utcp/http";
import "@utcp/text";
import "@utcp/mcp";
import "@utcp/cli";
import "@utcp/dotenv-loader";
import "@utcp/file";

import { CallTemplateSerializer, UtcpClientConfigSerializer, ensureCorePluginsInitialized } from "@utcp/sdk";
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
 * Uses UTCP_CONFIG_FILE as canonical and UTCP_CONFIG_PATH as legacy fallback.
 * Equal duplicates are allowed; divergent configured values fail closed.
 */
export function resolveConfigPath(
  explicit,
  {
    argv = process.argv,
    environment = process.env,
    dotenvValues,
    cwd = process.cwd()
  } = {}
) {
  const cliArg = explicit ?? parseCliConfigArg(argv);
  const fromDotenv = dotenvValues ?? dotenv.config().parsed ?? {};
  const resolved = resolveUtcpConfigPath({
    explicit: cliArg,
    environment,
    dotenvValues: fromDotenv,
    cwd
  });

  if (!resolved) {
    throw new Error(
      "No UTCP config path provided.\n" +
        "Provide one via:\n" +
        "  CLI:  <command> <path-to-.utcp_config.json>\n" +
        "  .env: UTCP_CONFIG_FILE=/abs/path/.utcp_config.json\n" +
        "  env:  UTCP_CONFIG_FILE=/abs/path/.utcp_config.json <command>"
    );
  }
  return resolved;
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

// Canonical sanitizer shared by all scripts — see manual-name.mjs for why.
import { toManualIdentifier } from "./manual-name.mjs";

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

  // Per-manual diagnostics so a broken manual is attributable instead of
  // indistinguishable from a slow or genuinely empty one (pattern adapted from
  // code-mode-cli's `utcp validate`).
  const diagnostics = new Map(); // raw template name -> { structureValid, registered, errors: [] }
  const diagFor = (n) => {
    if (!diagnostics.has(n)) diagnostics.set(n, { structureValid: true, registered: undefined, errors: [] });
    return diagnostics.get(n);
  };

  const enabledClone = withAllManualsEnabled(rawConfig);
  const templateByName = new Map(
    (Array.isArray(enabledClone.manual_call_templates) ? enabledClone.manual_call_templates : [])
      .filter((t) => t && typeof t.name === "string")
      .map((t) => [t.name, t])
  );
  // Exclusion keys are a registration-time concern (the runtime strips them
  // before the SDK sees them); discovery force-enables everything, so strip
  // them here too. Fresh shallow copy per call — the SDK MUTATES the passed
  // template's `name` to its sanitized form.
  const cleanTemplate = (t) => {
    const { exclude_tools, include_tools, default_disabled, ...rest } = t;
    return rest;
  };
  const templateSerializer = new CallTemplateSerializer();

  // ONE client for every pass; manuals register individually so failures are
  // attributable. Discover with bounded retries: pass 1 registers everything,
  // later passes re-register ONLY the manuals that still returned no tools
  // (the usual victims of a cold-start timeout race).
  const clientConfig = serializer.validateDict({ ...enabledClone, manual_call_templates: [] });
  const client = await CodeModeUtcpClient.create(scriptDir, clientConfig);
  try {
    for (let attempt = 1; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt++) {
      // Retries skip structurally-invalid manuals — re-registering can't fix a
      // template zod already rejected, so don't burn backoff time on them.
      const missing = attempt === 1
        ? allTemplateNames
        : emptyTemplateNames().filter((n) => diagnostics.get(n)?.structureValid !== false);
      if (attempt > 1) {
        if (missing.length === 0) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
        onProgress(`Retry ${attempt - 1}/${MAX_DISCOVERY_ATTEMPTS - 1}: re-registering ${missing.length} manual(s) with no tools…`);
      } else {
        onProgress(`Registering ${templates.length} manual(s) individually…`);
      }

      for (const name of missing) {
        const template = templateByName.get(name);
        if (!template) continue;
        const diag = diagFor(name);

        if (attempt === 1) {
          try {
            templateSerializer.validateDict(cleanTemplate(template));
          } catch (err) {
            diag.structureValid = false;
            diag.errors.push(`Invalid call template: ${err instanceof Error ? err.message : String(err)}`);
            onProgress(`✗ ${name}: invalid call template`);
            continue;
          }
        } else if (!diag.structureValid) {
          continue; // structurally broken — retrying can't help
        }

        try {
          if (attempt > 1) {
            // The SDK files the manual under its sanitized name and throws on
            // duplicate registration — clear both spellings before retrying.
            await client.deregisterManual(name).catch(() => {});
            await client.deregisterManual(toManualIdentifier(name)).catch(() => {});
          }
          const result = await client.registerManual(cleanTemplate(template));
          diag.registered = result?.success !== false;
          if (result?.success === false) diag.errors.push(...(result.errors ?? []).map(String));
          const count = result?.manual?.tools?.length ?? 0;
          onProgress(`${diag.registered ? "✓" : "✗"} ${name}: ${count} tool(s)`);
        } catch (err) {
          diag.registered = false;
          diag.errors.push(`Registration failed: ${err instanceof Error ? err.message : String(err)}`);
          onProgress(`✗ ${name}: registration failed`);
        }
      }

      try {
        mergeTools(exposeCleanToolNames(await client.getTools()));
      } catch (err) {
        onProgress(`Tool listing error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    // Dispose the client so its child MCP server processes don't linger for
    // the whole config-builder session. The tools are already captured.
    await client.close().catch(() => {});
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
      tools: list,
      diagnostics: diagnostics.get(name) ?? { structureValid: true, registered: undefined, errors: [] }
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
        tools: list.slice().sort((a, b) => a.name.localeCompare(b.name)),
        diagnostics: { structureValid: true, registered: true, errors: [] }
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
