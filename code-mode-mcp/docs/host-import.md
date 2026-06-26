# Host → UTCP MCP Import

Consolidate traditional MCP servers (registered directly in Claude Code,
Claude Desktop, and Codex) into the UTCP config so `code-mode` federates them.

## Usage

```bash
# Dry-run: show what would migrate (default; writes nothing)
UTCP_CONFIG_PATH=/abs/hide-some.utcp_config.json npm run host-import

# Apply: write deduped manuals into the UTCP config (backup-on-write)
UTCP_CONFIG_PATH=/abs/hide-some.utcp_config.json npm run host-import -- --apply

# Apply + remove the migrated servers from the host configs (backed up)
... npm run host-import -- --apply --strip-host

# Narrow: only safe-risk servers, or specific names
... npm run host-import -- --apply --risk safe
... npm run host-import -- --only memory,context7

# Pin servers that must never be migrated or stripped (any host, or host-scoped)
... npm run host-import -- --pin github --pin claude-desktop:hookmark
# (or persist them in ~/.host-import-pins.json: { "pins": ["github", "codex:context7"] })

# Eject: move UTCP manual(s) back out into host config(s) as standard MCP servers
... npm run host-import -- --eject salesforce-mcp --to claude-code
... npm run host-import -- --eject zoominfo-mcp,databar-mcp --to claude-code,codex
```

## Risk tags
- **safe** — stdio server (1:1 manual) or a remote server with no auth headers.
- **partial** — remote server wrapped via `mcp-remote`; verify auth headers/env carry over.
- **manual** — denylisted code-mode bridge, or a server with neither `command` nor `url`.

Duplicates (already in the UTCP config, matched by raw or sanitized name) are
never re-added. Backups live under `~/.host-import-backups/<timestamp>/` (FIFO, keep 30).

Codex servers marked `enabled = false` are skipped (never migrated). Nested
Codex `[mcp_servers.NAME.env]` / `[mcp_servers.NAME.http_headers]` sub-tables are
folded into the server. Same-named servers with a `-mcp` suffix (`hookmark` vs
`hookmark-mcp`) are treated as distinct — they are not fuzzy-merged.

## Pin / whitelist
A pinned server is never migrated and never stripped. Pin via `--pin <name>` /
`--pin <host>:<name>` (host ∈ `claude-code`/`claude-desktop`/`codex`) or persist
in `~/.host-import-pins.json`. Pinned servers show as `pinned — never touched`.

## Eject (UTCP manual → host)
`--eject <name[,name]> --to <host[,host]>` moves manuals back out: it reconstructs
a standard MCP server entry (un-wrapping `mcp-remote` back to a `url`/`http`
server), writes it into each target host, and removes the manual from the UTCP
config. All writes are backed up.

## What it does NOT do
- It does not import code-mode bridges into themselves (denylisted).
- `--strip-host` only removes servers that were actually migrated this run.
- It is one-way per run (import OR eject) — not a bidirectional/continuous sync.
