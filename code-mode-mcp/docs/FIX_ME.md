# FIX_ME — config-builder run diagnostics (2026-06-25)

Issues from `npm run config-builder` against `hide-some.utcp_config.json`, with
investigation findings, fixes, and **what was applied**.

Repos touched:
- `code-mode-mcp/` (this repo) — config-builder script + runtime server
- `~/github/microsoft-mcp` — FastMCP server name (pending)
- `~/github/google-sheets-mcp-server` — discovery-cache warning (applied)
- `~/github/salesforce-mcp-auto-auth-chrome` — SIGINT (applied)
- `~/github/crx-downloads/…/vendor/customaise-mcp` — EADDRINUSE log (applied)

---

## ✅ Applied this round

| # | Fix | Where |
|---|-----|-------|
| 4 | Cold-start timeout (90s) + bounded retry of empty manuals | `scripts/lib/utcp-config.mjs` |
| 4 | EADDRINUSE log downgraded error→notice | `customaise vendor extension-bridge.js:217` |
| 6a | `cache_discovery=False` (silences oauth2client warning) | `google_sheets_api.py:79-80` |
| 6b | `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` env | `hide-some.utcp_config.json` chrome-devtools |
| 7a | env precedence (process.env wins) + both var names | `scripts/lib/utcp-config.mjs:resolveConfigPath` |
| 7a | runtime reads UTCP_CONFIG_PATH + UTCP_CONFIG_FILE from env/.env | `index.ts` |
| 7b | `tsc` build dropped → run via **tsx** (not bun) | `package.json`, `config-builder-server.mjs` |
| 8b | clean `KeyboardInterrupt` handling | `salesforce …/__main__.py:126` |

Still open: **#1/#2** (discovery resilience helped by #4; #2 stderr needs upstream),
**#3** (skipped), **#6c** (microsoft name — not requested this round).

---

## 1. 15 of 31 manuals registered 0 tools — partially addressed by #4

Servers booted, answered `tools/list`, yet 0 tools captured → **cold-start
timeout race** + stdout noise (#2). Discovery is already fault-isolated
(`@utcp/sdk index.cjs:1488-1503`, `@utcp/mcp index.js:4249-4288`); the 30s
per-server default timeout (`@utcp/mcp index.js:4220`) was the squeeze.

**Applied (#4):** `scripts/lib/utcp-config.mjs`
- `withAllManualsEnabled()` now injects `timeout: 90` (seconds) into every MCP
  server that doesn't set one — `DISCOVERY_TIMEOUT_SECONDS`.
- `discoverManuals()` runs up to **3 discovery passes** (`MAX_DISCOVERY_ATTEMPTS`):
  pass 1 launches everything; later passes relaunch **only** the manuals that
  still returned 0 tools (`withOnlyTemplates()`), with 1.5s×n backoff. Tools are
  merged + deduped by full name across passes, so retries only ADD.
- Net: cold-start victims get extra attempts without re-paying for the servers
  that already succeeded. The empty-manual warning is now genuinely last-resort.

---

## 2. ✅ Child stderr noise — patched locally (upstream still unfixed)

`@utcp/mcp` builds StdioClientTransport with no `stderr` option → child stderr
defaults to `'inherit'` and floods the terminal during discovery.

**Upstream check:** installed **1.1.1**, latest **1.1.3**; the fix is in NO
published version — even upstream `main`
(`packages/mcp/src/mcp_communication_protocol.ts`) lacks `stderr` handling.
Upgrading does not help; no other `@utcp/*` bump addresses it.

**Applied — `patch-package`** in `code-mode-mcp`:
- Patched both `node_modules/@utcp/mcp/dist/index.js` and `dist/index.cjs`
  StdioClientTransport construction to add:
  ```js
  stderr: process.env.UTCP_MCP_CHILD_STDERR === "inherit" ? "inherit" : "ignore"
  ```
  Default `"ignore"` safely discards child stderr (NOT `"pipe"` — with no reader
  the OS pipe buffer fills and a chatty child deadlocks). Set
  `UTCP_MCP_CHILD_STDERR=inherit` to see child stderr when debugging.
- Patch committed at `patches/@utcp+mcp+1.1.1.patch`; `"postinstall":
  "patch-package"` added so it re-applies after every install. `patch-package`
  added as devDependency. `tsc --noEmit` passes; patch applies cleanly.
- **TODO:** upstream the same change as a PR so the patch can eventually be dropped.

code-mode-mcp's own stdout is already protected (`index.ts:721-728`).

---

## 3. Microsoft MSAL auth  ⏭️ SKIPPED (deferred, do not action)

---

## 4. Port self-correction + customaise log — addressed

- **customaise-mcp already self-corrects** (detected :4050 busy → attached as
  follower). The config-builder dashboard port also already auto-falls-back
  (`config-builder-server.mjs:196-217`). No functional change needed.
- **Applied (cosmetic):** `customaise …/vendor/customaise-mcp/2.0.7/package/dist/
  extension-bridge.js:217` — the `wss 'error'` handler now logs EADDRINUSE as a
  `WebSocket notice: … connecting as follower` instead of `WebSocket server
  error`. Other errors still log as errors; the reject (→ follower fallback) is
  unchanged. ⚠️ This is a **vendored-dist patch** — re-apply if customaise-mcp is
  re-vendored/upgraded (upstream the change to customaise-mcp proper).
- General "load whatever it can on the fly" resilience is the #4 retry above.

---

## 5. Salesforce — auth OK, tools lost

Cookie auth succeeds, server answers ListTools, 0 tools registered → same
cold-start race as #1. Covered by the #4 retry/timeout.

---

## 6. Deps / banners / server name

### 6a. ✅ google-sheets discovery-cache warning
`file_cache is only supported with oauth2client<4.0.0` was NOT a version problem
(deps near-latest; do NOT add deprecated `oauth2client`). **Applied:**
`google_sheets_api.py:79-80` now passes `cache_discovery=False` to both
`build(...)` calls.

### 6b. ✅ chrome-devtools banners
Config already passed `--usage-statistics=false` + `--category-performance=false`.
**Applied:** added `env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" }` to the
chrome-devtools manual as belt-and-suspenders. The remaining "exposes content of
the browser" disclosure has **no flag** — it's stderr-only and will be tamed by
the #2 `stderr: 'pipe'` fix.

### 6c. ✅ FastMCP server name
`~/github/microsoft-mcp/src/microsoft_mcp/tools.py:69`
`FastMCP("microsoft-graph-mcp")` → **`FastMCP("microsoft-mcp")`**. Safe (UTCP
namespaces by config manual name, already `microsoft-mcp`; zero side effects).

---

## 7. config-builder startup — env var + build speed

### 7a. ✅ env vars (both names, all sources)
- **config-builder** (`scripts/lib/utcp-config.mjs:resolveConfigPath`): precedence
  reordered so **process.env wins over `.env`** (CLI arg → env → `.env`), both
  `UTCP_CONFIG_PATH` and `UTCP_CONFIG_FILE` recognized everywhere. Fixes the
  stale-`.env`-shadows-inline trap.
- **runtime server** (`index.ts`): previously only read `UTCP_CONFIG_FILE`. Now
  loads `.env` via dotenv and resolves `UTCP_CONFIG_PATH` → `UTCP_CONFIG_FILE`
  from process env (inline or shell profile like `~/.zshrc`) first, then `.env`.
- The mangled `UTCP_CONFIG_PATH⏎=…` line was a shell/paste artifact, not a bug.

### 7b. ✅ build speed — tsx, NOT bun
- Dropped `npm run build` (full `tsc --max-old-space-size=8192`) from the
  `config-builder` scripts. Now `tsx scripts/config-builder-server.mjs`; the
  server imports `../index.ts` directly (no `dist/` build).
- ⚠️ **Bun was rejected**: importing the discovery pipeline loads the native
  `isolated-vm` addon, which Bun cannot dlopen (`ERR_DLOPEN_FAILED`). tsx runs on
  Node, so isolated-vm loads fine. `tsx` added as a devDependency.
- Verified: `tsx` imports the TS entry + isolated-vm cleanly; `tsc --noEmit`
  passes.

---

## 8. Messy shutdown — KeyboardInterrupt tracebacks

### 8b. ✅ salesforce-mcp-auto-auth-chrome (the wrapper we own)
`src/salesforce_mcp_auto_auth_chrome/__main__.py:126` — `connector_main()` now
wrapped in `try/except KeyboardInterrupt` (logs + returns 0). Root cause is the
vendored `mcp-salesforce-connector`'s `asyncio.run(server.run())`; the wrapper
catch neutralizes it without editing site-packages.

### 8a. ✅ google-sheets SIGINT
`google_sheets.py:163` `mcp.run(transport="stdio")` now wrapped in
`try/except KeyboardInterrupt` (logs clean shutdown). Both #8 servers fixed.

---

## ✅ Python security bumps applied (per-project venvs created)

Each repo got a real `.venv` via `uv sync`; flagged security/TLS transitives
bumped in the lock (msal/azure-identity left untouched). Results:

| Repo | cryptography | pyjwt | urllib3 | requests | certifi |
|------|-------------|-------|---------|----------|---------|
| microsoft-mcp | 46→**48.0.1** ⚠️ | 2.10→2.13 | 2.6→2.7 | 2.32→2.34 | →2026.6.17 |
| google-sheets-mcp-server | 46→**49.0.0** | 2.10→2.13 | 2.6→2.7 | 2.32→2.34 | →2026.6.17 |
| salesforce-mcp-auto-auth-chrome | 46→**49.0.0** | 2.13 (already) | 2.7 (already) | 2.34 (already) | 2026.6.17 (already) |

Notes:
- ⚠️ **microsoft-mcp cryptography capped at 48.0.1** — `msal` pins
  `cryptography<49`. Reaching 49 needs an msal bump, deliberately skipped (MS
  auth is out of scope, #3). pyjwt + TLS stack still bumped.
- **salesforce** required raising its `pyproject.toml` direct-dep cap
  `cryptography>=42,<47` → `>=49,<51` (lock-only bump was a no-op under `<47`).
- **google-sheets**: `google-auth==2.46.0` is **yanked** upstream (py3.8 incompat)
  — not a flagged pkg, but worth pinning forward separately.
- Smoke imports passed in all three (`cryptography`/`jwt` import + package import).

---

## Appendix — full dependency outdated scan (2026-06-25)

> ⚠️ The Python tables below were scanned BEFORE the venvs existed (shared global
> env), so they are indicative. The bumps above are the authoritative per-project
> result.

### @utcp/* upgrades available (none fix #2)
`@utcp/mcp` 1.1.1→1.1.3 · `@utcp/sdk` 1.1.0→1.1.2 · `@utcp/cli` 1.1.0→1.1.1 ·
`@utcp/http` 1.1.0→1.1.11 · `@utcp/code-mode` 1.2.11→1.2.12 ·
`@utcp/direct-call` 1.1.0→1.1.1 (ts-library).

### code-mode-mcp (npm)
`@modelcontextprotocol/sdk` 1.21.1→**1.29.0** · `@clack/prompts` 0.7.0→1.6.0 ·
`@types/node` 20→26 · `dotenv` 16→17 · `typescript` 5.9.3→6.0.3 · `zod` 3→4.
(major bumps zod/ts/@types deferred — breaking.)

### typescript-library (npm)
`isolated-vm` 6.0.2→6.1.2 · `@utcp/sdk` 1.1.0→1.1.2 · `jest` 29→30 ·
`@types/jest` 29→30 · `typescript` 5→6 · `@types/node` 20→26.

### Python — security/stability flags (shared env)
- **`cryptography` 46.x → 49.0.0** — microsoft-mcp, google-sheets, salesforce. Top priority.
- **`pyjwt` 2.10.1 → 2.13.0** — microsoft-mcp, google-sheets (JWT/security).
- **`urllib3` 2.6→2.7**, **`requests` 2.32→2.34**, **`certifi` →2026.6.17** — all repos (TLS/HTTP).
- **`mcp` 1.25.0 → 1.28.0** — microsoft-mcp, google-sheets.
- Defer/test: `starlette` 0.50→1.3, `fastapi` 0.128→0.138, `pandas` 2→3, `transformers` 4→5.

---

## ✅ MCP runtime + dep bumps (this round)

| Repo | Bumped | Notes |
|------|--------|-------|
| code-mode-mcp | `@modelcontextprotocol/sdk`→**1.29.0**, `@utcp/mcp` 1.1.1→**1.1.3** (patch regenerated → `@utcp+mcp+1.1.3.patch`), `@utcp/code-mode`→**1.2.12**, `@utcp/sdk`→1.1.2, `@utcp/cli`→1.1.1, `@utcp/http`→1.1.11 | SDK 1.29 TS2589 fixed by types-only cast `inputSchema as any` (`index.ts:705`). code-mode 1.2.12 adopted after decoupling our prompt from upstream `AGENT_PROMPT_TEMPLATE` (it went async; our sandbox stays sync). |
| typescript-library | `@utcp/sdk`→1.1.2, `@utcp/direct-call`→1.1.1, `isolated-vm`→6.1.2, `ts-jest`→29.4.11 | build OK, 19/19 tests |
| google-sheets | `mcp` 1.25→**1.28**, `google-auth` 2.46.0(yanked)→**2.55.0** | none |
| microsoft-mcp | `mcp` 1.25→**1.28**, `msal` 1.34→**1.37.0**, `cryptography` 48.0.1→**49.0.0** | msal 1.37 relaxes pin to `cryptography<51`; azure-identity untouched, no auth code/flow touched. |

Verified: code-mode-mcp `tsc --noEmit` exit 0, `npm test` 40/40, patch applies clean.

### Follow-up resolutions (the 3 previously-blocked items)
- **SDK 1.29 TS2589** → ✅ fixed with a narrow types-only cast at the `server.registerTool` call (only `inputSchema` cast; name/title/description/handler stay typed). No runtime change.
- **@utcp/code-mode 1.2.12** → ✅ NOT prompt-only: it ships a real async execution harness + wall-clock timeout (`Promise.race`) + `undefined→null` + better error stacks. Adopted for those runtime fixes; kept the server's deliberate **sync-only** contract by replacing the embedded `AGENT_PROMPT_TEMPLATE` with an inline sync guide (`buildPromptText`), so the sync-only test stays green. (Async now works under the hood if ever wanted — flip the prompt to advertise it.)
- **microsoft-mcp cryptography→49** → ✅ unblocked by msal 1.37.0 (`cryptography<49`→`<51`). msal constraints checked per version: 1.34/1.35/1.36 = `<49`; 1.37 = `<51`.

---

## 9. ✅ Manuals "duplicated" (31 instead of 16) — name-sanitization mismatch

`npm run config-builder` reported **31 manuals** (16 config + 15 phantom) and 15
"returned no tools" — but the tools WERE discovered (427). Root cause: the UTCP
SDK sanitizes manual names to identifiers
(`name.replace(/[^a-zA-Z0-9_]/g, "_")`), so it files tools under
`salesforce_mcp.…` while the config template is named `salesforce-mcp`.
`discoverManuals` matched by **exact name**, so each hyphenated manual looked
empty AND its tools landed under a duplicate **orphan** manual. (`typefully`,
the only hyphen-free name, matched — hence 15, not 16, empty.)

This also means the earlier "#1 0-tools / cold-start timeout" reading was wrong
for these manuals — they never failed; they were mis-attributed.

**Applied** in `scripts/lib/utcp-config.mjs`:
- Added `toManualIdentifier()` mirroring the SDK sanitizer.
- Template→tool matching now looks up by both the raw and sanitized name
  (`mergedFor`, the `manuals` map, and `emptyTemplateNames`).
- Orphan-manual creation now skips any manual whose raw OR sanitized name matches
  a template — kills the duplicates.
- `shortNameOf` in `config-builder-server.mjs` strips the sanitized prefix too.
- Fix flows to `generate-exclusion-configs.mjs` (shares the lib + keys by
  `manual.name`). Side effect: the spurious retries/empty-warning stop firing.

### 9b. ✅ Doubled tool names in include_tools/exclude_tools + broken matcher
Generated configs listed tools like `proxyman_mcp.proxyman-mcp.answer_setup_question`
— the raw 3-segment UTCP name (`<sanitizedManual>.<serverKey>.<tool>`). Ugly AND
non-functional: the runtime exposes the collapsed alias `proxyman_mcp.answer_setup_question`,
and the exclusion registry was keyed by the raw template name `proxyman-mcp`
(hyphen) while tool segments are sanitized (`proxyman_mcp`), so the gate never hit.
Two fixes:
- `scripts/lib/utcp-config.mjs`: `exposeCleanToolNames()` collapses the redundant
  server segment during discovery (mirrors `index.ts buildToolAliasIndex`), so
  written entries match the runtime-exposed names and aren't doubled.
- `tool-exclusion.ts`: `applyManualExclusion` now registers each rule under BOTH
  the raw template name and its sanitized identifier, so the runtime matcher's
  `registry.get(manualName)` gate hits for hyphenated manuals.
- Verified: 40/40 tests pass. **Regenerate the configs** to pick up clean names.

---

## Priority order (remaining)

1. **#2 upstream PR** — submit the `stderr` change to `@utcp/mcp` so the
   patch-package shim (now `@utcp+mcp+1.1.3.patch`) can be dropped later.
   **This is the only open item.**

Everything else ✅: ~~#1 retry~~ · ~~#2 stderr patch~~ · ~~#4 port/customaise~~ ·
~~#6a/b/c~~ · ~~#7a/b~~ · ~~#8a/b~~ · ~~Python security bumps~~ ·
~~google-auth pin~~ · ~~MCP runtime bumps (SDK 1.29, mcp 1.28, @utcp/*)~~ ·
~~@utcp/code-mode 1.2.12~~ · ~~microsoft-mcp cryptography→49 (via msal 1.37)~~.
~~#3 MSAL token failures~~ — SKIPPED (out of scope).
