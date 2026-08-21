# UTCP Code Mode MCP

Expose `@utcp/code-mode` through MCP as private Local Bridge
`@itsbrex/code-mode-mcp`. Package is not published.

This server keeps the same execution model as `CodeModeUtcpClient`:

- discover tools first
- inspect interfaces before using them
- execute sandbox code with `manual.tool(args)` (async/await supported)
- preserve upstream 1.2.1 canonical result/content-block behavior
- serve the canonical wire through an exclusion-aware client: per-manual tool
  exclusion, clean access-name aliases, and the sandbox tool set all apply
  while schemas and envelopes stay identical to upstream

## Quick Start

Requires Node.js 22 or newer. Build local package before configuring host.

Add this to your MCP client:

```json
{
  "mcpServers": {
    "code-mode": {
      "command": "node",
      "args": ["/absolute/path/to/code-mode-mcp/dist/index.js"],
      "env": {
        "UTCP_CONFIG_FILE": "/path/to/.utcp_config.json"
      }
    }
  }
}
```

Server reads `UTCP_CONFIG_FILE` first and temporarily accepts
`UTCP_CONFIG_PATH` as fallback. Equal duplicates work; divergent values fail
closed. Without either value, server checks `.utcp_config.json` in current
working directory and otherwise starts with empty config.

### Claude Code (CLI)

For [Claude Code](https://claude.com/claude-code) (the CLI / IDE extension), register the bridge as a user-scoped MCP server:

```bash
claude mcp add-json --scope user code-mode '{"type":"stdio","command":"node","args":["/absolute/path/to/code-mode-mcp/dist/index.js"],"env":{"UTCP_CONFIG_FILE":"/absolute/path/to/.utcp_config.json"}}'
```

Then restart Claude Code. Verify with `claude mcp list`. Remove with `claude mcp remove code-mode --scope user`.

## Configuration

Example `.utcp_config.json`:

```json
{
  "load_variables_from": [
    {
      "variable_loader_type": "dotenv",
      "env_file_path": ".env"
    }
  ],
  "manual_call_templates": [
    {
      "name": "openlibrary",
      "call_template_type": "http",
      "http_method": "GET",
      "url": "https://openlibrary.org/static/openapi.json",
      "content_type": "application/json"
    }
  ],
  "tool_repository": {
    "tool_repository_type": "in_memory"
  },
  "tool_search_strategy": {
    "tool_search_strategy_type": "tag_and_description_word_match"
  }
}
```

### Protocol plugins

Each `call_template_type` (`http`, `mcp`, `cli`, `text`, `file`, ...) lives in
its own `@utcp/<name>` package and registers itself as a side effect of being
imported — the bridge already imports the bundled set in
[`index.ts`](./index.ts). To add a new transport, install the package and add
a top-level `import "@utcp/<name>"` line; no manual `register()` call needed.

**Security note:** the `@utcp/cli` plugin lets a manual run arbitrary local
commands. It's bundled and active by default; only register manuals from
sources you trust.

## Disabling tools per manual

Each entry in `manual_call_templates` accepts three optional Local Bridge
fields. They control the tools exposed through the canonical wire —
`list_tools`, `search_tools`, `tools_info`, `get_required_keys_for_tool`, and
`call_tool_chain` — while the tool schemas stay identical to upstream.

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

Hidden tools are removed from discovery and execution. Because
`call_tool_chain` binds only visible tools, hidden tools have no sandbox
binding. Direct lookup rejects them with
`Tool '<name>' is disabled by the manual exclusion config.`

Same fields work with `register_manual` for runtime registration — they are
recorded locally and stripped before the template reaches the SDK.

## Building exclusion configs

Two helpers turn a live `.utcp_config.json` into a config with the exclusion fields filled in. Both register every manual and **discover its real tools** (the config only lists manuals; tool names are only known after registration), so they may launch your MCP/CLI manuals — exactly like running the server. Source path is resolved from explicit CLI path, then canonical `UTCP_CONFIG_FILE`, then legacy `UTCP_CONFIG_PATH`; conflicting configured values fail closed.

### Interactive dashboard

```bash
npm run config-builder -- /path/to/.utcp_config.json
```

Opens a local dark-mode dashboard in your browser to choose, per manual, which tools are exposed, then download / copy / save a named config. Features: regex search across tool names and descriptions, filter by decision / provider type / manual, per-manual and bulk expose / hide, the `default_disabled` allowlist toggle and global presets, mark-a-manual-for-removal (drops it from the output), manual ordering (config / alphabetical / drag-to-reorder), a resizable syntax-highlighted JSON preview, and a live save to `./configs/`. Disabled manuals are force-enabled for discovery only — the generated config preserves their original `enabled` / `disabled` settings.

### Non-interactive generator

```bash
npm run generate-exclusion-configs -- /path/to/.utcp_config.json
```

Writes two ready-to-edit configs to `./configs/`:

- `all-tools-excluded.utcp_config.json` — every manual gets an `exclude_tools` array listing all of its tools (full denylist).
- `all-tools-included-default-disabled.utcp_config.json` — every manual gets `default_disabled: true` plus an `include_tools` array listing all of its tools (allowlist form). Prune either to taste.

## 🧪 Local development against the bridge

If you're hacking on `@utcp/code-mode` (the sibling `typescript-library/` package) and want to exercise it through Claude Code, use the dev scripts:

```bash
cd code-mode-mcp
npm install
npm run dev:register     # builds lib + bridge, overlays the lib build into the bridge's node_modules, registers as 'utcp-codemode-dev' in Claude Code
# restart Claude Code, then call mcp__utcp-codemode-dev__call_tool_chain to test

# After every edit:
npm run dev:register     # rebuilds, re-registers; restart Claude Code

# When done:
npm run dev:unregister   # removes the MCP entry and restores the registry @utcp/code-mode
```

Both scripts are idempotent and never mutate `package.json`. The overlay strategy avoids `npm link`, which under modern npm aliases `unlink` to `uninstall --save` and would silently strip the dependency.

Flags:

- `--name <mcp-name>` (default `utcp-codemode-dev`) — useful if you want the dev bridge alongside a published one
- `--config <path>` (default `./.utcp_config.json`) — point at a different UTCP config

## Exposed MCP Tools

Canonical upstream 1.2.1 wire:

- `register_manual`
- `deregister_manual`
- `search_tools`
- `list_tools`
- `get_required_keys_for_tool`
- `tools_info`
- `call_tool_chain`

`get_required_variables_for_tool` is deprecated compatibility alias
(scheduled for removal at wave 7).

## Tool Discovery Flow

The intended workflow is:

1. `search_tools` to find relevant tools
2. `tools_info` to inspect exact interfaces
3. `get_required_keys_for_tool` if configuration is unclear
4. `call_tool_chain` to execute sandbox code

## `call_tool_chain` Execution Model

Your code runs as the body of an `async function`, so `return` the value you want
and use top-level `await` freely. Tool calls work either synchronously or with
`await` — both are valid:

```typescript
// synchronous — the host bridges the async call for you
const report = reporting.generate_insights({ account_id: "123" });
return report;
```

```typescript
// async/await — equivalent, use whichever reads better
const report = await reporting.generate_insights({ account_id: "123" });
return report;
```

`await` is optional for tool calls, not forbidden. The executed code must be valid
JavaScript, though: the generated TypeScript interfaces are reference documentation
for shaping argument objects — do not put type annotations in the code you run.

Canonical final text block preserves upstream envelope:

```json
{
  "success": true,
  "nonMcpContentResults": { "...": "..." },
  "logs": ["..."]
}
```

MCP content blocks pass through before final text block.

## Example

```typescript
const result = call_tool_chain(`
  const user = user_service.get_user_profile({ user_id: "123" });
  console.log("User:", user);

  const processed = data_processor.analyze_user_behavior({
    user_data: user,
    timeframe: "30days"
  });

  return {
    user_id: user.id,
    action_count: processed.action_count
  };
`);
```

## Protocol Support

This bridge loads the UTCP protocol plugins imported in `index.ts`, including HTTP, text, MCP, CLI, dotenv-loader, and file support.

Available tools still depend on your `.utcp_config.json`. CLI-backed tools can execute local commands, so only configure CLI manuals intentionally.

## Development

```bash
npm run build
npm test
```
