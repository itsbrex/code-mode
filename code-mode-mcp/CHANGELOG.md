# Changelog

All notable changes to the private local bridge `@itsbrex/code-mode-mcp`.
The package is not published; versions mark tested checkpoints of the
`feat/fork-integration` branch.

## 1.4.0 — 2026-10-18

Wave 7 of the UTCP modernization plus the manual-normalization fix.

### Removed (wave 7)

- The deprecated `get_required_variables_for_tool` tool alias is no longer
  served. The canonical seven-tool surface is the whole surface.
- `UTCP_CONFIG_PATH` is rejected with an explicit error; `UTCP_CONFIG_FILE`
  is the only config variable. Legacy host keys and config aliases are no
  longer read by the bridge, the config builder or the host importer.

### Added

- Manual normalization at config load and at runtime `register_manual`:
  an `mcp` server entry gets an explicit `transport` and an `http` (OpenAPI)
  manual with `auth` gets the same block as `auth_tools`. Without the latter
  every generated tool was sent unauthenticated and the API answered 401.
  Each change is reported on stderr.
- Namespaced variable aliases: `${VAR}` inside manual `m` resolves to `m_VAR`;
  when only the bare name exists in `.env` or the environment, it is aliased
  into `variables` so existing configs keep working.
- Host import binds imported servers to their reviewed source identity and
  preserves provenance across native config case aliases; ejection is
  validated and preflighted as one batch before any host write.
- Config tooling auto-wraps itself in the `op run` secret environment.
- CI verifies the bridge with synthetic host configs on Linux and the
  bridge-path tests on Windows.

### Changed

- UTCP packages refreshed: `@utcp/mcp` 1.1.7, `@utcp/sdk` ^1.1.2,
  `@utcp/http` ^1.1.11, `@utcp/code-mode` ^1.2.13. Upstream
  `typescript-utcp` PR #42 shipped the circular-reference-safe schema
  dereference, quiet child stderr and the `structuredContent` handling that
  this bridge had carried as a patch since July. The remaining
  `patches/@utcp+mcp+1.1.7.patch` holds only the fork-specific boolean
  sub-schema normalization and keeps `content` ahead of `structuredContent`.
- Upstream code-mode isolate fixes adopted: a tool call can no longer pin an
  isolate thread, and a memory-limit error surfaces instead of stranding the
  call on the timeout.
- Bridge imports resolve CommonJS entrypoints, directory edges, module URLs
  and symlinks the way Node does; literal `module.require` delegates are
  pinned.

### Fixed

- Audited parser and HTTP dependencies patched; npm audit clean.
- Credential output masking preserved across the host-import path.
- Config-builder: session token required on writes, exclusion config no
  longer wiped, dashboard state bugs corrected; rebuilt dashboard with the
  old one kept behind `--legacy`.

## 1.3.1 — 2026-08-23

- `@utcp/mcp` patch gained boolean sub-schema normalization so one `true`
  schema no longer drops a whole manual at registration.

## 1.3.0 — 2026-08-21

- `bridge_v1_*` extension tools removed; the canonical seven tools serve the
  exclusion-aware client directly. `get_required_variables_for_tool` kept as
  a deprecated alias (removed in 1.4.0).
