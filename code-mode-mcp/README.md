# UTCP Code Mode MCP

Expose `@utcp/code-mode` through MCP as a thin UTCP-native bridge.

This server keeps the same execution model as `CodeModeUtcpClient`:

- discover tools first
- inspect interfaces before using them
- execute synchronous sandbox code with `manual.tool(args)`
- receive the actual runtime result shape `{ result, logs }`

## Quick Start

Add this to your MCP client:

```json
{
  "mcpServers": {
    "code-mode-mcp": {
      "command": "npx",
      "args": ["@utcp/code-mode-mcp"],
      "env": {
        "UTCP_CONFIG_FILE": "/path/to/.utcp_config.json"
      }
    }
  }
}
```

The server loads UTCP configuration from `UTCP_CONFIG_FILE`, the current working directory, or the package directory fallback.

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

## Exposed MCP Tools

- `register_manual` - register a UTCP manual call template
- `deregister_manual` - remove a registered UTCP manual
- `search_tools` - search UTCP tools and return full TypeScript interfaces
- `list_tools` - list registered UTCP tools with compact, paginated UTCP and sandbox access names
- `tools_info` - inspect complete UTCP tool interface information for selected tools
- `get_required_variables_for_tool` - return the environment variables required by a tool
- `call_tool_chain` - execute synchronous TypeScript with UTCP tool access

## Tool Discovery Flow

The intended workflow is:

1. `search_tools` to find relevant tools
2. `tools_info` to inspect exact interfaces
3. `get_required_variables_for_tool` if configuration is unclear
4. `call_tool_chain` to execute sync sandbox code

## `call_tool_chain` Execution Model

Inside sandbox code, tools are synchronous:

```typescript
const report = reporting.generate_insights({ account_id: "123" });
return report;
```

Do not use `await` for sandbox tool calls.

The final text payload reports the actual code-mode result shape:

```json
{
  "result": { "...": "..." },
  "logs": ["..."]
}
```

If a tool returns MCP content blocks, those blocks are passed through and a final text block still reports `{ result, logs }`.

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
