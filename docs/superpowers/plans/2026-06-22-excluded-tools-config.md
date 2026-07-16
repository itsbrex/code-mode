# Per-Manual Tool Exclusion Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a UTCP manual call template hide specific tools from the code-mode MCP server (denylist) or expose only a curated subset (allowlist), mirroring Cloudflare MCP Portals' `default_disabled` + per-tool toggles.

**Architecture:** Add three optional fields to each manual call template entry — `exclude_tools`, `include_tools`, `default_disabled`. These are parsed at the registration boundary into an in-memory `Map<manualName, ToolExclusionRule>` (SDK-agnostic — the custom keys are stripped before the UTCP SDK ever validates the template). Enforcement happens at a single chokepoint, `createCleanToolNameClient`, which already wraps `getTools` / `searchTools` / `callTool`. Because the sandbox in `CodeModeUtcpClient.callToolChain` builds its tool bridge from `this.getTools()` and routes every call through `this.callTool()`, filtering at the wrapper transparently removes excluded tools from `list_tools`, `search_tools`, `tools_info`, `get_required_variables_for_tool`, AND the `call_tool_chain` sandbox.

**Tech Stack:** TypeScript (ESM, `module: ESNext`), `@modelcontextprotocol/sdk`, `@utcp/sdk`, `@utcp/code-mode`, `zod`. Build with `tsc`. Tests use Node's built-in test runner (`node --test tests/*.test.mjs`) importing from `dist/`.

## Global Constraints

- Node >= 18.0.0; package is ESM (`"type": "module"` implied by `module: ESNext` + `.mjs` tests).
- Local relative imports in source MUST use the `.js` extension (e.g. `import { x } from "./tool-exclusion.js"`) — required by Node ESM at runtime.
- Tests import the symbols under test from `../dist/index.js`. Any new helper that needs testing MUST be re-exported from `index.ts`.
- Build before testing: `npm run build` compiles `*.ts` → `dist/`. The `npm test` script already runs build first, but individual steps below call build explicitly.
- Back-compat: `createCleanToolNameClient(baseClient)` (one argument) MUST keep working unchanged — the registry argument is optional and defaults to an empty `Map`.
- New config fields are OPTIONAL. A manual with none of them behaves exactly as today (all tools exposed).
- Field semantics (copied verbatim from the Cloudflare model):
  - `exclude_tools: string[]` — denylist; listed tools are hidden. Active when `default_disabled` is falsy.
  - `default_disabled: boolean` — when `true`, ALL of the manual's tools are hidden except those named in `include_tools`.
  - `include_tools: string[]` — the allowlist used only when `default_disabled` is `true`.
- A tool name in `exclude_tools` / `include_tools` matches if it equals ANY of these forms of the tool:
  - the full canonical UTCP name (`manual.server.tool`),
  - the short name (canonical name with the leading `manual.` removed — e.g. `server.tool`),
  - the **bare tool name** (the final dot segment — e.g. `tool`),
  - the **clean alias** (`manual.tool`, which is what the wrapper actually exposes in `list_tools` for single-server / duplicate-server manuals),
  - the sandbox access name (`utcpNameToTsInterfaceName(canonical)`).
  - **Why bare + alias matter:** real MCP tool names are 3-segment (`manual.server.tool`; verified at `@utcp/code-mode`/`@utcp/mcp` tool composition `name: \`${mcpCallTemplate.name}.${serverName}.${mcpTool.name}\``). For the common single-server manual where the manual and server names are identical (e.g. `msgcli.msgcli.mail_delete`), the short name is `msgcli.mail_delete`, so a config of `["mail_delete"]` would NOT match without the bare-name and alias candidates. The matching set below is built with pure string ops so the module stays dependency-free.

---

## File Structure

- **Create** `code-mode-mcp/tool-exclusion.ts` — pure, dependency-free exclusion logic (parsing, key-stripping, name-matching, registry construction). One responsibility: decide whether a tool is excluded and translate config into a registry. No SDK or isolated-vm imports, so it is trivially unit-testable.
- **Modify** `code-mode-mcp/index.ts` — import and re-export the exclusion module; add a module-level registry; thread the registry through `createCleanToolNameClient`; sanitize + record rules in `initializeUtcpClient`, `register_manual`, and `deregister_manual`.
- **Create** `code-mode-mcp/tests/tool-exclusion.test.mjs` — unit tests for the pure module and integration tests for the wrapper + tool definitions.
- **Modify** `code-mode-mcp/README.md` — document the three fields with an allowlist + denylist example.
- **Do NOT modify** `code-mode-mcp/.utcp_config.json` — it is the minimal generic shipped example (only the `openlibrary` HTTP manual) and is kept in sync with upstream. Discoverability lives in the README instead, so the shipped config stays clean and path-free.

---

## Task 1: Pure exclusion module

**Files:**
- Create: `code-mode-mcp/tool-exclusion.ts`
- Modify: `code-mode-mcp/index.ts` (add re-export near the existing imports, around line 27)
- Test: `code-mode-mcp/tests/tool-exclusion.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `interface ToolExclusionRule { defaultDisabled: boolean; exclude: string[]; include: string[]; }`
  - `type ToolExclusionRegistry = Map<string, ToolExclusionRule>`
  - `parseExclusionRule(template: Record<string, unknown> | null | undefined): ToolExclusionRule | null`
  - `stripExclusionKeys(template: Record<string, unknown>): Record<string, unknown>`
  - `getManualNameFromToolName(toolName: string): string`
  - `getToolShortName(toolName: string, manualName: string): string`
  - `isToolExcluded(toolName: string, accessName: string, registry: ToolExclusionRegistry): boolean`
  - `applyManualExclusion(registry: ToolExclusionRegistry, template: Record<string, unknown>): Record<string, unknown>`
  - `buildExclusionRegistryFromConfig(rawConfig: Record<string, unknown>): { registry: ToolExclusionRegistry; sanitizedConfig: Record<string, unknown> }`

- [ ] **Step 1: Write the failing test**

Create `code-mode-mcp/tests/tool-exclusion.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && npm run build && node --test tests/tool-exclusion.test.mjs`
Expected: build FAILS (`Cannot find module './tool-exclusion.js'`) or, if build is skipped, the import throws `SyntaxError: The requested module '../dist/index.js' does not provide an export named 'parseExclusionRule'`.

- [ ] **Step 3: Create the pure module**

Create `code-mode-mcp/tool-exclusion.ts`:

```typescript
export interface ToolExclusionRule {
  defaultDisabled: boolean;
  exclude: string[];
  include: string[];
}

export type ToolExclusionRegistry = Map<string, ToolExclusionRule>;

const EXCLUSION_KEYS = ["exclude_tools", "include_tools", "default_disabled"] as const;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function parseExclusionRule(
  template: Record<string, unknown> | null | undefined
): ToolExclusionRule | null {
  if (!template || typeof template !== "object") {
    return null;
  }
  const hasExclusionKey = EXCLUSION_KEYS.some((key) => key in template);
  if (!hasExclusionKey) {
    return null;
  }
  return {
    defaultDisabled: template.default_disabled === true,
    exclude: toStringArray(template.exclude_tools),
    include: toStringArray(template.include_tools)
  };
}

export function stripExclusionKeys(
  template: Record<string, unknown>
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...template };
  for (const key of EXCLUSION_KEYS) {
    delete clone[key];
  }
  return clone;
}

export function getManualNameFromToolName(toolName: string): string {
  const dotIndex = toolName.indexOf(".");
  return dotIndex === -1 ? toolName : toolName.slice(0, dotIndex);
}

export function getToolShortName(toolName: string, manualName: string): string {
  const prefix = `${manualName}.`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

export function isToolExcluded(
  toolName: string,
  accessName: string,
  registry: ToolExclusionRegistry
): boolean {
  const manualName = getManualNameFromToolName(toolName);
  const rule = registry.get(manualName);
  if (!rule) {
    return false;
  }

  const shortName = getToolShortName(toolName, manualName);
  const bareName = toolName.slice(toolName.lastIndexOf(".") + 1);
  const aliasName = manualName === toolName ? toolName : `${manualName}.${bareName}`;
  const candidates = new Set([toolName, shortName, bareName, aliasName, accessName]);
  const listed = (names: string[]): boolean => names.some((name) => candidates.has(name));

  if (rule.defaultDisabled) {
    return !listed(rule.include);
  }
  return listed(rule.exclude);
}

export function applyManualExclusion(
  registry: ToolExclusionRegistry,
  template: Record<string, unknown>
): Record<string, unknown> {
  const name = typeof template?.name === "string" ? template.name : undefined;
  const rule = parseExclusionRule(template);
  if (name) {
    if (rule) {
      registry.set(name, rule);
    } else {
      registry.delete(name);
    }
  }
  return stripExclusionKeys(template);
}

export function buildExclusionRegistryFromConfig(
  rawConfig: Record<string, unknown>
): { registry: ToolExclusionRegistry; sanitizedConfig: Record<string, unknown> } {
  const registry: ToolExclusionRegistry = new Map();
  const templates = rawConfig?.manual_call_templates;
  if (!Array.isArray(templates)) {
    return { registry, sanitizedConfig: rawConfig };
  }
  const sanitizedTemplates = templates.map((template) =>
    template && typeof template === "object"
      ? applyManualExclusion(registry, template as Record<string, unknown>)
      : template
  );
  return {
    registry,
    sanitizedConfig: { ...rawConfig, manual_call_templates: sanitizedTemplates }
  };
}
```

- [ ] **Step 4: Re-export the module from `index.ts`**

In `code-mode-mcp/index.ts`, immediately after the existing `import { CodeModeUtcpClient } from "@utcp/code-mode";` line (currently line 27), add:

```typescript
import {
  applyManualExclusion,
  buildExclusionRegistryFromConfig,
  isToolExcluded,
  type ToolExclusionRegistry
} from "./tool-exclusion.js";

export * from "./tool-exclusion.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd code-mode-mcp && npm run build && node --test tests/tool-exclusion.test.mjs`
Expected: PASS — all `tool-exclusion` unit tests pass (including the 3-segment MCP name cases). (`export *` makes the helpers available from `dist/index.js`.)

- [ ] **Step 6: Commit**

```bash
cd code-mode-mcp
git add tool-exclusion.ts index.ts tests/tool-exclusion.test.mjs
git commit -m "feat(mcp): add pure tool-exclusion module"
```

---

## Task 2: Enforce exclusion in the clean-name client

**Files:**
- Modify: `code-mode-mcp/index.ts:222-268` (the `createCleanToolNameClient` function)
- Test: `code-mode-mcp/tests/tool-exclusion.test.mjs` (append wrapper tests)

**Interfaces:**
- Consumes: `isToolExcluded`, `ToolExclusionRegistry` (from Task 1); `utcpNameToTsInterfaceName`, `buildToolAliasIndex`, `exposeToolAlias`, `findToolWithAliases` (existing in `index.ts`).
- Produces: `createCleanToolNameClient(baseClient: CodeModeUtcpClient, registry?: ToolExclusionRegistry): CodeModeMcpClientLike` — second argument optional, defaults to `new Map()`. When a registry hides a tool, the wrapped `getTools` / `searchTools` / `__findToolByName` omit it, and `callTool` / `getRequiredVariablesForRegisteredTool` throw `Error("Tool '<name>' is disabled by the manual exclusion config.")`.

- [ ] **Step 1: Write the failing test**

Append to `code-mode-mcp/tests/tool-exclusion.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && npm run build && node --test tests/tool-exclusion.test.mjs`
Expected: the five new wrapper tests FAIL — `getTools hides excluded tools` returns both tools, and the `callTool` block does not reject.

- [ ] **Step 3: Implement enforcement in `createCleanToolNameClient`**

Replace the body of `createCleanToolNameClient` in `code-mode-mcp/index.ts` (currently lines 222-268) with:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd code-mode-mcp && npm run build && node --test tests/tool-exclusion.test.mjs && node --test tests/index.test.mjs`
Expected: PASS — new wrapper tests pass AND the existing `tests/index.test.mjs` suite still passes (registry defaults to empty Map, so alias behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
cd code-mode-mcp
git add index.ts tests/tool-exclusion.test.mjs
git commit -m "feat(mcp): enforce per-manual tool exclusion in clean-name client"
```

---

## Task 3: Wire static config + dynamic register/deregister

**Files:**
- Modify: `code-mode-mcp/index.ts` — add module-level registry (near line 45); update the `register_manual` and `deregister_manual` handlers (lines 444-483); update `initializeUtcpClient` (lines 722-734).
- Test: `code-mode-mcp/tests/tool-exclusion.test.mjs` (append handler tests)

**Interfaces:**
- Consumes: `applyManualExclusion`, `buildExclusionRegistryFromConfig` (Task 1); `createCleanToolNameClient(client, registry)` (Task 2); `getToolDefinitions` (existing).
- Produces: a module-level `exclusionRegistry` shared between `initializeUtcpClient`, the `register_manual` handler (records + strips the rule before delegating to the SDK), and the `deregister_manual` handler (clears the rule).
- **No `register_manual` schema change is needed (verified).** The existing `inputSchema` uses `CallTemplateSchema`, which is `z.custom(check)`. In Zod v3 `z.custom` compiles to `ZodAny().superRefine(check)` — it returns the input **unchanged** regardless of what `check` returns, and `superRefine` only adds issues. `check` runs `new CallTemplateSerializer().validateDict(obj)`, which for `mcp`/`http` delegates to a plain `z.object({...})` (no `.strict()`, no `.passthrough()`) that **silently strips** unknown keys and does **not** throw. Net effect: `check` succeeds and the handler receives the original template with `exclude_tools` / `include_tools` / `default_disabled` intact. So the handler's `applyManualExclusion` can read and strip them. The earlier `z.intersection(...)` widening is therefore unnecessary and is dropped (it also runs `CallTemplateSchema` on the full input, so it would not help for any hypothetical `.strict()` call-template type either).

- [ ] **Step 1: Write the failing test**

Append to `code-mode-mcp/tests/tool-exclusion.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && npm run build && node --test tests/tool-exclusion.test.mjs`
Expected: FAIL — `received[0]` still contains `exclude_tools` because the handler passes the raw template through.

- [ ] **Step 3: Add the module-level registry**

In `code-mode-mcp/index.ts`, directly below the existing `let utcpClient: CodeModeUtcpClient | null = null;` (line 45), add:

```typescript
let exclusionRegistry: ToolExclusionRegistry = new Map();
```

- [ ] **Step 4: Sanitize + record the rule in `register_manual`**

In the `register_manual` handler (lines 451-459), replace the `handler` body with:

```typescript
      handler: async (input) => {
        try {
          const client = await getClient();
          const sanitizedTemplate = applyManualExclusion(
            exclusionRegistry,
            input.manual_call_template as Record<string, unknown>
          );
          const result = await client.registerManual(sanitizedTemplate);
          return textResponse({ success: true, result });
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      }
```

- [ ] **Step 5: Update the `register_manual` schema description (no structural change) + prove keys survive**

The `inputSchema` does NOT need to change structurally — `CallTemplateSchema` already passes the custom keys through to the handler (see the "No schema change is needed" note above). Only update the `.describe(...)` text so the extra fields are documented to callers. In the `register_manual` definition, replace the `inputSchema` block (lines 448-450) with:

```typescript
      inputSchema: {
        manual_call_template: CallTemplateSchema.describe(
          "The UTCP manual call template to register. Optional exclude_tools / include_tools / default_disabled fields control which of this manual's tools are exposed."
        )
      },
```

Then add a regression test that exercises the ACTUAL schema (the Step 1 test calls `handler` directly and bypasses zod parsing, so it does not prove the schema passes the keys through). Append to `code-mode-mcp/tests/tool-exclusion.test.mjs`:

```javascript
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
```

If this test ever fails (e.g. after a UTCP SDK upgrade makes a call-template schema `.strict()`), the fix is to change `inputSchema.manual_call_template` to a permissive passthrough object and let the handler's `applyManualExclusion` + `client.registerManual` re-validation do the work — do NOT reintroduce `z.intersection(CallTemplateSchema, ...)`, which re-runs the strict schema on the full input and fails identically.

- [ ] **Step 6: Clear the rule in `deregister_manual`**

In the `deregister_manual` handler (lines 468-482), replace the `handler` body with:

```typescript
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
```

- [ ] **Step 7: Build the registry from the static config in `initializeUtcpClient`**

In `initializeUtcpClient`, replace the two lines that currently validate the config and create the client (lines 732-733):

```typescript
  const clientConfig = new UtcpClientConfigSerializer().validateDict(rawConfig) as UtcpClientConfig;
  utcpClient = createCleanToolNameClient(await CodeModeUtcpClient.create(scriptDir, clientConfig)) as CodeModeUtcpClient;
```

with:

```typescript
  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig(rawConfig);
  exclusionRegistry = registry;
  const clientConfig = new UtcpClientConfigSerializer().validateDict(sanitizedConfig) as UtcpClientConfig;
  utcpClient = createCleanToolNameClient(
    await CodeModeUtcpClient.create(scriptDir, clientConfig),
    exclusionRegistry
  ) as CodeModeUtcpClient;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd code-mode-mcp && npm run build && node --test tests/*.test.mjs`
Expected: PASS — the `register_manual` strip test passes and all existing tests still pass.

- [ ] **Step 9: Manually verify end-to-end against the live config**

Run: `cd code-mode-mcp && node -e "import('./dist/index.js').then(m => { const r = m.buildExclusionRegistryFromConfig({ manual_call_templates: [{ name: 'proxyman_mcp', call_template_type: 'mcp', exclude_tools: ['quit_proxyman'] }] }); console.log(JSON.stringify([...r.registry])); console.log(JSON.stringify(r.sanitizedConfig.manual_call_templates[0])); })"`
Expected output (two lines):
```
[["proxyman_mcp",{"defaultDisabled":false,"exclude":["quit_proxyman"],"include":[]}]]
{"name":"proxyman_mcp","call_template_type":"mcp"}
```

- [ ] **Step 10: Commit**

```bash
cd code-mode-mcp
git add index.ts tests/tool-exclusion.test.mjs
git commit -m "feat(mcp): wire tool exclusion into static config and register/deregister"
```

---

## Task 4: Document the feature

**Files:**
- Modify: `code-mode-mcp/README.md`

**Interfaces:**
- Consumes: the field semantics defined in Global Constraints.
- Produces: user-facing docs (README only; the shipped config is intentionally left untouched — see Step 2).

- [ ] **Step 1: Add a "Disabling tools per manual" section to the README**

In `code-mode-mcp/README.md`, add a new section (place it after the existing configuration/usage section — search for the heading that documents `.utcp_config.json` or `manual_call_templates` and add this directly below it):

````markdown
## Disabling tools per manual

Each entry in `manual_call_templates` accepts three optional fields that control which of that manual's tools are exposed through `list_tools`, `search_tools`, `tools_info`, and the `call_tool_chain` sandbox. This mirrors Cloudflare MCP Portals' per-server tool toggles.

| Field | Type | Behavior |
| --- | --- | --- |
| `exclude_tools` | `string[]` | Denylist. Listed tools are hidden. Used when `default_disabled` is falsy. |
| `default_disabled` | `boolean` | When `true`, hide every tool from this manual except those in `include_tools`. |
| `include_tools` | `string[]` | Allowlist used only when `default_disabled` is `true`. |

A name in `exclude_tools` / `include_tools` matches if it equals any form of the tool: the full canonical name (`manual.server.tool`), the short name (`server.tool`), the bare tool name (`tool`), the clean alias shown in `list_tools` (`manual.tool`), or the sandbox access name. The bare tool name (e.g. `mail_delete`) is the most convenient and is what the examples below use.

**Denylist — hide two noisy tools:**

```jsonc
{
  "name": "proxyman_mcp",
  "call_template_type": "mcp",
  "config": { "mcpServers": { "proxyman_mcp": { "command": "proxyman-mcp", "transport": "stdio" } } },
  "exclude_tools": ["quit_proxyman", "open_proxyman"]
}
```

**Allowlist — expose only a curated subset of a large manual:**

```jsonc
{
  "name": "msgcli",
  "call_template_type": "mcp",
  "config": { "mcpServers": { "msgcli": { "command": "msgcli", "args": ["mcp", "serve"], "transport": "stdio" } } },
  "default_disabled": true,
  "include_tools": ["mail_list", "mail_get", "calendar_list"]
}
```

Hidden tools are removed from every listing (`list_tools`, `search_tools`) and from `tools_info` / `get_required_variables_for_tool` (which report them as not found). Because the `call_tool_chain` sandbox binds only the visible tools, a hidden tool has no binding inside the sandbox — referencing it fails as an undefined function (e.g. `TypeError: manual.hidden_tool is not a function`). Calling the wrapper directly with a name that still resolves to a hidden tool throws `Tool '<name>' is disabled by the manual exclusion config.`

The same fields work with the `register_manual` MCP tool for manuals registered at runtime.
````

- [ ] **Step 2: Leave the shipped `.utcp_config.json` untouched**

**Skip the config edit.** `code-mode-mcp/.utcp_config.json` is the minimal generic example (only the `openlibrary` HTTP manual) and matches upstream — keep it that way. Discoverability is fully covered by the README section in Step 1. Do not add manuals or `exclude_tools` examples to the shipped config (it should stay generic and path-free). If a shipped example is ever wanted, add a denylist to the existing `openlibrary` manual in a dedicated, reviewed commit — never personal/local manuals.

- [ ] **Step 3: Verify the registry builder against an inline example (not the live file)**

This avoids depending on (and avoids reading) the local `.utcp_config.json`. Run: `cd code-mode-mcp && npm run build && node -e "import('./dist/index.js').then(m => { const { registry, sanitizedConfig } = m.buildExclusionRegistryFromConfig({ manual_call_templates: [{ name: 'msgcli', call_template_type: 'mcp', config: { mcpServers: { msgcli: { command: 'msgcli', transport: 'stdio' } } }, exclude_tools: ['mail_delete'] }] }); console.log('rule:', JSON.stringify([...registry])); console.log('sanitized keys:', Object.keys(sanitizedConfig.manual_call_templates[0])); })"`
Expected: prints a `msgcli` rule with `exclude:["mail_delete"]` and the sanitized key list does NOT contain `exclude_tools`.

- [ ] **Step 4: Commit**

```bash
cd code-mode-mcp
git add README.md
git commit -m "docs(mcp): document per-manual tool exclusion config"
```

---

## Self-Review

**1. Spec coverage**
- "Turn off individual tools" → `exclude_tools` denylist (Task 1 `isToolExcluded` denylist branch; Task 2 enforcement; Task 4 docs). ✓
- "Turned-off tools will not appear in the portal's tool list" → wrapper `getTools` / `searchTools` filtering (Task 2). ✓
- "Users will not be able to call them" → excluded tools are removed from `getTools`, so they get no sandbox binding (referencing one is an undefined-function error), and the wrapper's `callTool` throws the explicit "disabled" message for any name that still resolves to an excluded canonical tool (Task 2; architecture note). ✓
- "Bare tool names in config actually match real (3-segment) MCP tools" → `isToolExcluded` candidate set includes the bare segment and the clean `manual.tool` alias (Task 1 matching; Task 1 3-segment tests). ✓
- "Allowlist pattern via `default_disabled: true` + explicit enabled list" → `default_disabled` + `include_tools` (Task 1 allowlist branch; Task 4 allowlist example). ✓
- "server-to-portal mapping" granularity (per MCP server) → per-manual rule keyed by manual name (Task 1 `applyManualExclusion`; Task 3 static + dynamic wiring). ✓
- Runtime-registered servers → `register_manual` records the rule (Task 3). ✓

**2. Placeholder scan** — every code/test step contains complete code; every run step has an exact command and expected output. No TBD/TODO/"handle edge cases". ✓

**3. Type consistency** — `ToolExclusionRule` fields (`defaultDisabled`, `exclude`, `include`) are used identically in `parseExclusionRule`, `isToolExcluded`, and all tests. `ToolExclusionRegistry = Map<string, ToolExclusionRule>` is the type passed to `createCleanToolNameClient`'s second parameter and the module-level `exclusionRegistry`. `applyManualExclusion(registry, template)` and `buildExclusionRegistryFromConfig(rawConfig)` signatures match their call sites in Task 3. The custom keys (`exclude_tools`/`include_tools`/`default_disabled`) parsed by `parseExclusionRule` flow through the unchanged `register_manual` `inputSchema` (`CallTemplateSchema` = `z.custom`, which returns its input unchanged) into the handler, where `applyManualExclusion` reads and strips them — no schema change required. ✓

**4. Architecture verification (against installed deps, do not skip):** the single-chokepoint claim was checked against the compiled libraries —
- `@utcp/code-mode/dist/index.js`: `callToolChain` does `const tools = await this.getTools()` then `setupToolBridges(..., tools)` (bridge built ONLY from the filtered list), and each bridged call runs `await this.callTool(toolName, args)`. Because `createCleanToolNameClient` reassigns `getTools`/`callTool` on the SAME instance, `callToolChain` (an un-reassigned prototype method) sees the filtered versions via `this`. So filtering at the wrapper transparently covers the sandbox.
- `@utcp/mcp/dist/index.js`: MCP tool names are composed as `` `${manual}.${server}.${tool}` `` (3 segments) — this is why bare-name matching is required (item 1, line 4).
- `@utcp/sdk` + `@utcp/mcp`/`@utcp/http`: `CallTemplateSchema` is `z.custom`; the per-type `mcp`/`http` schemas are plain `z.object` (strip-not-throw) — this is why no `register_manual` schema widening is needed (Task 3 Step 5 note).

**Note for the implementer (verification, not a code change):** `moduleResolution` is `node` and `module` is `ESNext`. The `./tool-exclusion.js` import specifier (Task 1, Step 4) is correct for Node ESM at runtime. If `tsc` reports it cannot find the module, confirm the file is `tool-exclusion.ts` in the same directory and that `rootDir`/`include` cover it — do not drop the `.js` extension, as that breaks the runtime import.
