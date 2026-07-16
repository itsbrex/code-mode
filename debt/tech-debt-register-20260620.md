# Tech Debt Register — code-mode

**Date:** 2026-06-20
**Scope:** `code-mode` monorepo (3 packages, 9 source files, 3 223 LOC)
**Method:** Read-only static analysis, grep, line counting, dependency audit

## Severity Scale

| Score | Meaning |
|-------|---------|
| 5 | Blocks releases |
| 4 | Recurring incidents |
| 3 | Friction (slows development) |
| 2 | Minor |
| 1 | Cosmetic |

## Ranked Debt Items

| ID | Category | Sev | Effort | Evidence | Remediation |
|----|----------|-----|--------|----------|-------------|
| TD-01 | dependencies | 5 | S | `code-mode-mcp`: 11 npm vulns (5 high, 6 moderate). `@modelcontextprotocol/sdk <=1.25.3` has 3 high-severity CVEs (ReDoS, cross-client data leak, DNS rebinding). Transitive `axios 1.0.0–1.15.2` carries 23 CVEs (SSRF, prototype pollution, credential leak). `fast-uri`, `form-data`, `path-to-regexp` also affected. All have fixes available. | Run `npm audit fix` in `code-mode-mcp/`. Pin `@modelcontextprotocol/sdk` to `>=1.26.0`. Verify transitive `axios` resolves to `>=1.16.0`. |
| TD-02 | coverage | 4 | M | No CI/CD pipeline exists — no `.github/workflows/`, no `.gitlab-ci.yml`, no `Jenkinsfile`. Tests, builds, and security scans run only locally and manually. | Add a GitHub Actions workflow with `npm test`, `npm audit`, and `pytest` steps for all three packages. |
| TD-03 | smells | 3 | S | 15 `any` type usages across `code-mode-mcp/index.ts` (6) and `typescript-library/src/code_mode_utcp_client.ts` (9). Three `as any` casts at lines 80, 119, 398 fully bypass type checking. | Replace `as any` with proper types or type guards. Use `unknown` + narrowing for catch clauses. For generated interface strings (`lines 388, 407, 454, 517`), use `Record<string, unknown>`. |
| TD-04 | smells | 3 | S | No ESLint, Prettier, or Biome configuration in either TypeScript project. No code formatting or linting enforcement. | Add `eslint` + `@typescript-eslint` + `prettier` to both TS projects. Add a root `.editorconfig`. Add `ruff` to the Python project. |
| TD-05 | complexity | 3 | M | `_create_execution_context()` in `code_mode_utcp_client.py:381–519` is 139 lines with 7 levels of nesting (class > method > inner func > inner func > try > try > if > with). Combines context setup, import restriction, print collection, tool function factory, and namespace registration. | Extract `make_tool_function` and the async-to-sync bridge into standalone methods. Split context setup from tool registration. |
| TD-06 | coverage | 3 | M | Test files exist for all 3 source files but coverage gaps remain: no tests for Python async-to-sync bridge (`tool_function` inner function), no edge-case tests for TS schema conversion (union types, null types, nested arrays), no integration tests for `initializeUtcpClient`, `registerMcpTools`, `createMcpServer`, or `startServer` in the MCP package. | Add targeted tests for the async-to-sync bridge, schema edge cases, and MCP server lifecycle. Add coverage thresholds to CI. |
| TD-07 | complexity | 3 | M | `getToolDefinitions()` in `code-mode-mcp/index.ts:440–634` is 194 lines — a single factory function returning 7 inline tool handlers. | Extract each tool handler into a named function. Keep `getToolDefinitions` as a thin array of references. |
| TD-08 | smells | 3 | M | `let utcpClient: CodeModeUtcpClient \| null = null` at `code-mode-mcp/index.ts:45` is a module-level mutable singleton. The project's own `.claude/rules/antipatterns.md` prohibits global mutable state and recommends dependency injection. | Refactor to pass client via constructor/parameter injection. The existing `ToolRuntimeOptions.getClient` pattern is already a partial DI escape hatch — extend it. |
| TD-09 | duplication | 2 | S | `setupToolBridges()` in `code_mode_utcp_client.ts:310–342` has two branches (namespaced vs. non-namespaced) generating nearly identical JS code strings. Only the target path (`global.${namespace}.${fn}` vs `global.${fn}`) differs. | Extract a shared template function parameterized by the target path. |
| TD-10 | smells | 2 | S | `code-mode-mcp/tsconfig.json` uses `moduleResolution: "node"` (legacy Node10 algorithm) for an ESM project. The sibling `typescript-library` correctly uses `"bundler"`. | Change to `"node16"` or `"bundler"` to match ESM semantics. |
| TD-11 | dependencies | 2 | M | Three packages share `@utcp/*` dependencies but have no monorepo tooling (no `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, or `lerna.json`). Each manages its own `node_modules` independently, risking version drift. | Add `pnpm-workspace.yaml` or `npm workspaces` in a root `package.json` to unify dependency resolution. |
| TD-12 | duplication | 2 | S | `sanitizeIdentifier()` is copy-pasted identically in `code-mode-mcp/index.ts:95–99` and `code_mode_utcp_client.ts:93–97`. | Export from the library and import in the MCP server, or move to a shared util. |
| TD-13 | size | 2 | S | `codedb.snapshot` (4.3 MB binary) is tracked in git at the repo root. Not in `.gitignore`. Bloats clone size. | Add to `.gitignore`. If needed for development, use Git LFS or distribute via a separate artifact. |
| TD-14 | smells | 2 | S | Mixed licenses: `code-mode-mcp` is MIT, `typescript-library` and `python-library` are MPL-2.0. This may create confusion for downstream consumers. | Align on a single license or document the intentional split in the README. |
| TD-15 | size | 2 | L | 4 source files exceed 500 lines: `code-mode-mcp/index.ts` (754), `code_mode_utcp_client.py` (738), `code_mode_utcp_client.test.ts` (645), `code_mode_utcp_client.ts` (574). | Address TD-05 and TD-07 first — those refactors will reduce the two largest files. The test file size is acceptable. |
| TD-16 | smells | 2 | S | `code-mode-mcp/package.json` build script uses `--max-old-space-size=8192` (8 GB) for a single-file TypeScript compilation. Suggests a past OOM issue that was papered over. | Investigate root cause (likely `isolated-vm` type definitions). If resolved, remove the flag. |
| TD-17 | size | 1 | S | `.specstory/history/` contains AI conversation logs (280 KB, 252 KB, 120 KB+). These are development artifacts, not source. | Add `.specstory/` to `.gitignore` or move to a separate archive. |
| TD-18 | smells | 1 | S | 1 pragma suppression: `# noqa: F811` at `code_mode_utcp_client.py:132` for a conditional re-import. | Restructure the import to avoid the re-definition warning, or document why the suppression is necessary. |
| TD-19 | duplication | 1 | XL | TypeScript and Python each implement 7 parallel JSON-Schema-to-language-type conversion functions with identical branching logic. Inherent in maintaining two language implementations. | Accept as structural. If a third language is added, consider a code-gen approach from a shared schema definition. |

## Summary

This is a small, focused codebase (3 223 LOC across 3 packages) with concentrated debt in a few areas. The **most urgent item is TD-01**: 11 known dependency vulnerabilities, all with available fixes, resolvable with a single `npm audit fix`. The **highest-leverage structural fix is TD-02**: adding CI/CD would catch future regressions automatically and gate releases on passing tests and audits. The remaining items are development-friction issues — `any` type proliferation, missing linting, and a few oversized functions — that would yield a cleaner, more maintainable codebase but don't pose immediate risk. Total remediation for the top 8 items (TD-01 through TD-08) is estimated at 2–3 developer-days.
