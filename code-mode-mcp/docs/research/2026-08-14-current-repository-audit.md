# Current repository audit against Code Mode and UTCP upstream

Research date: 2026-08-14

Scope: `/Users/hack/github/code-mode` at `85f832a` (plus upstream-baseline report commit `f531b77`), compared with Code Mode `04fba67b1aab632def1c8b321bf9fae851579ceb`, UTCP specification `262fd4b4b2a93a224711d27c929aa594ad974f78`, and released package baselines recorded in [the upstream report](./2026-08-14-upstream-code-mode-utcp-spec.md).

Method: CodeDB MCP was called first but returned `SnapshotLoadFailed` before and after a successful 92-file index. CodeDB CLI then loaded that index and supplied repository context, outlines, targeted reads, and searches. Git comparison against upstream commit `04fba67b…`, manifest/lock read-back, `npm pack --dry-run --json --ignore-scripts`, and existing test inventory completed the audit. No dependency installation or runtime/config mutation occurred.

## Executive result

Core engine source is not stale: TypeScript and Python implementation files are byte-identical to upstream cutoff, TypeScript is `1.2.12`, Python project metadata is `1.1.0`, and current async-result/helper fixes are present. Current MCP dependencies also resolve released `@utcp/code-mode 1.2.12`, `@utcp/sdk 1.1.2`, `@utcp/mcp 1.1.3`, and `@utcp/http 1.1.11`. ([TypeScript manifest](../../../typescript-library/package.json#L1-L69), [Python manifest](../../../python-library/pyproject.toml#L5-L26), [MCP lock](../../package-lock.json#L601-L695), [upstream released matrix](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-mcp/package.json#L43-L65))

Modernization is still required. Highest-risk items are fork provenance/wire incompatibility under upstream package coordinates, a broken MCP package lifecycle for its required patch, and Python security/timeout claims that exceed actual isolation. Remaining work is package/runtime consistency, documentation repair, and UTCP v1.1 compatibility coverage.

Severity meanings: **high** = unsafe or likely consumer/runtime break; **medium** = compatibility/release defect needing planned correction; **low** = documentation or maintenance drift with bounded impact. Confidence reports evidence strength, not impact.

## Findings

### 1. Forked MCP behavior ships under upstream name and released version

**Severity: high. Confidence: high. Classification: intentional local divergence plus release/provenance defect.**

Local MCP manifest still declares public `@utcp/code-mode-mcp@1.2.1` and upstream repository URLs, but local bridge deliberately differs from released `1.2.1`:

- upstream tool `get_required_keys_for_tool` is replaced by `get_required_variables_for_tool`; local tests explicitly reject upstream name;
- `list_tools`, `search_tools`, and `tools_info` return local JSON envelopes and pagination rather than upstream response shapes;
- MCP tool aliases replace canonical names in fields labelled `utcp_name` for duplicated manual/server names;
- `call_tool_chain` adds `memory_limit` and returns `{result, logs}` text instead of upstream `{success, nonMcpContentResults, logs}` envelope.

Local evidence: [public package identity](../../package.json#L1-L56), [tool list and serialized-name model](../../index.ts#L43-L110), [local prompt/tool contract](../../index.ts#L341-L362), [local discovery/execution handlers](../../index.ts#L580-L732), and [tests proving divergence is deliberate](../../tests/index.test.mjs#L157-L180). Upstream evidence: [released prompt and registration surface](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-mcp/index.ts#L105-L167), [released discovery surface](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-mcp/index.ts#L169-L278), and [released execution envelope](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-mcp/index.ts#L280-L336).

**Plan input:** decide compatibility identity before more implementation. Either (a) keep upstream name/version and restore wire compatibility, retaining additions only as backward-compatible optional fields/aliases, or (b) mark package private or rename/version it as a fork and change repository URLs. If preserving fork contract, offer both required-key tool names during migration and keep true canonical UTCP name separate from local `access_name`.

### 2. MCP published-package lifecycle cannot reliably apply required `@utcp/mcp` patch

**Severity: high. Confidence: high. Classification: local packaging defect.**

Manifest runs `patch-package` on every install, but `patch-package` is only a development dependency and `files` allowlist excludes `patches/`. Same allowlist excludes config-builder, host-import, generator, dev scripts, and fallback `.utcp_config.json`, although npm scripts and README advertise them. Official npm rules state `files` controls tarball inclusion and development dependencies are for root development installs. ([manifest](../../package.json#L10-L27), [dependency placement](../../package.json#L58-L76), [patch](../../patches/@utcp+mcp+1.1.3.patch#L1-L68), [npm `files` contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files), [npm `devDependencies` contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#devdependencies))

Observed `npm pack --dry-run --json --ignore-scripts` included only `README.md` and `package.json` before build; `prepublishOnly` can add `dist`, but manifest cannot add excluded `patches/` or `scripts/`. `plan` and `plan:no-open` are worse: their target is intentionally ignored and absent from Git. ([ignored target](../../.gitignore#L214-L219))

Patch itself is current, not stale: it targets released `@utcp/mcp 1.1.3`, and upstream PR 33 containing all three hunks remains open. ([patch rationale](../../docs/DIAGNOSTICS_LOG.md#L58-L80), [upstream PR 33](https://github.com/universal-tool-calling-protocol/typescript-utcp/pull/33))

**Plan input:** keep patch until a released `@utcp/mcp` contains it, but make delivery testable: move `patch-package` to runtime dependencies, include `patches/**`, or replace postinstall patching with a maintained fork/override. Remove non-publishable npm scripts or include their targets. Add `npm pack` + install-from-tarball smoke test proving postinstall, bin, fallback config policy, and every advertised command.

### 3. Python library is not a process sandbox and cannot enforce timeout on runaway synchronous code

**Severity: high. Confidence: high. Classification: inherited upstream implementation/documentation defect.**

Python code compiles with RestrictedPython, executes via in-process `exec`, then runs user function in `ThreadPoolExecutor`. Timeout wraps the await, but executor context waits for running thread on exit; running Python threads cannot be forcibly cancelled. Repository test acknowledges infinite loops cannot be interrupted. ([execution path](../../../python-library/src/utcp_code_mode/code_mode_utcp_client.py#L233-L349), [test admission](../../../python-library/tests/test_code_mode_utcp_client.py#L233-L265), [Python executor shutdown semantics](https://docs.python.org/3/library/concurrent.futures.html#concurrent.futures.Executor.shutdown))

README nevertheless promises “Secure Process Sandboxing” and timeout protection against runaway code. RestrictedPython itself states it is not a sandbox or secured environment. ([local security claims](../../../python-library/README.md#L98-L104), [RestrictedPython project](https://github.com/zopefoundation/RestrictedPython))

**Plan input:** stop describing current runtime as process isolation. For untrusted code, move execution into disposable subprocess/container with OS-enforced wall-clock kill, memory/process/network/filesystem limits, and narrow tool IPC. Until then, document trusted-input boundary and timeout limitation prominently; add regression test that kills an infinite loop through actual process boundary.

### 4. Declared Node 18 support conflicts with resolved `isolated-vm` Node 22 floor

**Severity: high. Confidence: high. Classification: inherited upstream range defect exposed by refreshed locks.**

All Node packages declare Node `>=18`, while locks resolve `isolated-vm 6.0.2` or `6.1.2`, whose own metadata requires Node `>=22`. CLI depends directly on `^6.0.0`; TypeScript package exposes same peer range. ([MCP manifest](../../package.json#L52-L76), [MCP resolved engine](../../package-lock.json#L1917-L1929), [CLI manifest](../../../code-mode-cli/package.json#L43-L60), [CLI resolved engine](../../../code-mode-cli/package-lock.json#L1023-L1034), [TypeScript manifest](../../../typescript-library/package.json#L46-L68), [TypeScript resolved engine](../../../typescript-library/package-lock.json#L3028-L3040))

**Plan input:** choose supported floor from tested artifact. Raise Node engine to `>=22` across affected packages, or pin an actually Node-18-compatible `isolated-vm` and prove Node 18 installation/build/runtime. Add engine matrix and lock read-back to CI.

### 5. MCP lock root version remains `1.2.0`

**Severity: medium. Confidence: high. Classification: local lock metadata defect.**

Package and server report `1.2.1`, but both lock root version fields remain `1.2.0`. ([manifest](../../package.json#L1-L4), [server metadata](../../index.ts#L775-L780), [lock root](../../package-lock.json#L1-L10))

**Plan input:** regenerate lock after package identity decision and add consistency test covering manifest, lock root, server-reported version, package coordinates, and repository URLs.

### 6. Python release metadata remains internally inconsistent

**Severity: medium. Confidence: high. Classification: inherited upstream defect.**

`pyproject.toml` and PyPI baseline are `1.1.0`, but module exports `__version__ = "1.0.0"`; source/issues URLs point at `python-utcp`, not Code Mode. Project guide is older still, claiming `0.0.3` and `utcp>=1.0`. ([project metadata](../../../python-library/pyproject.toml#L5-L41), [module version](../../../python-library/src/utcp_code_mode/__init__.py#L34-L44), [project guide](../../../CLAUDE.md#L40-L52), [PyPI 1.1.0](https://pypi.org/project/code-mode/1.1.0/))

**Plan input:** derive module version from installed metadata, correct URLs, update project guide to `1.1.0` and `utcp>=1.1.2`, and add metadata consistency test.

### 7. TypeScript and Python usage docs contradict actual execution models

**Severity: medium. Confidence: high. Classification: documentation defect, partly inherited upstream.**

TypeScript runtime and tests support async function body, top-level `await`, and explicit return, but TypeScript README says “Do not use `await`.” ([runtime](../../../typescript-library/src/code_mode_utcp_client.ts#L208-L275), [README contradiction](../../../typescript-library/README.md#L118-L133), [await regression tests](../../../typescript-library/tests/code_mode_utcp_client.test.ts#L356-L390))

Python does opposite: implementation wraps code in ordinary `def` and exposes synchronous tool functions, while README and package docstring show `await` inside tool-chain code; docstring also calls nonexistent sandbox `search_tools`. ([Python wrapper](../../../python-library/src/utcp_code_mode/code_mode_utcp_client.py#L280-L349), [synchronous tool bridge](../../../python-library/src/utcp_code_mode/code_mode_utcp_client.py#L465-L523), [README await example](../../../python-library/README.md#L69-L85), [module docstring](../../../python-library/src/utcp_code_mode/__init__.py#L14-L31))

**Plan input:** generate or test docs against language-specific prompt templates. TypeScript: allow optional await. Python: no await inside chain unless runtime becomes async; remove `search_tools` from sandbox examples. Never force helper spelling across languages (`__interfaces`/`__getToolInterface` versus `interfaces`/`get_tool_interface`).

### 8. UTCP v1.1 schema is used, but v1.1 security behavior is untested

**Severity: medium. Confidence: high. Classification: missing compatibility coverage, not observed production-schema defect.**

Positive findings: checked production code/config contains no v0.1 `providers`, `provider_type`, tool `parameters`, or tool `provider`; sample config uses `manual_call_templates` and `call_template_type`; plugins are imported explicitly before client creation; SDK serializers validate config/manual boundaries. ([sample config](../../.utcp_config.json#L1-L25), [bridge imports/serializer](../../index.ts#L14-L28), [bridge config validation](../../index.ts#L800-L857), [CLI validation](../../../code-mode-cli/src/validate.ts#L23-L98), [v0.1-to-v1.0 migration](https://github.com/universal-tool-calling-protocol/utcp-specification/blob/262fd4b4b2a93a224711d27c929aa594ad974f78/docs/migration-v0.1-to-v1.0.md#L69-L179))

Gap: no repository fixture or test exercises `allowed_communication_protocols`, single-protocol default filtering, mixed-protocol opt-in, or call-time rejection. UTCP v1.1 requires this behavior. ([v1.1 migration](https://github.com/universal-tool-calling-protocol/utcp-specification/blob/262fd4b4b2a93a224711d27c929aa594ad974f78/docs/migration-v1.0-to-v1.1.md#L15-L109), [client enforcement](https://github.com/universal-tool-calling-protocol/utcp-specification/blob/262fd4b4b2a93a224711d27c929aa594ad974f78/docs/api/core/utcp/implementations/utcp_client_implementation.md#L25-L57))

**Plan input:** add SDK-backed fixtures for legacy-key rejection, single-protocol registration, mixed-protocol registration without/with exact allowlist, and call-time denial. Do not infer `utcp_version` value from contradictory spec prose; validate fixtures with installed serializer.

### 9. Host import writes unvalidated, unsanitized manual names

**Severity: medium. Confidence: medium-high. Classification: local spec-boundary gap.**

Converter copies host server name directly into manual `name`; apply path appends manuals to JSON without `CallTemplateSerializer`. Planning code knows sanitized form for dedupe but does not emit it. UTCP call-template names permit letters, numbers, and underscores; special characters should be replaced. ([converter](../../scripts/lib/host-import/to-utcp.mjs#L1-L45), [write path](../../scripts/lib/host-import/apply.mjs#L8-L28), [dedupe-only sanitizer](../../scripts/lib/host-import/plan.mjs#L5-L28), [name contract](https://github.com/universal-tool-calling-protocol/utcp-specification/blob/262fd4b4b2a93a224711d27c929aa594ad974f78/docs/api/core/utcp/data/call_template.md#L10-L39))

**Plan input:** sanitize deterministically before emission, preserve original host name as provenance metadata if needed, validate every generated template with installed serializer before write, and add hyphen/dot/space/collision tests.

### 10. Bridge verification covers local unit contract, not released wire/runtime contract

**Severity: medium. Confidence: high. Classification: test gap.**

Current MCP tests prove local prompt, aliases, pagination, exclusion, and stubbed inspect/execute flow. They do not launch stdio bridge, register actual protocol plugins/manuals, assert stdout contains only MCP frames, exercise thrown error/timeout/oversize, or cover single/multiple MCP content blocks and structured-only results. Local `@utcp/mcp` patch hunks also lack direct patch-application/integration tests. ([unit contract](../../tests/index.test.mjs#L157-L430), [serialization-only tests](../../tests/safe-json-stringify.test.mjs#L1-L41), [patch](../../patches/@utcp+mcp+1.1.3.patch#L1-L68), [released bridge semantics](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-mcp/index.ts#L280-L380))

**Plan input:** add tarball install smoke, real stdio MCP handshake, plugin registration, exact seven-tool schema/annotation snapshots, content-block matrix, error/timeout/output-limit cases, and patch hunk behavior. Run against chosen MCP SDK version before moving from locked `1.29.0` to `1.30.x`; upstream research did not establish that compatibility.

### 11. CLI `0.1.2` is unreleased and its core locks lag current released adapters

**Severity: low-medium. Confidence: high. Classification: unreleased-source status plus deliberate upgrade candidate.**

Local CLI correctly matches upstream-main source version `0.1.2`, not npm latest `0.1.1`; do not call `0.1.2` a released dependency. Its lock still resolves `@utcp/sdk 1.1.1` and `@utcp/http 1.1.7`, while current released floors used by MCP/TypeScript are `1.1.2` and `1.1.11`. ([CLI manifest](../../../code-mode-cli/package.json#L1-L60), [CLI lock](../../../code-mode-cli/package-lock.json#L191-L218), [upstream source manifest](https://github.com/universal-tool-calling-protocol/code-mode/blob/04fba67b1aab632def1c8b321bf9fae851579ceb/code-mode-cli/package.json#L1-L64), [npm CLI 0.1.1](https://www.npmjs.com/package/@utcp/code-mode-cli/v/0.1.1), [npm SDK 1.1.2](https://www.npmjs.com/package/@utcp/sdk/v/1.1.2), [npm HTTP 1.1.11](https://www.npmjs.com/package/@utcp/http/v/1.1.11))

**Plan input:** keep released and source baselines separate. After Node-floor decision, refresh CLI ranges/lock deliberately and run config, OAuth, protocol registration, stdout JSON/NDJSON, stderr, and tool-chain tests. Do not deploy `0.1.2` from registry until published.

## Intentional divergences worth retaining after explicit compatibility decision

- MCP server fixes upstream metadata defects: server/package version is `1.2.1`, repository URLs point at Code Mode, prompt names actual `tools_info`, error responses set `isError`, four inspection tools carry read-only annotations, MCP content blocks are preserved, and stdio logging is redirected before transport connection. ([server source](../../index.ts#L341-L362), [handlers](../../index.ts#L476-L519), [registration/startup](../../index.ts#L736-L877))
- Tool exclusion is local extension, but custom keys are stripped before SDK serialization; tests cover deny/allow semantics. ([strip boundary](../../tool-exclusion.ts#L12-L45), [config sanitation](../../tool-exclusion.ts#L117-L134), [tests](../../tests/tool-exclusion.test.mjs#L91-L134))
- `UTCP_CONFIG_PATH` support is additive. README only documents `UTCP_CONFIG_FILE`, so document both and exact precedence if divergence remains. ([runtime precedence](../../index.ts#L808-L839), [incomplete README](../../README.md#L14-L30))
- Patch is justified until upstream PR 33 lands in a release; issue is delivery and verification, not patch age.

## Change-plan order for this repository

1. **Decide package identity and compatibility target.** Choose upstream wire compatibility versus named/private fork. This controls every later API, version, and publishing change.
2. **Fix security boundary.** Reframe Python as trusted-input restricted execution immediately; design process isolation before claiming sandbox/timeout guarantees.
3. **Repair package/install contract.** Make patch distributable or replace with fork, remove absent scripts, include required runtime assets, fix lock root, and prove packed tarball installation.
4. **Resolve runtime floors.** Align Node engines with resolved `isolated-vm`; establish CI matrix.
5. **Restore/bridge MCP compatibility.** Dual-name required-keys tool if needed, preserve canonical UTCP names, version local output envelopes, and snapshot schemas/annotations.
6. **Add UTCP v1.1 and stdio integration matrix.** Cover allowlists, serializers, plugins, content blocks, errors, timeout/output limits, and stdout cleanliness.
7. **Repair Python/TypeScript docs and metadata.** Correct versions, URLs, await guidance, config precedence, and security language; test examples.
8. **Refresh CLI dependencies separately.** Treat `0.1.2` as source-only until published and verify OAuth/JSON contracts under chosen dependency set.

## Verification status

- `npm pack --dry-run --json --ignore-scripts` completed and proved current pre-build allowlist contents.
- Existing test commands were attempted without installing dependencies, per ticket constraint. MCP and CLI builds could not find local TypeScript; TypeScript library could not find Jest; Python collection could not find `pytest_asyncio`. No suite executed. Exact failures: `Cannot find module .../node_modules/typescript/bin/tsc`, `jest: command not found`, and `ModuleNotFoundError: No module named 'pytest_asyncio'`.
- No code, manifest, lockfile, config, test, ticket, or map changed by this audit.
