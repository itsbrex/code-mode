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
# No --to: each manual routes back to the host(s) it was imported from
# (provenance sidecar; falls back to claude-code when nothing is recorded)
... npm run host-import -- --eject salesforce-mcp

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

## Import provenance & same-name servers

The same server name can exist on several hosts. Two cases:

- **Identical config** (key-order-independent comparison of the converted
  manual and harvested credential values): a true duplicate. Import writes ONE manual and records **every**
  source host in `~/.host-import-sources.json` (override with
  `--sources-file`). The UTCP client config schema is strict, so provenance
  lives in this sidecar rather than inside the UTCP config.
- **Different config**: a conflict. The web panel marks both rows `≠ differs`,
  lets you expand each row to compare the raw host entry against the UTCP
  manual it would become, and selecting one row deselects the others —
  "select new" auto-picks the best candidate (safest risk, then the richer
  config, then claude-code > claude-desktop > codex). The CLI keeps its
  first-host-wins behavior.

`--eject <name>` without `--to` consumes the recorded provenance: the manual is
written back to each host it originally came from, and its sidecar entry is
removed. The web panel shows `from <hosts>` on federated rows that have
recorded sources.

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

The entire selection is checked before any destination is written. Only MCP
manuals containing one convertible server can be ejected; other UTCP protocols,
empty or multi-server MCP manuals, and unsupported target scopes are rejected.
Provenance routing restores the original host name and project scope. All routes
are planned as one batch: two selected manuals cannot claim the same resolved
destination file, scope/project, and raw name. Identical paths, existing hard
links, and symlink aliases (including dangling chains) are checked together;
the same raw name in distinct project scopes stays valid.
JSON and TOML hosts cannot share a destination file, even for the same manual.
Unknown manual names remain a no-op.

## Bridge auto-detection

Bridge instances registered under arbitrary names (brandjet-style forks,
`op run`-wrapped launches) are detected without relying on the name, three
tiers cheapest-first: exact-name denylist; command/args mentioning
`code-mode`/`code_mode` or a `UTCP_CONFIG_FILE`/`UTCP_CONFIG_PATH` env var;
finally a content probe that reads absolute script paths from command/args
(≤8MB, cached by file identity and modification metadata, relative imports
followed one level) and scans for the
code-mode wire markers (`call_tool_chain`, `@utcp/code-mode`,
`CodeModeUtcpClient`). Detected bridges show a `bridge` badge in the web
panel, cannot be selected, are never migrated, and strip requests against
them are refused server-side even when their name matches a federated manual.
Relative imports include side-effect imports, literal dynamic imports, and
CommonJS `require` calls. A pinned Babel parser reads JavaScript/TypeScript/JSX
syntax, including escaped strings and template literals without substitutions;
comments and quoted examples do not become imports. Computed expressions are not
evaluated. At most 16 literal relative imports are followed, one module level;
unsupported or incomplete source is not a complete dependency graph.
Replacing an entry or imported module invalidates its
cached bridge result on the next scan.
Relative CommonJS calls also resolve extensionless files, package `main`, and
directory index files in Node's file/main/index order. Resolution reads bounded
metadata afresh without executing modules or retaining Node's resolver caches.
Package metadata accepts Node's UTF-8 BOM spelling. ESM specifiers use file-URL
semantics for percent escapes, query strings, and fragments; CommonJS paths keep
their literal filename meaning. Symlinked entrypoints conservatively probe both
logical and real locations, covering default and preserve-symlink modes.

## What it does NOT do
- It does not import code-mode bridges into themselves (denylisted or
  auto-detected — see Bridge auto-detection).
- `--strip-host` only removes servers that were actually migrated this run.
- It is one-way per run (import OR eject) — not a bidirectional/continuous sync.

### Import boundary and provenance

The local config builder binds only to loopback and requires an exact local Host,
Origin, and session token for writes. Import selections include the configuration
digest shown during review; a changed source returns HTTP 409 before any write.
Row identities encode host, scope, project, and name as a tuple, so separator
characters in names cannot select another row.
Importing the server module does not launch discovery or load credentials.
Credential tooling retains its default output masking.

An empty `manual_call_templates: []` starts the config builder for a first import;
the config still passes schema validation. Other discovery callers keep their
nonempty requirement. A requested port of `0` reports the actual assigned port.

Duplicate identity includes harvested values, so same-named servers with different
credentials remain separate. Only the chosen source supplies harvested variables;
strip refuses pinned, changed, or unmatched sources. Provenance schema 2 separates
entries by canonical, symlink-resolved UTCP config path and retains raw host names
for ejection. This path identity survives atomic replacement of the config file.
Legacy and version-2 alias keys normalize in memory on read and persist only on
an explicit write. Conflicting entries for the same config/manual fail before
mutation rather than choosing a source. Corrupt provenance stops the operation. Sidecar writes are atomic
and use private file permissions.

Tests use temporary synthetic host/config files and a fake credential executable.
They do not authorize live migration, provider discovery, or authentication.
Ejection preserves variable references; review each target host's credential
resolution before a real migration. Existing backup-on-write recovery remains
necessary for failures across separate host, environment, and UTCP files.
