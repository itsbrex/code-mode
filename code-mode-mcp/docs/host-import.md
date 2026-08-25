# Host → UTCP MCP Import

Consolidate traditional MCP servers (registered directly in Claude Code,
Claude Desktop, and Codex) into the UTCP config so `code-mode` federates them.

## Usage

```bash
# Dry-run: show what would migrate (default; writes nothing)
UTCP_CONFIG_FILE=/abs/hide-some.utcp_config.json npm run host-import

# Apply: write deduped manuals into the UTCP config (backup-on-write)
UTCP_CONFIG_FILE=/abs/hide-some.utcp_config.json npm run host-import -- --apply

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

# Host-path overrides — rehearse strip/eject on COPIES instead of real configs
... npm run host-import -- --apply --strip-host \
    --claude-code-path /tmp/cc.json --codex-path /tmp/cx.toml --claude-desktop-path /tmp/cd.json
```

## Safe testing

`--apply` only ever writes the UTCP config (`UTCP_CONFIG_FILE`; legacy
`UTCP_CONFIG_PATH` remains a fallback); host configs are read-only in that
mode, so applying to a throwaway UTCP path is always safe.

`--strip-host` and `--eject`, by contrast, write the *real* host configs by
default. To rehearse them without touching your live `~/.claude.json` /
`~/.codex/config.toml` / Claude Desktop config, copy those files somewhere and
pass `--claude-code-path` / `--codex-path` / `--claude-desktop-path` to point at
the copies. (Every write is still backed up under `~/.host-import-backups/`
regardless.)

## Remote conversion (plan #005 p02)

Remote (`url`) servers convert to **direct `transport: "http"` manuals** with
their headers preserved — no `mcp-remote` subprocess. The wrapper remains
available for OAuth-gated endpoints (which UTCP's header-only http transport
cannot authenticate against): pass `--wrap-remote <name[,name]>` to force the
`npx -y mcp-remote` stdio wrap for those servers.

## Secret harvesting (plan #005 p03)

`--apply` never writes literal credentials into the UTCP config. Secret-shaped
env/header values are replaced with `${VAR}` references and the values are
appended to `code-mode.env` next to the UTCP config (override with
`--env-file <path>`; file is chmod 0600 and backed up before writes). Both the
plain and per-manual namespaced forms are written; existing vars are never
overwritten — conflicts are reported and skipped.

## Risk tags
- **safe** — stdio server (1:1 manual) or a remote server with auth headers
  (direct http manual).
- **partial** — remote server with no auth info (direct http manual — verify it
  is not OAuth-gated), or one forced through `--wrap-remote`.
- **manual** — denylisted code-mode bridge, or a server with neither `command` nor `url`.

## Parity gate (plan #005 p05)

`npm run parity` registers every manual (with retries + per-manual diagnostics)
and prints tool counts; `--save snap.json` stores a baseline and
`--baseline snap.json` diffs against one, exiting 1 on lost namespaces or
failed registrations. Run it after any import/eject batch.

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
