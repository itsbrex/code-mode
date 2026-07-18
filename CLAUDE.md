# CLAUDE.md

## Project Overview

Code-Mode is a multi-project monorepo for UTCP (Universal Tool Calling Protocol) code execution. It lets AI agents execute TypeScript or Python code chains with sandboxed tool access instead of making one tool call at a time.

Repository: `github.com/universal-tool-calling-protocol/code-mode`

## Repository Structure

```
code-mode/
  typescript-library/   # @utcp/code-mode — npm package (main library)
  python-library/       # code-mode — PyPI package
  code-mode-mcp/        # @utcp/code-mode-mcp — MCP server bridge
  .claude/rules/        # Claude project rules
```

No root package.json — each sub-project is independent (no npm/pnpm workspaces).

## Sub-Projects

### TypeScript Library (`typescript-library/`)

- **Package**: `@utcp/code-mode` v1.2.11
- **License**: MPL-2.0
- **Entry**: `src/index.ts` re-exports `CodeModeUtcpClient` from `src/code_mode_utcp_client.ts`
- **Build**: `tsup` (outputs ESM + CJS to `dist/`)
- **Test**: `jest` with `ts-jest`
- **Sandbox**: `isolated-vm` for secure code execution
- **Peer deps**: `@utcp/sdk ^1.1.0`, `isolated-vm ^6.0.0`

```bash
cd typescript-library
npm install
npm run build    # tsup → dist/
npm test         # jest (16 test cases)
```

### Python Library (`python-library/`)

- **Package**: `code-mode` v0.0.3
- **License**: MPL-2.0
- **Entry**: `src/utcp_code_mode/__init__.py` exports `CodeModeUtcpClient`
- **Sandbox**: `RestrictedPython` for secure code execution
- **Requires**: Python >= 3.10
- **Deps**: `pydantic>=2.0`, `utcp>=1.0`, `typing-extensions>=4.0`, `RestrictedPython>=6.0`

```bash
cd python-library
pip install -e ".[dev]"
pytest               # 13 test cases
```

### MCP Server (`code-mode-mcp/`)

- **Package**: `@utcp/code-mode-mcp` v1.2.0
- **License**: MIT (differs from root MPL-2.0)
- **Binary**: `code-mode-mcp` → `dist/index.js`
- **Build**: `tsc`
- **Deps**: `@modelcontextprotocol/sdk`, `@utcp/code-mode`, `@utcp/sdk`, `zod`, and several `@utcp/*` protocol adapters

```bash
cd code-mode-mcp
npm install
npm run build    # tsc → dist/
npm start        # node dist/index.js (stdio transport)
```

### Host → UTCP import (`npm run host-import`)

Migrates traditional MCP servers from Claude Code / Claude Desktop / Codex host
configs into the UTCP config (`code-mode-mcp/scripts/host-import-cli.mjs`, runs
via `tsx`). Dry-run by default; `--apply` writes manuals (backup-on-write),
`--strip-host` removes them from the hosts, `--pin` protects servers, `--eject`
reverses a migration. See `code-mode-mcp/docs/host-import.md`.

## Architecture

`CodeModeUtcpClient` (both TS and Python) extends `UtcpClient` from `@utcp/sdk`/`utcp`:

1. Registers tools from various UTCP providers (HTTP, MCP, File, CLI, etc.)
2. Auto-generates typed interfaces (TypeScript or Python) from tool JSON schemas
3. Executes user-provided code in a sandboxed VM with bridged tool access
4. Returns structured results including console output and tool call traces

Key methods: `create()` (static factory), `callToolChain()` / `call_tool_chain()`, `getAllToolsTypeScriptInterfaces()` / `get_all_tools_python_interfaces()`, `AGENT_PROMPT_TEMPLATE` (static prompt template for AI agents).

## Node/Python Requirements

- Node >= 18.0.0
- Python >= 3.10

## Known Issues

- `code-mode-mcp/index.ts` source file may be missing from disk
- `code-mode-mcp` references `tests/*.test.mjs` in its test script but no test files exist
- Python `__init__.py` declares `__version__ = "1.0.0"` while `pyproject.toml` says `0.0.3`
- No CI/CD configuration (no GitHub Actions, no Dockerfile)
