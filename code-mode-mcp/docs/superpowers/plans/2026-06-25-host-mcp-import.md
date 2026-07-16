# Host → UTCP MCP Import (code-mode federation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a migration tool that reads the traditional MCP servers registered in the host configs (Claude Code `~/.claude.json`, Claude Desktop `claude_desktop_config.json`, Codex `~/.codex/config.toml`), converts each into a UTCP `mcp` manual template (wrapping remote/OAuth servers via `mcp-remote`), dedups against the existing UTCP config, writes them in (backup-on-write), and — opt-in — strips them from the host configs, so `code-mode` becomes the single driver for all MCP tools. It also supports **pinning** (servers a host keeps that the tool never migrates or strips) and the inverse **eject** operation (move one or more UTCP manuals back out into standard MCP server entries in one or more hosts).

**Sync model (decided):** One-way, re-runnable consolidation — read all **3 host surfaces** (Claude Code, Claude Desktop, Codex) → UTCP config → optionally strip the hosts. It is NOT a bidirectional sync; nothing ever flows back into the hosts (the goal is to empty them down to a single `code-mode` entry). "Keeping in sync" = re-running the tool, which is idempotent and dedup-aware, so new host servers added later get picked up on the next run.

**Architecture:** A set of small, pure ESM modules under `scripts/lib/host-import/` (read → convert → plan/dedup → apply, plus backup/FIFO) driven by a thin CLI `scripts/host-import-cli.mjs`. The TOML/JSON MCP read approach and the normalized-server shape are borrowed from `ai-config-sync-manager` (`bin/ai-config-sync.mjs`); the backup/dry-run/confirm safety model is borrowed from its dashboard. The only genuinely new layer is host-server → UTCP-manual conversion. The dashboard UI is a **separate follow-up plan** (see end) that drives these same modules.

**Tech Stack:** Node ≥18 ESM, `node:fs`/`node:path` built-ins only (zero runtime deps), `node:test` + `node:assert` for tests. No TypeScript in the new modules (plain `.mjs`).

## Global Constraints

- **Runtime:** Node `>=18.0.0`, ESM (`"type": "module"`). New code is `.mjs`, zero runtime dependencies (Node built-ins only). Copied verbatim from `code-mode-mcp/package.json`.
- **Test runner:** `npm test` runs `npm run build && node --test tests/*.test.mjs`. New tests go in `code-mode-mcp/tests/*.test.mjs` and are auto-globbed.
- **No `rm`:** never shell out to `rm`; file deletion uses `node:fs` `rmSync`. (Backups make writes reversible.)
- **Never mutate host configs without `--apply` + `--strip-host`.** Default mode is dry-run. Every file write is preceded by a timestamped backup under `~/.host-import-backups/` with FIFO retention (keep 30). Backups are collision-safe: if the same file is backed up twice in one run (e.g. global + project strips of `~/.claude.json` in the same millisecond), the pristine copy is never overwritten (later copies are suffixed).
- **Never federate a code-mode bridge into itself.** Denylist: `code-mode`, `code-mode-mcp`, `attio-code-mode`, `attio-code-mode-mcp`.
- **Pins are sacred.** A pinned server (per-host or any-host) is never migrated and never stripped. Pins load from `~/.host-import-pins.json` (`{ "pins": ["name", "host:name", ...] }`) plus any `--pin` flags.
- **Eject is the documented inverse.** A UTCP manual can be moved back into one or more hosts as a standard MCP server (un-wrapping `mcp-remote` back to a `url`/`http` server). Eject writes the host config(s) and removes the manual from the UTCP config — all backed up.
- **No secret redaction.** Migration must carry real `env`/`headers` values into the UTCP config verbatim (unlike acsync, which redacts).
- **Same-named servers across hosts.** Read order is claude-code → claude-desktop → codex; if one name appears in several hosts, the first (claude-code) definition is the one migrated (`selectManuals` dedups by name), and on `--strip-host` *every* host entry with that name is removed. Divergent definitions are all listed in the dry-run plan — review before applying.
- **Strip is migration-scoped.** `--strip-host` removes only servers added to the UTCP config *this run* (`applied.added`). A server already present in the UTCP config (shown as `dup`) is intentionally left in the host — strip never deletes a host server that has no live UTCP equivalent, and the code-mode bridge itself (denylisted, never migrated) is therefore never stripped.
- **Disabled servers are skipped.** Codex servers marked `enabled = false` are not migrated (migrating would silently re-activate them under code-mode) and never appear in the plan. Claude Code/Desktop have no equivalent flag.
- **`-mcp` name variants are distinct.** Hosts often register the same logical server under slightly different names (`hookmark` vs `hookmark-mcp`, `the-swarm` vs `the-swarm-mcp`, `linkedin` vs `linkedin-mcp`). Dedup is by exact (raw + sanitized) name only — the tool does **not** fuzzy-merge `-mcp` variants, so they migrate as separate manuals. The dry-run plan lists both; consolidate by pinning/ejecting if undesired.
- **Dry-run first at scale.** Real configs carry dozens of project-scoped servers (30+ project blocks in `~/.claude.json`), so `--strip-host` can touch many entries at once. Default mode is dry-run for exactly this reason — review the plan before `--apply`/`--strip-host`; never pipe straight to apply.
- **Borrow references** (read-only, do not import the 310 KB built file — reimplement the cited approach): `ai-config-sync-manager/bin/ai-config-sync.mjs` — Codex TOML table regex (`:5228`), `parseInlineTomlObject` (`:5422`), normalized shape (`normalizeMcpServerDetails :5270`); `scripts/dashboard.mjs` — `listenWithFallback`/`writeRuntime`/backup/SSE patterns (for the follow-up dashboard plan).

---

### Task 1: Host config readers (`read-hosts.mjs`)

Read the three host config formats into one normalized list of servers. Codex parsing folds nested `[mcp_servers.NAME.env]` / `[mcp_servers.NAME.http_headers]` sub-tables into the parent server and skips any server marked `enabled = false` (both shapes confirmed against the real `~/.codex/config.toml`).

**Files:**
- Create: `scripts/lib/host-import/read-hosts.mjs`
- Test: `tests/host-import-read.test.mjs`

**Interfaces:**
- Produces:
  - `type NormalizedServer = { command?: string, url?: string, args?: string[], env?: Record<string,string>, headers?: Record<string,string>, bearerTokenEnvVar?: string }`
  - `type HostEntry = { host: "claude-code"|"claude-desktop"|"codex", scope: "global"|"project", projectKey?: string, name: string, server: NormalizedServer }`
  - `normalizeServer(raw: object): NormalizedServer | null`
  - `parseInlineTomlObject(body: string): Record<string,string>`
  - `parseStringArray(value: string): string[]`
  - `readClaudeCode(path: string): HostEntry[]`
  - `readClaudeDesktop(path: string): HostEntry[]`
  - `readCodex(path: string): HostEntry[]`
  - `defaultHostPaths(home?: string): { claudeCode: string, claudeDesktop: string, codex: string }`
  - `readAllHosts(paths: { claudeCode, claudeDesktop, codex }): HostEntry[]`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-read.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeServer,
  parseInlineTomlObject,
  parseStringArray,
  readClaudeCode,
  readClaudeDesktop,
  readCodex,
  readAllHosts,
} from "../scripts/lib/host-import/read-hosts.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "hostimport-"));
}

test("normalizeServer keeps command/args/env/url/headers, drops junk", () => {
  assert.deepEqual(
    normalizeServer({ command: "node", args: ["x", 1], env: { A: "1" }, junk: true }),
    { command: "node", args: ["x"], env: { A: "1" } }
  );
  assert.deepEqual(
    normalizeServer({ url: "https://x/mcp", bearer_token_env_var: "TOK" }),
    { url: "https://x/mcp", bearerTokenEnvVar: "TOK" }
  );
  assert.equal(normalizeServer(null), null);
});

test("parseInlineTomlObject + parseStringArray", () => {
  assert.deepEqual(parseInlineTomlObject('{ A = "1", B = "two" }'), { A: "1", B: "two" });
  assert.deepEqual(parseStringArray('["-y", "pkg"]'), ["-y", "pkg"]);
  assert.deepEqual(parseStringArray('["a", 2, "b"]'), ["a", "b"]);
});

test("readClaudeCode reads global + project mcpServers", () => {
  const d = tmp();
  const p = join(d, ".claude.json");
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: { memory: { command: "npx", args: ["-y", "server-memory"] } },
      projects: { "/repo": { mcpServers: { github: { command: "gh-mcp" } } } },
    })
  );
  const out = readClaudeCode(p);
  assert.equal(out.length, 2);
  const memory = out.find((e) => e.name === "memory");
  assert.deepEqual(memory, {
    host: "claude-code",
    scope: "global",
    name: "memory",
    server: { command: "npx", args: ["-y", "server-memory"] },
  });
  const github = out.find((e) => e.name === "github");
  assert.equal(github.scope, "project");
  assert.equal(github.projectKey, "/repo");
});

test("readClaudeDesktop reads mcpServers", () => {
  const d = tmp();
  const p = join(d, "claude_desktop_config.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { hookmark: { command: "node", args: ["i.js"] } } }));
  const out = readClaudeDesktop(p);
  assert.deepEqual(out, [
    { host: "claude-desktop", scope: "global", name: "hookmark", server: { command: "node", args: ["i.js"] } },
  ]);
});

test("readCodex parses [mcp_servers.X] TOML tables incl. remote", () => {
  const d = tmp();
  const p = join(d, "config.toml");
  writeFileSync(
    p,
    [
      "[mcp_servers.memory]",
      'command = "npx"',
      'args = ["-y","@modelcontextprotocol/server-memory"]',
      'env = { MEMORY_FILE_PATH = "/x/m.jsonl" }',
      "",
      "[mcp_servers.context7]",
      'transport = "streamable_http"',
      'url = "https://mcp.context7.com/mcp"',
      'http_headers = { CONTEXT7_API_KEY = "ctx7sk-abc" }',
      "",
      // A non-mcp table after the last server — its `command` must NOT leak
      // into context7's body.
      "[history]",
      'command = "should-not-leak"',
      "",
      // Nested env sub-table (real Codex node_repl shape) — folds into parent.
      "[mcp_servers.node_repl]",
      'command = "/r/node_repl"',
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      'A = "1"',
      'B = "2"',
      "",
      // Disabled server — must be skipped (migrating would re-activate it).
      "[mcp_servers.disabledsrv]",
      'command = "x"',
      "enabled = false",
      "",
    ].join("\n")
  );
  const out = readCodex(p);
  assert.equal(out.length, 3); // [history] not a server; disabledsrv skipped
  const memory = out.find((e) => e.name === "memory");
  assert.deepEqual(memory.server, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { MEMORY_FILE_PATH: "/x/m.jsonl" },
  });
  const context7 = out.find((e) => e.name === "context7");
  assert.deepEqual(context7.server, {
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "ctx7sk-abc" },
  });
  const nodeRepl = out.find((e) => e.name === "node_repl");
  assert.deepEqual(nodeRepl.server, { command: "/r/node_repl", args: [], env: { A: "1", B: "2" } });
  assert.equal(out.find((e) => e.name === "disabledsrv"), undefined);
});

test("readAllHosts tolerates missing files", () => {
  const out = readAllHosts({ claudeCode: "/nope/a.json", claudeDesktop: "/nope/b.json", codex: "/nope/c.toml" });
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-read.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/host-import/read-hosts.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/host-import/read-hosts.mjs`:

```js
import { existsSync, readFileSync } from "node:fs";

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// Parse `key = "value"` pairs from an inline TOML object body.
// (Approach from ai-config-sync-manager/bin/ai-config-sync.mjs:5422.)
export function parseInlineTomlObject(body) {
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// Parse a TOML/JSON-ish string array `["-y", "pkg"]` → string[].
export function parseStringArray(value) {
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  } catch {
    /* fall through to a tolerant scan */
  }
  return [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

// Normalize a raw MCP server object into the common shape. Keeps real env/header
// values (migration needs them — no secret redaction).
export function normalizeServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const server = {};
  if (typeof raw.command === "string") server.command = raw.command;
  if (typeof raw.url === "string") server.url = raw.url;
  if (Array.isArray(raw.args)) server.args = raw.args.filter((x) => typeof x === "string");
  if (raw.env && typeof raw.env === "object") server.env = { ...raw.env };
  if (typeof raw.bearerTokenEnvVar === "string" && raw.bearerTokenEnvVar) {
    server.bearerTokenEnvVar = raw.bearerTokenEnvVar;
  } else if (typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var) {
    server.bearerTokenEnvVar = raw.bearer_token_env_var;
  }
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = v;
    if (Object.keys(headers).length) server.headers = headers;
  }
  return server;
}

export function readClaudeCode(path) {
  const data = readJson(path);
  const out = [];
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    const server = normalizeServer(raw);
    if (server) out.push({ host: "claude-code", scope: "global", name, server });
  }
  for (const [projectKey, project] of Object.entries(data.projects ?? {})) {
    for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) {
      const server = normalizeServer(raw);
      if (server) out.push({ host: "claude-code", scope: "project", projectKey, name, server });
    }
  }
  return out;
}

export function readClaudeDesktop(path) {
  const data = readJson(path);
  const out = [];
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    const server = normalizeServer(raw);
    if (server) out.push({ host: "claude-desktop", scope: "global", name, server });
  }
  return out;
}

// Codex TOML: parse [mcp_servers.NAME] tables, folding nested
// [mcp_servers.NAME.env] / [mcp_servers.NAME.http_headers] sub-tables into the
// parent, and skipping servers marked `enabled = false` (migrating a disabled
// server would silently re-activate it under code-mode).
// (Table regex from ai-config-sync-manager/bin/ai-config-sync.mjs:5228.)
export function readCodex(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");

  // Group 1 = top-level server name (no dot/bracket); group 2 = sub-section
  // (".env", ".http_headers", ".tools.foo", …) or ""; group 3 = body, which
  // runs to the next table header of ANY kind (`^\[`) or EOF — so a block never
  // absorbs lines from a following table (e.g. `[history]`). This matches the
  // strip regex in Task 6.
  const tablePattern = /^\[mcp_servers\.([^\].]+)((?:\.[^\]]+)?)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  const servers = new Map(); // name -> { raw, disabled }
  for (const match of text.matchAll(tablePattern)) {
    const name = match[1];
    const sub = match[2];
    const body = match[3];
    let entry = servers.get(name);
    if (!entry) {
      entry = { raw: {}, disabled: false };
      servers.set(name, entry);
    }
    if (sub === "") {
      const command = body.match(/^command\s*=\s*"([^"]*)"/m);
      const url = body.match(/^url\s*=\s*"([^"]*)"/m);
      const args = body.match(/^args\s*=\s*(\[.*\])/m);
      const env = body.match(/^env\s*=\s*(\{.*\})/m);
      const headers = body.match(/^http_headers\s*=\s*(\{.*\})/m);
      const bearer = body.match(/^bearer_token_env_var\s*=\s*"([^"]*)"/m);
      const enabled = body.match(/^enabled\s*=\s*(true|false)\b/m);
      if (command) entry.raw.command = command[1];
      if (url) entry.raw.url = url[1];
      if (args) entry.raw.args = parseStringArray(args[1]);
      if (env) entry.raw.env = { ...parseInlineTomlObject(env[1]), ...(entry.raw.env ?? {}) };
      if (headers) entry.raw.headers = { ...parseInlineTomlObject(headers[1]), ...(entry.raw.headers ?? {}) };
      if (bearer) entry.raw.bearer_token_env_var = bearer[1];
      if (enabled && enabled[1] === "false") entry.disabled = true;
    } else if (sub === ".env") {
      entry.raw.env = { ...(entry.raw.env ?? {}), ...parseInlineTomlObject(body) };
    } else if (sub === ".http_headers") {
      entry.raw.headers = { ...(entry.raw.headers ?? {}), ...parseInlineTomlObject(body) };
    }
    // Other sub-tables ([mcp_servers.NAME.tools.*], etc.) are ignored.
  }

  const out = [];
  for (const [name, entry] of servers) {
    if (entry.disabled) continue; // disabled in the host → don't re-activate under code-mode
    const server = normalizeServer(entry.raw);
    if (server) out.push({ host: "codex", scope: "global", name, server });
  }
  return out;
}

export function defaultHostPaths(home = process.env.HOME || "") {
  return {
    claudeCode: `${home}/.claude.json`,
    claudeDesktop: `${home}/Library/Application Support/Claude/claude_desktop_config.json`,
    codex: `${home}/.codex/config.toml`,
  };
}

export function readAllHosts(paths) {
  return [
    ...readClaudeCode(paths.claudeCode),
    ...readClaudeDesktop(paths.claudeDesktop),
    ...readCodex(paths.codex),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-read.test.mjs`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/read-hosts.mjs code-mode-mcp/tests/host-import-read.test.mjs
git commit -m "feat(host-import): read Claude/Codex host MCP configs into a normalized list"
```

---

### Task 2: Server → UTCP manual converter (`to-utcp.mjs`)

Convert one normalized server into a UTCP `mcp` manual + a risk tag. stdio → direct; remote(url) → `mcp-remote` wrap.

**Files:**
- Create: `scripts/lib/host-import/to-utcp.mjs`
- Test: `tests/host-import-convert.test.mjs`

**Interfaces:**
- Consumes: `NormalizedServer` (Task 1).
- Produces:
  - `DENYLIST: Set<string>`
  - `type McpServerSpec = { command: string, args: string[], env: Record<string,string>, transport: "stdio" }`
  - `type UtcpManual = { call_template_type: "mcp", config: { mcpServers: Record<string, McpServerSpec> }, name: string }`
  - `type ConvertResult = { ok: boolean, risk: "safe"|"partial"|"manual", reason: string, manual?: UtcpManual }`
  - `convertServer(name: string, server: NormalizedServer): ConvertResult`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-convert.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertServer, DENYLIST } from "../scripts/lib/host-import/to-utcp.mjs";

test("stdio server → safe direct manual", () => {
  const r = convertServer("memory", { command: "npx", args: ["-y", "m"], env: { A: "1" } });
  assert.equal(r.ok, true);
  assert.equal(r.risk, "safe");
  assert.deepEqual(r.manual, {
    call_template_type: "mcp",
    config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: { A: "1" }, transport: "stdio" } } },
    name: "memory",
  });
});

test("remote server without auth → safe mcp-remote wrap", () => {
  const r = convertServer("context7", { url: "https://mcp.context7.com/mcp" });
  assert.equal(r.risk, "safe");
  assert.deepEqual(r.manual.config.mcpServers.context7, {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.context7.com/mcp"],
    env: {},
    transport: "stdio",
  });
});

test("remote server with header + bearer → partial, headers become --header args", () => {
  const r = convertServer("ctx", {
    url: "https://x/mcp",
    headers: { "X-Key": "abc" },
    bearerTokenEnvVar: "TOK",
  });
  assert.equal(r.risk, "partial");
  assert.deepEqual(r.manual.config.mcpServers.ctx.args, [
    "-y",
    "mcp-remote",
    "https://x/mcp",
    "--header",
    "X-Key: abc",
    "--header",
    "Authorization: Bearer ${TOK}",
  ]);
});

test("denylisted bridge → manual, no manual emitted", () => {
  assert.ok(DENYLIST.has("code-mode"));
  const r = convertServer("code-mode", { command: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.risk, "manual");
  assert.equal(r.manual, undefined);
});

test("server with neither command nor url → manual", () => {
  const r = convertServer("weird", { env: { A: "1" } });
  assert.equal(r.ok, false);
  assert.equal(r.risk, "manual");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-convert.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/host-import/to-utcp.mjs`:

```js
// Bridges that must never be federated into code-mode (would route to itself).
export const DENYLIST = new Set(["code-mode", "code-mode-mcp", "attio-code-mode", "attio-code-mode-mcp"]);

function wrap(name, spec) {
  return { call_template_type: "mcp", config: { mcpServers: { [name]: spec } }, name };
}

function headerArgs(server) {
  const headers = { ...(server.headers ?? {}) };
  if (server.bearerTokenEnvVar) headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
  const args = [];
  for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
  return args;
}

// Convert one normalized host server into a UTCP `mcp` manual + risk tag.
// stdio (command) → 1:1 manual. remote (url) → `npx -y mcp-remote <url> --header …`
// (same pattern as the existing zoominfo/databar manuals).
export function convertServer(name, server) {
  if (DENYLIST.has(name)) {
    return { ok: false, risk: "manual", reason: "code-mode bridge — must not be federated into itself" };
  }
  if (server.command && !server.url) {
    const spec = { command: server.command, args: server.args ?? [], env: server.env ?? {}, transport: "stdio" };
    return { ok: true, risk: "safe", reason: "stdio server — direct UTCP manual", manual: wrap(name, spec) };
  }
  if (server.url) {
    const extra = headerArgs(server);
    const spec = {
      command: "npx",
      args: ["-y", "mcp-remote", server.url, ...extra],
      env: {},
      transport: "stdio",
    };
    const needsAuth = extra.length > 0;
    return {
      ok: true,
      risk: needsAuth ? "partial" : "safe",
      reason: needsAuth
        ? "remote server wrapped via mcp-remote — verify auth headers/env carry over"
        : "remote server wrapped via mcp-remote",
      manual: wrap(name, spec),
    };
  }
  return { ok: false, risk: "manual", reason: "server has neither command nor url — cannot convert" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-convert.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/to-utcp.mjs code-mode-mcp/tests/host-import-convert.test.mjs
git commit -m "feat(host-import): convert host MCP servers to UTCP manuals (mcp-remote wrap + risk tags)"
```

---

### Task 3: Plan builder + dedup (`plan.mjs`)

Combine read + convert + dedup against the existing UTCP config into a reviewable plan.

**Files:**
- Create: `scripts/lib/host-import/plan.mjs`
- Test: `tests/host-import-plan.test.mjs`

**Interfaces:**
- Consumes: `HostEntry` (Task 1), `convertServer`/`ConvertResult` (Task 2).
- Produces:
  - `toManualIdentifier(name: string): string` (mirror of `scripts/lib/utcp-config.mjs`)
  - `existingManualNames(utcpConfig: object): Set<string>`
  - `type PlanItem = { host, scope, projectKey?, name, risk: "safe"|"partial"|"manual", reason, duplicate: boolean, manual?: UtcpManual, source: HostEntry }`
  - `buildPlan(hosts: HostEntry[], utcpConfig: object): { items: PlanItem[], existingNames: string[] }`
  - `selectManuals(plan, { risks?: string[] }): UtcpManual[]` — non-duplicate, ok items whose risk ∈ `risks` (default `["safe","partial"]`)
  - `readUtcpConfig(path: string): object`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-plan.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, existingManualNames, selectManuals, toManualIdentifier } from "../scripts/lib/host-import/plan.mjs";

const hosts = [
  { host: "codex", scope: "global", name: "memory", server: { command: "npx", args: ["-y", "m"] } },
  { host: "claude-code", scope: "global", name: "context7", server: { url: "https://x/mcp", headers: { K: "v" } } },
  { host: "claude-desktop", scope: "global", name: "code-mode", server: { command: "x" } },
  { host: "codex", scope: "global", name: "salesforce-mcp", server: { command: "sf" } }, // dup
];
const utcp = { manual_call_templates: [{ name: "salesforce-mcp" }] };

test("existingManualNames includes raw + sanitized", () => {
  const set = existingManualNames(utcp);
  assert.ok(set.has("salesforce-mcp"));
  assert.ok(set.has("salesforce_mcp"));
  assert.equal(toManualIdentifier("salesforce-mcp"), "salesforce_mcp");
});

test("buildPlan tags risk, duplicate, and emits manuals", () => {
  const { items } = buildPlan(hosts, utcp);
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.memory.risk, "safe");
  assert.equal(by.memory.duplicate, false);
  assert.equal(by.context7.risk, "partial");
  assert.equal(by["code-mode"].risk, "manual");
  assert.equal(by["code-mode"].manual, undefined);
  assert.equal(by["salesforce-mcp"].duplicate, true);
});

test("selectManuals defaults to non-duplicate safe+partial", () => {
  const plan = buildPlan(hosts, utcp);
  const names = selectManuals(plan).map((m) => m.name).sort();
  assert.deepEqual(names, ["context7", "memory"]);
});

test("selectManuals can narrow to safe only", () => {
  const plan = buildPlan(hosts, utcp);
  const names = selectManuals(plan, { risks: ["safe"] }).map((m) => m.name);
  assert.deepEqual(names, ["memory"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-plan.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/host-import/plan.mjs`:

```js
import { existsSync, readFileSync } from "node:fs";
import { convertServer } from "./to-utcp.mjs";

// Mirror of scripts/lib/utcp-config.mjs toManualIdentifier — the UTCP SDK files
// tools under this sanitized form, so dedup must compare both spellings.
export function toManualIdentifier(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}

export function existingManualNames(utcpConfig) {
  const templates = Array.isArray(utcpConfig?.manual_call_templates) ? utcpConfig.manual_call_templates : [];
  const set = new Set();
  for (const t of templates) {
    if (typeof t?.name === "string") {
      set.add(t.name);
      set.add(toManualIdentifier(t.name));
    }
  }
  return set;
}

export function buildPlan(hosts, utcpConfig) {
  const existing = existingManualNames(utcpConfig);
  const items = hosts.map((entry) => {
    const conv = convertServer(entry.name, entry.server);
    const duplicate = existing.has(entry.name) || existing.has(toManualIdentifier(entry.name));
    return {
      host: entry.host,
      scope: entry.scope,
      projectKey: entry.projectKey,
      name: entry.name,
      risk: conv.risk,
      reason: duplicate ? "already present in the UTCP config" : conv.reason,
      duplicate,
      manual: conv.ok ? conv.manual : undefined,
      source: entry,
    };
  });
  return { items, existingNames: [...existing] };
}

export function selectManuals(plan, { risks = ["safe", "partial"] } = {}) {
  const allow = new Set(risks);
  const seen = new Set();
  const out = [];
  for (const item of plan.items) {
    if (item.duplicate || !item.manual || !allow.has(item.risk)) continue;
    if (seen.has(item.name)) continue; // same server in multiple hosts → emit once
    seen.add(item.name);
    out.push(item.manual);
  }
  return out;
}

export function readUtcpConfig(path) {
  if (!existsSync(path)) return { manual_call_templates: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { manual_call_templates: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-plan.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/plan.mjs code-mode-mcp/tests/host-import-plan.test.mjs
git commit -m "feat(host-import): build dedup-aware migration plan with risk tags"
```

---

### Task 4: Backup + FIFO retention (`backup.mjs`)

Make every host/UTCP write reversible.

**Files:**
- Create: `scripts/lib/host-import/backup.mjs`
- Test: `tests/host-import-backup.test.mjs`

**Interfaces:**
- Produces:
  - `backupFile(file: string, backupRoot: string, stamp?: string): string | null` — copies `file` to `backupRoot/<stamp>/<basename>` (suffixed `<basename>.<n>` if that name already exists in the stamp dir, so a re-backup never clobbers the pristine copy); `stamp` injectable for tests.
  - `pruneBackups(backupRoot: string, keep?: number): void` — FIFO-prune to newest `keep` (default 30).
  - `listBackups(backupRoot: string): Array<{ id: string, path: string }>` — newest first.

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-backup.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile, pruneBackups, listBackups } from "../scripts/lib/host-import/backup.mjs";

test("backupFile copies into stamped dir, returns path", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "config.json");
  writeFileSync(f, '{"a":1}');
  const root = join(d, ".backups");
  const dest = backupFile(f, root, "2026-06-25T00-00-00");
  assert.equal(dest, join(root, "2026-06-25T00-00-00", "config.json"));
  assert.equal(readFileSync(dest, "utf8"), '{"a":1}');
});

test("backupFile returns null for missing file", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  assert.equal(backupFile(join(d, "nope.json"), join(d, ".b")), null);
});

test("pruneBackups keeps newest N", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "c.json");
  writeFileSync(f, "x");
  const root = join(d, ".backups");
  for (const s of ["2026-01-01", "2026-01-02", "2026-01-03"]) backupFile(f, root, s);
  pruneBackups(root, 2);
  const dirs = readdirSync(root).sort();
  assert.deepEqual(dirs, ["2026-01-02", "2026-01-03"]);
  assert.equal(existsSync(join(root, "2026-01-01")), false);
});

test("listBackups returns newest first", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "c.json");
  writeFileSync(f, "x");
  const root = join(d, ".backups");
  for (const s of ["2026-01-01", "2026-01-02"]) backupFile(f, root, s);
  assert.deepEqual(listBackups(root).map((b) => b.id), ["2026-01-02", "2026-01-01"]);
});

test("backupFile never clobbers an earlier backup in the same stamp", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "config.json");
  const root = join(d, ".backups");
  writeFileSync(f, "v1");
  const first = backupFile(f, root, "SAME");
  writeFileSync(f, "v2");
  const second = backupFile(f, root, "SAME");
  assert.notEqual(first, second);
  assert.equal(readFileSync(first, "utf8"), "v1"); // pristine copy retained
  assert.equal(readFileSync(second, "utf8"), "v2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-backup.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/host-import/backup.mjs`:

```js
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";

// Copy `file` into `backupRoot/<stamp>/<basename>`. stamp is injectable so tests
// stay deterministic; in production it defaults to a filesystem-safe ISO time.
export function backupFile(file, backupRoot, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  if (!existsSync(file)) return null;
  const dir = join(backupRoot, stamp);
  mkdirSync(dir, { recursive: true });
  const base = basename(file);
  let dest = join(dir, base);
  // One run can back up the same file more than once within a single stamp
  // window (e.g. global + project strips of ~/.claude.json land in the same
  // millisecond). Never clobber an earlier backup — suffix so the pristine
  // copy is always retained.
  if (existsSync(dest)) {
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    let n = 1;
    do {
      dest = join(dir, `${stem}.${n}${ext}`);
      n += 1;
    } while (existsSync(dest));
  }
  copyFileSync(file, dest);
  return dest;
}

export function pruneBackups(backupRoot, keep = 30) {
  if (!existsSync(backupRoot)) return;
  const dirs = readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    rmSync(join(backupRoot, name), { recursive: true, force: true });
  }
}

export function listBackups(backupRoot) {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, path: join(backupRoot, d.name) }))
    .sort((a, b) => b.id.localeCompare(a.id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-backup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/backup.mjs code-mode-mcp/tests/host-import-backup.test.mjs
git commit -m "feat(host-import): backup-on-write with FIFO retention"
```

---

### Task 5: Apply — write manuals into the UTCP config (`apply.mjs`, part 1)

**Files:**
- Create: `scripts/lib/host-import/apply.mjs`
- Test: `tests/host-import-apply-utcp.test.mjs`

**Interfaces:**
- Consumes: `UtcpManual` (Task 2), `backupFile`/`pruneBackups` (Task 4).
- Produces:
  - `addManualsToUtcp(utcpPath: string, manuals: UtcpManual[], backupRoot: string, opts?: { stamp?: string }): { added: string[], skipped: string[], backup: string | null }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-apply-utcp.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addManualsToUtcp } from "../scripts/lib/host-import/apply.mjs";

function manual(name) {
  return { call_template_type: "mcp", config: { mcpServers: { [name]: { command: "x", args: [], env: {}, transport: "stdio" } } }, name };
}

test("addManualsToUtcp appends new, skips existing, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "apply-"));
  const p = join(d, "hide.utcp_config.json");
  writeFileSync(p, JSON.stringify({ manual_call_templates: [{ name: "memory" }] }, null, 2));
  const root = join(d, ".bk");
  const res = addManualsToUtcp(p, [manual("memory"), manual("github")], root, { stamp: "S" });
  assert.deepEqual(res.added, ["github"]);
  assert.deepEqual(res.skipped, ["memory"]);
  assert.equal(res.backup, join(root, "S", "hide.utcp_config.json"));
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(out.manual_call_templates.map((t) => t.name), ["memory", "github"]);
});

test("addManualsToUtcp creates manual_call_templates if absent", () => {
  const d = mkdtempSync(join(tmpdir(), "apply-"));
  const p = join(d, "c.json");
  writeFileSync(p, JSON.stringify({ load_variables_from: [] }));
  const res = addManualsToUtcp(p, [manual("a")], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.added, ["a"]);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(out.manual_call_templates.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-apply-utcp.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/host-import/apply.mjs`:

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

// Append manuals to the UTCP config (deduped by name), backing up first.
export function addManualsToUtcp(utcpPath, manuals, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  if (!Array.isArray(config.manual_call_templates)) config.manual_call_templates = [];
  const have = new Set(config.manual_call_templates.map((t) => t?.name));
  const added = [];
  const skipped = [];
  for (const m of manuals) {
    if (have.has(m.name)) {
      skipped.push(m.name);
      continue;
    }
    config.manual_call_templates.push(m);
    have.add(m.name);
    added.push(m.name);
  }
  const backup = backupFile(utcpPath, backupRoot, ...stampArgs(opts));
  writeFileSync(utcpPath, JSON.stringify(config, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { added, skipped, backup };
}
```

(Note: `existsSync` import is consumed by Task 6's additions to this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-apply-utcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/apply.mjs code-mode-mcp/tests/host-import-apply-utcp.test.mjs
git commit -m "feat(host-import): write deduped manuals into the UTCP config with backup"
```

---

### Task 6: Apply — strip servers from host configs (`apply.mjs`, part 2)

Opt-in, destructive, backed-up. Claude JSON (global + project) and Codex TOML.

**Files:**
- Modify: `scripts/lib/host-import/apply.mjs` (add two exports)
- Test: `tests/host-import-strip.test.mjs`

**Interfaces:**
- Consumes: `backupFile`/`pruneBackups` (Task 4).
- Produces:
  - `stripFromClaudeJson(path, names: string[], backupRoot, opts?: { scope?: "global"|"project", projectKey?: string, stamp?: string }): { removed: string[], backup: string | null }`
  - `stripFromCodexToml(path, names: string[], backupRoot, opts?: { stamp?: string }): { removed: string[], backup: string | null }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-strip.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripFromClaudeJson, stripFromCodexToml } from "../scripts/lib/host-import/apply.mjs";

test("stripFromClaudeJson removes global servers, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }));
  const res = stripFromClaudeJson(p, ["a"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, ["a"]);
  assert.ok(res.backup);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(Object.keys(out.mcpServers), ["b"]);
});

test("stripFromClaudeJson removes project-scoped servers", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ projects: { "/repo": { mcpServers: { gh: { command: "x" } } } } }));
  const res = stripFromClaudeJson(p, ["gh"], join(d, ".bk"), { scope: "project", projectKey: "/repo", stamp: "S" });
  assert.deepEqual(res.removed, ["gh"]);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(out.projects["/repo"].mcpServers, {});
});

test("stripFromCodexToml removes a [mcp_servers.X] table and nested tool tables", () => {
  const d = mkdtempSync(join(tmpdir(), "strip-"));
  const p = join(d, "config.toml");
  writeFileSync(
    p,
    [
      "[other]",
      'k = "v"',
      "",
      "[mcp_servers.memory]",
      'command = "npx"',
      "",
      "[mcp_servers.context7]",
      'url = "https://x/mcp"',
      "",
      "[mcp_servers.context7.tools.foo]",
      'approval_mode = "never"',
      "",
    ].join("\n")
  );
  const res = stripFromCodexToml(p, ["context7"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, ["context7"]);
  const text = readFileSync(p, "utf8");
  assert.ok(text.includes("[mcp_servers.memory]"));
  assert.ok(!text.includes("[mcp_servers.context7]"));
  assert.ok(!text.includes("mcp_servers.context7.tools.foo"));
  assert.ok(text.includes("[other]"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-strip.test.mjs`
Expected: FAIL — `stripFromClaudeJson` / `stripFromCodexToml` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/lib/host-import/apply.mjs`:

```js
// --- Host-config stripping (opt-in, destructive, backed-up) -------------------

export function stripFromClaudeJson(path, names, backupRoot, opts = {}) {
  if (!existsSync(path)) return { removed: [], backup: null };
  const data = JSON.parse(readFileSync(path, "utf8"));
  const removed = [];
  const bag =
    opts.scope === "project" && opts.projectKey
      ? data.projects?.[opts.projectKey]?.mcpServers
      : data.mcpServers;
  if (bag) {
    for (const n of names) {
      if (n in bag) {
        delete bag[n];
        removed.push(n);
      }
    }
  }
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { removed, backup };
}

// Remove [mcp_servers.NAME] tables (and nested [mcp_servers.NAME.*] tables) from
// a Codex config.toml. A table block runs from its header line to the next line
// that starts a new `[` table, or end-of-file.
export function stripFromCodexToml(path, names, backupRoot, opts = {}) {
  if (!existsSync(path)) return { removed: [], backup: null };
  let text = readFileSync(path, "utf8");
  const removed = [];
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(`^\\[mcp_servers\\.${esc}(?:\\.[^\\]]*)?\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "gm");
    if (block.test(text)) removed.push(name);
    text = text.replace(block, "");
  }
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, text);
  pruneBackups(backupRoot);
  return { removed: [...new Set(removed)], backup };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-strip.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/apply.mjs code-mode-mcp/tests/host-import-strip.test.mjs
git commit -m "feat(host-import): strip migrated servers from Claude/Codex host configs (backed up)"
```

---

### Task 7: CLI entry (`host-import-cli.mjs`)

Wire read → plan → render/apply with flags. Default = dry-run table; `--apply` writes UTCP; `--strip-host` (requires `--apply`) removes from hosts.

**Files:**
- Create: `scripts/host-import-cli.mjs`
- Modify: `package.json` (add `host-import` script)
- Test: `tests/host-import-cli.test.mjs`

**Interfaces:**
- Consumes: all Task 1–6 exports.
- Produces (exported for testing; the file also self-runs when executed directly):
  - `parseArgs(argv: string[]): { apply: boolean, stripHost: boolean, risks: string[], only: string[]|null, paths: object, utcpPath: string, backupRoot: string }`
  - `renderPlanText(plan): string`
  - `run(opts): { plan, applied?: { added, skipped, backup }, stripped?: Array<{host,name,removed}> }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, renderPlanText, run } from "../scripts/host-import-cli.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "cli-"));
  const claudeCode = join(d, ".claude.json");
  const claudeDesktop = join(d, "desktop.json");
  const codex = join(d, "config.toml");
  const utcpPath = join(d, "hide.utcp_config.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", "m"] } } }));
  writeFileSync(claudeDesktop, JSON.stringify({ mcpServers: {} }));
  writeFileSync(codex, '[mcp_servers.context7]\nurl = "https://x/mcp"\n');
  writeFileSync(utcpPath, JSON.stringify({ manual_call_templates: [] }, null, 2));
  return { d, claudeCode, claudeDesktop, codex, utcpPath, backupRoot: join(d, ".bk") };
}

test("parseArgs defaults to dry-run", () => {
  const a = parseArgs([]);
  assert.equal(a.apply, false);
  assert.equal(a.stripHost, false);
  assert.deepEqual(a.risks, ["safe", "partial"]);
});

test("parseArgs reads flags", () => {
  const a = parseArgs(["--apply", "--strip-host", "--risk", "safe", "--only", "memory,github"]);
  assert.equal(a.apply, true);
  assert.equal(a.stripHost, true);
  assert.deepEqual(a.risks, ["safe"]);
  assert.deepEqual(a.only, ["memory", "github"]);
});

test("run dry-run produces a plan and writes nothing", () => {
  const fx = fixture();
  const opts = { ...parseArgs([]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  const res = run(opts);
  assert.equal(res.applied, undefined);
  assert.equal(res.plan.items.length, 2);
  const text = renderPlanText(res.plan);
  assert.match(text, /memory/);
  assert.match(text, /context7/);
  // UTCP config untouched
  assert.deepEqual(JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates, []);
});

test("run --apply writes manuals into the UTCP config", () => {
  const fx = fixture();
  const opts = { ...parseArgs(["--apply"]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  const res = run(opts);
  assert.deepEqual(res.applied.added.sort(), ["context7", "memory"]);
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name).sort();
  assert.deepEqual(names, ["context7", "memory"]);
});

test("run --apply --strip-host removes from host configs", () => {
  const fx = fixture();
  const opts = { ...parseArgs(["--apply", "--strip-host"]), paths: { claudeCode: fx.claudeCode, claudeDesktop: fx.claudeDesktop, codex: fx.codex }, utcpPath: fx.utcpPath, backupRoot: fx.backupRoot };
  run(opts);
  assert.deepEqual(JSON.parse(readFileSync(fx.claudeCode, "utf8")).mcpServers, {});
  assert.ok(!readFileSync(fx.codex, "utf8").includes("[mcp_servers.context7]"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-cli.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/host-import-cli.mjs`:

```js
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readAllHosts, defaultHostPaths } from "./lib/host-import/read-hosts.mjs";
import { buildPlan, selectManuals, readUtcpConfig, toManualIdentifier } from "./lib/host-import/plan.mjs";
import { addManualsToUtcp, stripFromClaudeJson, stripFromCodexToml } from "./lib/host-import/apply.mjs";
import { resolveConfigPath } from "./lib/utcp-config.mjs";

export function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const risk = val("--risk");
  const only = val("--only");
  const home = process.env.HOME || "";
  return {
    apply: has("--apply"),
    stripHost: has("--strip-host"),
    risks: risk ? risk.split(",").map((s) => s.trim()).filter(Boolean) : ["safe", "partial"],
    only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    paths: defaultHostPaths(home),
    utcpPath: resolveConfigPath(),
    backupRoot: path.join(home, ".host-import-backups"),
  };
}

export function renderPlanText(plan) {
  const lines = [];
  for (const it of plan.items) {
    const tag = it.duplicate ? "dup " : it.risk.padEnd(4);
    lines.push(`  [${tag}] ${it.host.padEnd(13)} ${it.name.padEnd(28)} ${it.reason}`);
  }
  const sel = selectManuals(plan).length;
  lines.push(`\n  ${plan.items.length} server(s) discovered · ${sel} migratable (non-duplicate safe/partial)`);
  return lines.join("\n");
}

export function run(opts) {
  let hosts = readAllHosts(opts.paths);
  if (opts.only) {
    const want = new Set(opts.only);
    hosts = hosts.filter((h) => want.has(h.name));
  }
  const utcp = readUtcpConfig(opts.utcpPath);
  const plan = buildPlan(hosts, utcp);
  if (!opts.apply) return { plan };

  const manuals = selectManuals(plan, { risks: opts.risks });
  const applied = addManualsToUtcp(opts.utcpPath, manuals, opts.backupRoot);

  const result = { plan, applied };
  if (opts.stripHost) {
    const migrated = new Set(applied.added);
    const stripped = [];
    // group migrated source entries by host/scope so we strip from the right place
    for (const item of plan.items) {
      if (!migrated.has(item.name)) continue;
      if (item.host === "codex") {
        const r = stripFromCodexToml(opts.paths.codex, [item.name], opts.backupRoot);
        stripped.push({ host: "codex", name: item.name, removed: r.removed });
      } else if (item.host === "claude-desktop") {
        const r = stripFromClaudeJson(opts.paths.claudeDesktop, [item.name], opts.backupRoot, { scope: "global" });
        stripped.push({ host: "claude-desktop", name: item.name, removed: r.removed });
      } else {
        const r = stripFromClaudeJson(opts.paths.claudeCode, [item.name], opts.backupRoot, { scope: item.scope, projectKey: item.projectKey });
        stripped.push({ host: "claude-code", name: item.name, removed: r.removed });
      }
    }
    result.stripped = stripped;
  }
  return result;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.stripHost && !opts.apply) {
    console.error("Refusing to --strip-host without --apply (nothing migrated yet).");
    process.exit(1);
  }
  if (opts.apply && !existsSync(opts.utcpPath)) {
    console.error(`Refusing to --apply: UTCP config not found at ${opts.utcpPath}`);
    process.exit(1);
  }
  const res = run(opts);
  console.log(renderPlanText(res.plan));
  if (res.applied) {
    console.log(`\nApplied: +${res.applied.added.length} manual(s) → ${opts.utcpPath}`);
    if (res.applied.backup) console.log(`Backup: ${res.applied.backup}`);
  }
  if (res.stripped) {
    const n = res.stripped.reduce((a, s) => a + s.removed.length, 0);
    console.log(`Stripped ${n} server(s) from host configs (backed up).`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main();
}
```

(`resolveConfigPath` is the existing export in `scripts/lib/utcp-config.mjs:51` — it resolves `UTCP_CONFIG_PATH`/`UTCP_CONFIG_FILE` from env/.env. The CLI tests pass `utcpPath` explicitly via `opts`, so they never call it.)

- [ ] **Step 4: Add the npm script**

In `package.json` "scripts", add after `config-builder:no-open`:

```json
    "host-import": "tsx scripts/host-import-cli.mjs"
```

(`tsx` is already a devDependency and is needed because `host-import-cli.mjs` imports `scripts/lib/utcp-config.mjs`, which pulls in `@utcp/*` ESM. Running under `tsx`/Node both work; the npm script uses `tsx` for parity with `config-builder`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-cli.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `cd code-mode-mcp && npm test`
Expected: PASS — prior 40 tests + the new host-import tests, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add code-mode-mcp/scripts/host-import-cli.mjs code-mode-mcp/package.json code-mode-mcp/tests/host-import-cli.test.mjs
git commit -m "feat(host-import): CLI — dry-run plan, --apply to UTCP, --strip-host (backed up)"
```

---

### Task 8: Pin / whitelist protected servers (`pins.mjs`)

A pinned server is never migrated and never stripped. Pins come from a JSON file + `--pin` flags.

**Files:**
- Create: `scripts/lib/host-import/pins.mjs`
- Modify: `scripts/lib/host-import/plan.mjs` (thread `pins` into `buildPlan`, skip pinned in `selectManuals`)
- Test: `tests/host-import-pins.test.mjs`

**Interfaces:**
- Consumes: `HostEntry` (Task 1), `PlanItem` (Task 3).
- Produces:
  - `type Pin = { host: "*"|"claude-code"|"claude-desktop"|"codex", name: string }`
  - `parsePin(str: string): Pin` — `"name"` → any host; `"host:name"` → scoped
  - `loadPins(path: string|null, extra?: string[]): Pin[]`
  - `isPinned(pins: Pin[], entry: { host, name }): boolean`
  - Modified `buildPlan(hosts, utcpConfig, pins?: Pin[])` — each `PlanItem` gains `pinned: boolean`
  - Modified `selectManuals(plan, opts?)` — excludes `pinned` items

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-pins.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePin, loadPins, isPinned } from "../scripts/lib/host-import/pins.mjs";
import { buildPlan, selectManuals } from "../scripts/lib/host-import/plan.mjs";

test("parsePin handles plain and host-scoped forms", () => {
  assert.deepEqual(parsePin("memory"), { host: "*", name: "memory" });
  assert.deepEqual(parsePin("codex:context7"), { host: "codex", name: "context7" });
});

test("loadPins merges extra flags with no file", () => {
  const pins = loadPins(null, ["a", "claude-code:b"]);
  assert.deepEqual(pins, [{ host: "*", name: "a" }, { host: "claude-code", name: "b" }]);
});

test("isPinned matches any-host and scoped", () => {
  const pins = [{ host: "*", name: "a" }, { host: "codex", name: "b" }];
  assert.equal(isPinned(pins, { host: "codex", name: "a" }), true);
  assert.equal(isPinned(pins, { host: "codex", name: "b" }), true);
  assert.equal(isPinned(pins, { host: "claude-code", name: "b" }), false);
});

test("buildPlan marks pinned and selectManuals skips them", () => {
  const hosts = [
    { host: "codex", scope: "global", name: "memory", server: { command: "x" } },
    { host: "claude-code", scope: "global", name: "github", server: { command: "y" } },
  ];
  const plan = buildPlan(hosts, { manual_call_templates: [] }, [{ host: "*", name: "github" }]);
  const by = Object.fromEntries(plan.items.map((i) => [i.name, i]));
  assert.equal(by.github.pinned, true);
  assert.equal(by.memory.pinned, false);
  assert.deepEqual(selectManuals(plan).map((m) => m.name), ["memory"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-pins.test.mjs`
Expected: FAIL — `pins.mjs` not found.

- [ ] **Step 3: Create `scripts/lib/host-import/pins.mjs`**

```js
import { existsSync, readFileSync } from "node:fs";

// Pin string forms: "name" (any host) | "host:name" (specific host).
export function parsePin(str) {
  const s = String(str);
  const i = s.indexOf(":");
  if (i === -1) return { host: "*", name: s.trim() };
  return { host: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
}

export function loadPins(path, extra = []) {
  const pins = [];
  if (path && existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      for (const p of data.pins ?? []) {
        if (typeof p === "string") pins.push(parsePin(p));
        else if (p && typeof p.name === "string") pins.push({ host: p.host || "*", name: p.name });
      }
    } catch {
      /* malformed pins file → no pins */
    }
  }
  for (const s of extra) pins.push(parsePin(s));
  return pins;
}

export function isPinned(pins, entry) {
  return pins.some((p) => p.name === entry.name && (p.host === "*" || p.host === entry.host));
}
```

- [ ] **Step 4: Thread pins through `plan.mjs`**

In `scripts/lib/host-import/plan.mjs`, add the import at the top (after the existing imports):

```js
import { isPinned } from "./pins.mjs";
```

Replace `buildPlan` with:

```js
export function buildPlan(hosts, utcpConfig, pins = []) {
  const existing = existingManualNames(utcpConfig);
  const items = hosts.map((entry) => {
    const conv = convertServer(entry.name, entry.server);
    const duplicate = existing.has(entry.name) || existing.has(toManualIdentifier(entry.name));
    const pinned = isPinned(pins, entry);
    return {
      host: entry.host,
      scope: entry.scope,
      projectKey: entry.projectKey,
      name: entry.name,
      risk: conv.risk,
      reason: pinned ? "pinned — never touched" : duplicate ? "already present in the UTCP config" : conv.reason,
      duplicate,
      pinned,
      manual: conv.ok ? conv.manual : undefined,
      source: entry,
    };
  });
  return { items, existingNames: [...existing] };
}
```

Replace the `selectManuals` filter line `if (item.duplicate || !item.manual || !allow.has(item.risk)) continue;` with:

```js
    if (item.duplicate || item.pinned || !item.manual || !allow.has(item.risk)) continue;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd code-mode-mcp && node --test tests/host-import-pins.test.mjs tests/host-import-plan.test.mjs`
Expected: PASS — pins tests + the existing plan tests (still pass; `pins` defaults to `[]`).

- [ ] **Step 6: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/pins.mjs code-mode-mcp/scripts/lib/host-import/plan.mjs code-mode-mcp/tests/host-import-pins.test.mjs
git commit -m "feat(host-import): pin/whitelist servers so they're never migrated or stripped"
```

---

### Task 9: Reverse converter — UTCP manual → host server (`from-utcp.mjs`)

The inverse of Task 2: take a UTCP `mcp` manual and recover a normalized host server, un-wrapping `mcp-remote` back to a `url` server.

**Files:**
- Create: `scripts/lib/host-import/from-utcp.mjs`
- Test: `tests/host-import-from-utcp.test.mjs`

**Interfaces:**
- Consumes: `UtcpManual` (Task 2), `NormalizedServer` (Task 1).
- Produces: `manualToHostServer(manual: UtcpManual): { name: string, server: NormalizedServer }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-from-utcp.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { manualToHostServer } from "../scripts/lib/host-import/from-utcp.mjs";

test("stdio manual → command/args/env server", () => {
  const m = { name: "memory", config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: { A: "1" }, transport: "stdio" } } } };
  assert.deepEqual(manualToHostServer(m), { name: "memory", server: { command: "npx", args: ["-y", "m"], env: { A: "1" } } });
});

test("npx mcp-remote wrap → url server with headers + bearer", () => {
  const m = {
    name: "ctx",
    config: { mcpServers: { ctx: { command: "npx", args: ["-y", "mcp-remote", "https://x/mcp", "--header", "X-Key: abc", "--header", "Authorization: Bearer ${TOK}"], env: {}, transport: "stdio" } } },
  };
  assert.deepEqual(manualToHostServer(m), { name: "ctx", server: { url: "https://x/mcp", headers: { "X-Key": "abc" }, bearerTokenEnvVar: "TOK" } });
});

test("legacy proxy.js mcp-remote wrap → url server", () => {
  const m = {
    name: "zoominfo-mcp",
    config: { mcpServers: { "zoominfo-mcp": { command: "/n/node", args: ["/n/mcp-remote/dist/proxy.js", "https://mcp.zoominfo.com/mcp", "--header", "User-Agent: Claude-User"], env: {}, transport: "stdio" } } },
  };
  assert.deepEqual(manualToHostServer(m), { name: "zoominfo-mcp", server: { url: "https://mcp.zoominfo.com/mcp", headers: { "User-Agent": "Claude-User" } } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-from-utcp.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/lib/host-import/from-utcp.mjs`**

```js
// Inverse of to-utcp.convertServer: a UTCP `mcp` manual → { name, server }.
// Un-wraps an mcp-remote stdio wrapper back into a remote `url` server.
export function manualToHostServer(manual) {
  const servers = manual?.config?.mcpServers ?? {};
  const name = manual?.name ?? Object.keys(servers)[0];
  const spec = servers[name] ?? Object.values(servers)[0] ?? {};
  const args = Array.isArray(spec.args) ? spec.args : [];

  // Detect the mcp-remote proxy entry: a bare "mcp-remote" arg (npx form) or a
  // path ending in mcp-remote/.../proxy.js (legacy node form). The URL follows.
  const idx = args.findIndex((a) => a === "mcp-remote" || /(^|\/)mcp-remote(\/|$)/.test(String(a)));
  if (idx !== -1 && typeof args[idx + 1] === "string") {
    const server = { url: args[idx + 1] };
    const headers = {};
    let bearerTokenEnvVar;
    for (let i = idx + 2; i < args.length; i++) {
      if (args[i] !== "--header" || typeof args[i + 1] !== "string") continue;
      const raw = args[i + 1];
      const sep = raw.indexOf(":");
      const key = raw.slice(0, sep).trim();
      const value = raw.slice(sep + 1).trim();
      const bearer = value.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (/^authorization$/i.test(key) && bearer) bearerTokenEnvVar = bearer[1];
      else headers[key] = value;
      i++;
    }
    if (Object.keys(headers).length) server.headers = headers;
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar;
    return { name, server };
  }

  const server = {};
  if (typeof spec.command === "string") server.command = spec.command;
  if (Array.isArray(spec.args)) server.args = spec.args.filter((x) => typeof x === "string");
  if (spec.env && typeof spec.env === "object" && Object.keys(spec.env).length) server.env = { ...spec.env };
  return { name, server };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-from-utcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/from-utcp.mjs code-mode-mcp/tests/host-import-from-utcp.test.mjs
git commit -m "feat(host-import): reverse converter — UTCP manual back to a host server (un-wrap mcp-remote)"
```

---

### Task 10: Host writers (`host-write.mjs`)

Write a normalized server into a Claude JSON config and render/insert a Codex TOML table.

**Files:**
- Create: `scripts/lib/host-import/host-write.mjs`
- Test: `tests/host-import-host-write.test.mjs`

**Interfaces:**
- Consumes: `NormalizedServer` (Task 1), `backupFile`/`pruneBackups` (Task 4).
- Produces:
  - `toClaudeServer(server: NormalizedServer): object`
  - `addToClaudeJson(path, name, server, backupRoot, opts?: { scope?, projectKey?, stamp? }): { backup }`
  - `renderCodexMcpTable(name: string, server: NormalizedServer): string`
  - `addToCodexToml(path, name, server, backupRoot, opts?: { stamp? }): { backup }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-host-write.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toClaudeServer, addToClaudeJson, renderCodexMcpTable, addToCodexToml } from "../scripts/lib/host-import/host-write.mjs";

test("toClaudeServer renders stdio + remote shapes", () => {
  assert.deepEqual(toClaudeServer({ command: "npx", args: ["-y"], env: { A: "1" } }), { type: "stdio", command: "npx", args: ["-y"], env: { A: "1" } });
  assert.deepEqual(toClaudeServer({ url: "https://x/mcp", bearerTokenEnvVar: "TOK" }), { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${TOK}" } });
});

test("addToClaudeJson writes global + project, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "hw-"));
  const p = join(d, ".claude.json");
  writeFileSync(p, JSON.stringify({ mcpServers: {} }));
  addToClaudeJson(p, "memory", { command: "npx" }, join(d, ".bk"), { stamp: "S" });
  addToClaudeJson(p, "gh", { command: "x" }, join(d, ".bk"), { scope: "project", projectKey: "/repo", stamp: "S2" });
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(out.mcpServers.memory.command, "npx");
  assert.equal(out.projects["/repo"].mcpServers.gh.command, "x");
});

test("renderCodexMcpTable emits stdio + remote tables", () => {
  assert.equal(
    renderCodexMcpTable("memory", { command: "npx", args: ["-y", "m"], env: { A: "1" } }),
    '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "m"]\nenv = { A = "1" }\n'
  );
  assert.equal(
    renderCodexMcpTable("ctx", { url: "https://x/mcp", headers: { K: "v" } }),
    '[mcp_servers.ctx]\ntransport = "streamable_http"\nurl = "https://x/mcp"\nhttp_headers = { K = "v" }\n'
  );
});

test("addToCodexToml replaces existing table or appends", () => {
  const d = mkdtempSync(join(tmpdir(), "hw-"));
  const p = join(d, "config.toml");
  writeFileSync(p, '[other]\nk = "v"\n');
  addToCodexToml(p, "memory", { command: "npx" }, join(d, ".bk"), { stamp: "S" });
  const text = readFileSync(p, "utf8");
  assert.ok(text.includes("[other]"));
  assert.ok(text.includes("[mcp_servers.memory]"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-host-write.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/lib/host-import/host-write.mjs`**

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

export function toClaudeServer(server) {
  const headers = { ...(server.headers ?? {}) };
  if (server.bearerTokenEnvVar) headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
  const type = server.command ? "stdio" : server.url ? "http" : undefined;
  return {
    ...(type ? { type } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function addToClaudeJson(path, name, server, backupRoot, opts = {}) {
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  let bag;
  if (opts.scope === "project" && opts.projectKey) {
    if (!data.projects) data.projects = {};
    if (!data.projects[opts.projectKey]) data.projects[opts.projectKey] = {};
    if (!data.projects[opts.projectKey].mcpServers) data.projects[opts.projectKey].mcpServers = {};
    bag = data.projects[opts.projectKey].mcpServers;
  } else {
    if (!data.mcpServers) data.mcpServers = {};
    bag = data.mcpServers;
  }
  bag[name] = toClaudeServer(server);
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { backup };
}

function tomlString(v) {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function tomlStringArray(arr) {
  return `[${arr.map(tomlString).join(", ")}]`;
}
function tomlInlineObject(obj) {
  return `{ ${Object.entries(obj).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ")} }`;
}

export function renderCodexMcpTable(name, server) {
  const lines = [`[mcp_servers.${name}]`];
  if (server.command) {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) lines.push(`args = ${tomlStringArray(server.args)}`);
    if (server.env && Object.keys(server.env).length) lines.push(`env = ${tomlInlineObject(server.env)}`);
  } else if (server.url) {
    lines.push(`transport = "streamable_http"`);
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.headers && Object.keys(server.headers).length) lines.push(`http_headers = ${tomlInlineObject(server.headers)}`);
    if (server.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
  }
  return lines.join("\n") + "\n";
}

export function addToCodexToml(path, name, server, backupRoot, opts = {}) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^\\[mcp_servers\\.${esc}(?:\\.[^\\]]*)?\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "gm");
  text = text.replace(block, "");
  if (text.length && !text.endsWith("\n")) text += "\n";
  text += (text.length ? "\n" : "") + renderCodexMcpTable(name, server);
  const backup = backupFile(path, backupRoot, ...stampArgs(opts));
  writeFileSync(path, text);
  pruneBackups(backupRoot);
  return { backup };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-host-write.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/host-write.mjs code-mode-mcp/tests/host-import-host-write.test.mjs
git commit -m "feat(host-import): host writers — add MCP server to Claude JSON + render Codex TOML"
```

---

### Task 11: Eject orchestration (`eject.mjs`)

Move one or more UTCP manuals out into chosen host(s), then remove them from the UTCP config.

**Files:**
- Create: `scripts/lib/host-import/eject.mjs`
- Test: `tests/host-import-eject.test.mjs`

**Interfaces:**
- Consumes: `manualToHostServer` (Task 9), `addToClaudeJson`/`addToCodexToml` (Task 10), `backupFile`/`pruneBackups` (Task 4), `readUtcpConfig` (Task 3).
- Produces:
  - `removeManualsFromUtcp(utcpPath, names: string[], backupRoot, opts?: { stamp? }): { removed: string[], backup }`
  - `ejectManuals(utcpPath, names: string[], targets, hostPaths, backupRoot, opts?): { ejected: Array<{ name, wroteTo: string[] }>, removed: string[] }`
    - `targets`: array of `{ host: "claude-code"|"claude-desktop"|"codex", scope?, projectKey? }`

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-eject.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeManualsFromUtcp, ejectManuals } from "../scripts/lib/host-import/eject.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "eject-"));
  const utcpPath = join(d, "hide.utcp_config.json");
  const claudeCode = join(d, ".claude.json");
  const codex = join(d, "config.toml");
  writeFileSync(
    utcpPath,
    JSON.stringify({
      manual_call_templates: [
        { call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: ["-y", "m"], env: {}, transport: "stdio" } } } },
        { call_template_type: "mcp", name: "keep", config: { mcpServers: { keep: { command: "x", args: [], env: {}, transport: "stdio" } } } },
      ],
    }, null, 2)
  );
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(codex, "");
  return { d, utcpPath, claudeCode, codex, backupRoot: join(d, ".bk") };
}

test("removeManualsFromUtcp drops named templates, backs up", () => {
  const fx = fixture();
  const res = removeManualsFromUtcp(fx.utcpPath, ["memory"], fx.backupRoot, { stamp: "S" });
  assert.deepEqual(res.removed, ["memory"]);
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["keep"]);
});

test("ejectManuals writes server to targets and removes from UTCP", () => {
  const fx = fixture();
  const hostPaths = { claudeCode: fx.claudeCode, claudeDesktop: join(fx.d, "desktop.json"), codex: fx.codex };
  const res = ejectManuals(
    fx.utcpPath,
    ["memory"],
    [{ host: "claude-code", scope: "global" }, { host: "codex" }],
    hostPaths,
    fx.backupRoot,
    { stamp: "S" }
  );
  assert.deepEqual(res.removed, ["memory"]);
  assert.deepEqual(res.ejected[0].wroteTo.sort(), ["claude-code", "codex"]);
  // host configs received the server
  assert.equal(JSON.parse(readFileSync(fx.claudeCode, "utf8")).mcpServers.memory.command, "npx");
  assert.ok(readFileSync(fx.codex, "utf8").includes("[mcp_servers.memory]"));
  // removed from UTCP
  const names = JSON.parse(readFileSync(fx.utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["keep"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-eject.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/lib/host-import/eject.mjs`**

```js
import { readFileSync, writeFileSync } from "node:fs";
import { backupFile, pruneBackups } from "./backup.mjs";
import { manualToHostServer } from "./from-utcp.mjs";
import { addToClaudeJson, addToCodexToml } from "./host-write.mjs";

function stampArgs(opts) {
  return opts.stamp ? [opts.stamp] : [];
}

export function removeManualsFromUtcp(utcpPath, names, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  const drop = new Set(names);
  const before = Array.isArray(config.manual_call_templates) ? config.manual_call_templates : [];
  const removed = before.filter((t) => drop.has(t?.name)).map((t) => t.name);
  config.manual_call_templates = before.filter((t) => !drop.has(t?.name));
  const backup = backupFile(utcpPath, backupRoot, ...stampArgs(opts));
  writeFileSync(utcpPath, JSON.stringify(config, null, 2) + "\n");
  pruneBackups(backupRoot);
  return { removed, backup };
}

// Move manuals out into one or more hosts, then remove them from the UTCP config.
export function ejectManuals(utcpPath, names, targets, hostPaths, backupRoot, opts = {}) {
  const config = JSON.parse(readFileSync(utcpPath, "utf8"));
  const templates = Array.isArray(config.manual_call_templates) ? config.manual_call_templates : [];
  const byName = new Map(templates.map((t) => [t?.name, t]));
  const ejected = [];
  const movable = [];

  for (const name of names) {
    const manual = byName.get(name);
    if (!manual) continue;
    const { server } = manualToHostServer(manual);
    const wroteTo = [];
    for (const target of targets) {
      if (target.host === "codex") {
        addToCodexToml(hostPaths.codex, name, server, backupRoot, opts);
      } else if (target.host === "claude-desktop") {
        addToClaudeJson(hostPaths.claudeDesktop, name, server, backupRoot, { scope: "global", ...opts });
      } else {
        addToClaudeJson(hostPaths.claudeCode, name, server, backupRoot, { scope: target.scope ?? "global", projectKey: target.projectKey, ...opts });
      }
      wroteTo.push(target.host);
    }
    ejected.push({ name, wroteTo });
    movable.push(name);
  }

  const { removed } = removeManualsFromUtcp(utcpPath, movable, backupRoot, opts);
  return { ejected, removed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd code-mode-mcp && node --test tests/host-import-eject.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add code-mode-mcp/scripts/lib/host-import/eject.mjs code-mode-mcp/tests/host-import-eject.test.mjs
git commit -m "feat(host-import): eject UTCP manuals back into host MCP configs"
```

---

### Task 12: CLI — pins + eject mode (`host-import-cli.mjs`)

Wire pins into the import path and add an eject mode.

**Files:**
- Modify: `scripts/host-import-cli.mjs`
- Test: `tests/host-import-cli-eject.test.mjs`

**Interfaces:**
- Consumes: `loadPins` (Task 8), `ejectManuals` (Task 11), existing CLI `parseArgs`/`run` (Task 7).
- Produces (modified):
  - `parseArgs` gains `pinsFile`, `pins`, `eject` (string[]|null), `to` (target host list).
  - `run` honors pins for import; when `opts.eject` is set, runs the eject flow and returns `{ ejected, removed }`.

- [ ] **Step 1: Write the failing test**

Create `tests/host-import-cli-eject.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../scripts/host-import-cli.mjs";

test("parseArgs reads pins + eject flags", () => {
  const a = parseArgs(["--pin", "memory", "--pin", "codex:ctx", "--eject", "salesforce-mcp", "--to", "claude-code,codex"]);
  assert.deepEqual(a.pins, ["memory", "codex:ctx"]);
  assert.deepEqual(a.eject, ["salesforce-mcp"]);
  assert.deepEqual(a.to, ["claude-code", "codex"]);
});

test("run import honors --pin (pinned server not migrated)", () => {
  const d = mkdtempSync(join(tmpdir(), "clip-"));
  const claudeCode = join(d, ".claude.json");
  const utcpPath = join(d, "u.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: { memory: { command: "x" }, github: { command: "y" } } }));
  writeFileSync(utcpPath, JSON.stringify({ manual_call_templates: [] }, null, 2));
  const opts = {
    ...parseArgs(["--apply", "--pin", "github"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex: join(d, "z.toml") },
    utcpPath,
    backupRoot: join(d, ".bk"),
  };
  run(opts);
  const names = JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates.map((t) => t.name);
  assert.deepEqual(names, ["memory"]);
});

test("run eject moves a manual back to a host and out of UTCP", () => {
  const d = mkdtempSync(join(tmpdir(), "clip-"));
  const claudeCode = join(d, ".claude.json");
  const utcpPath = join(d, "u.json");
  writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  writeFileSync(
    utcpPath,
    JSON.stringify({ manual_call_templates: [{ call_template_type: "mcp", name: "memory", config: { mcpServers: { memory: { command: "npx", args: [], env: {}, transport: "stdio" } } } }] }, null, 2)
  );
  const opts = {
    ...parseArgs(["--eject", "memory", "--to", "claude-code"]),
    paths: { claudeCode, claudeDesktop: join(d, "z.json"), codex: join(d, "z.toml") },
    utcpPath,
    backupRoot: join(d, ".bk"),
  };
  const res = run(opts);
  assert.deepEqual(res.removed, ["memory"]);
  assert.equal(JSON.parse(readFileSync(claudeCode, "utf8")).mcpServers.memory.command, "npx");
  assert.deepEqual(JSON.parse(readFileSync(utcpPath, "utf8")).manual_call_templates, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd code-mode-mcp && node --test tests/host-import-cli-eject.test.mjs`
Expected: FAIL — `parseArgs` lacks `pins`/`eject`; `run` has no eject branch.

- [ ] **Step 3: Modify `scripts/host-import-cli.mjs`**

Add imports (after the existing imports):

```js
import { loadPins } from "./lib/host-import/pins.mjs";
import { ejectManuals } from "./lib/host-import/eject.mjs";
```

In `parseArgs`, add the new fields to the returned object (alongside the existing ones):

```js
    pinsFile: val("--pins-file") || `${process.env.HOME || ""}/.host-import-pins.json`,
    pins: argv.reduce((acc, a, i) => (a === "--pin" && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []),
    eject: val("--eject") ? val("--eject").split(",").map((s) => s.trim()).filter(Boolean) : null,
    to: val("--to") ? val("--to").split(",").map((s) => s.trim()).filter(Boolean) : ["claude-code"],
```

In `run`, add the eject branch at the very top of the function body (before reading hosts):

```js
  if (opts.eject && opts.eject.length) {
    const targets = opts.to.map((host) => ({ host, scope: "global" }));
    return ejectManuals(opts.utcpPath, opts.eject, targets, opts.paths, opts.backupRoot);
  }
```

Change the plan build line in `run` from `const plan = buildPlan(hosts, utcp);` to:

```js
  const plan = buildPlan(hosts, utcp, loadPins(opts.pinsFile, opts.pins));
```

In `main`, after computing `res`, add eject reporting before the existing `renderPlanText` call — replace the body of `main` after `const res = run(opts);` with:

```js
  if (res.ejected) {
    for (const e of res.ejected) console.log(`Ejected ${e.name} → ${e.wroteTo.join(", ")}`);
    console.log(`Removed ${res.removed.length} manual(s) from ${opts.utcpPath}`);
    return;
  }
  console.log(renderPlanText(res.plan));
  if (res.applied) {
    console.log(`\nApplied: +${res.applied.added.length} manual(s) → ${opts.utcpPath}`);
    if (res.applied.backup) console.log(`Backup: ${res.applied.backup}`);
  }
  if (res.stripped) {
    const n = res.stripped.reduce((a, s) => a + s.removed.length, 0);
    console.log(`Stripped ${n} server(s) from host configs (backed up).`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd code-mode-mcp && node --test tests/host-import-cli.test.mjs tests/host-import-cli-eject.test.mjs`
Expected: PASS — both the original import CLI tests and the new pins/eject tests.

- [ ] **Step 5: Run the full suite**

Run: `cd code-mode-mcp && npm test`
Expected: PASS — all host-import tests + the prior 40, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add code-mode-mcp/scripts/host-import-cli.mjs code-mode-mcp/tests/host-import-cli-eject.test.mjs
git commit -m "feat(host-import): CLI pins (--pin/--pins-file) + eject mode (--eject/--to)"
```

---

### Task 13: Docs + memory

**Files:**
- Modify: `CLAUDE.md` (root, `/Users/hack/github/code-mode/CLAUDE.md`) — document the new tool
- Create: `code-mode-mcp/docs/host-import.md`

- [ ] **Step 1: Write the usage doc**

Create `code-mode-mcp/docs/host-import.md`:

```markdown
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
```

- [ ] **Step 2: Add a CLAUDE.md pointer**

In `/Users/hack/github/code-mode/CLAUDE.md`, under the MCP Server section, add:

```markdown
### Host → UTCP import (`npm run host-import`)

Migrates traditional MCP servers from Claude Code / Claude Desktop / Codex
host configs into the UTCP config (`scripts/host-import-cli.mjs`). Dry-run by
default; `--apply` writes (backed up), `--strip-host` removes from hosts. See
`code-mode-mcp/docs/host-import.md`.
```

- [ ] **Step 3: Commit**

```bash
git add code-mode-mcp/docs/host-import.md CLAUDE.md
git commit -m "docs(host-import): document the host→UTCP migration CLI"
```

---

## Self-Review

- **Spec coverage:** read host configs (T1) ✓ · convert + mcp-remote wrap + risk (T2) ✓ · dedup vs existing UTCP (T3) ✓ · backup/FIFO (T4) ✓ · write into UTCP (T5) ✓ · opt-in host strip (T6) ✓ · import CLI (T7) ✓ · **pin/whitelist (T8)** ✓ · **reverse converter (T9)** ✓ · **host writers (T10)** ✓ · **eject orchestration (T11)** ✓ · **CLI pins+eject (T12)** ✓ · docs (T13) ✓. Dashboard (SSE/confirm-modal/history UI) deferred to Plan 2.
- **Type consistency:** `NormalizedServer`/`HostEntry` (T1) ↔ `convertServer` (T2) ↔ `manualToHostServer` (T9, exact inverse: same `{command,args,env}` / `{url,headers,bearerTokenEnvVar}` fields) → `toClaudeServer`/`renderCodexMcpTable` (T10). `PlanItem` gains `pinned` (T8) consumed by `selectManuals`. `toManualIdentifier` defined once in `plan.mjs`. The mcp-remote arg shape produced in T2 (`["-y","mcp-remote",url,"--header",…]`) is exactly what T9 parses back. No naming drift.
- **Placeholder scan:** every code step is complete; no TODO/TBD. The Codex TOML table regex terminates a block at the next table of any kind (`^\[`) consistently across read (T1), strip (T6), and replace-on-write (T10/eject), so no block bleeds fields from a following table. Round-trip is covered: T2→T9 (convert↔un-wrap), T9→T10 (server→TOML/JSON), T11 (eject) re-reads what T5 wrote.
- **Edge-case guarantees:** same-named servers across hosts resolve deterministically (claude-code wins; all listed in the plan; all stripped together — see Global Constraints); `--strip-host` is migration-scoped (`applied.added` only), so it never deletes a host server lacking a live UTCP equivalent nor the denylisted code-mode bridge; backups are collision-safe (T4) so a same-file re-backup in one run keeps the pristine copy; `--apply` fails fast with a clear message if the UTCP config path doesn't exist (T7 `main`).
- **Validated against real configs:** Task 1 was checked against the live `~/.claude.json` (19 globals + 31 project blocks), `~/.codex/config.toml`, and Claude Desktop config. Two real shapes that fixtures missed are now handled and tested: nested Codex `.env` sub-tables (`node_repl` — would otherwise drop all env) and `enabled = false` servers (`context7`, `attio` — would otherwise migrate as active). `-mcp` suffix collisions are documented, not silently merged.

---

## Plan 2 (follow-up) — Live dashboard over the import core

Separable subsystem; build after Plan 1 ships. Reuses the Task 1–7 pure modules and borrows directly from `ai-config-sync-manager/scripts/dashboard.mjs`:

- **Server** (`scripts/host-import-server.mjs`): borrow `listenWithFallback` (port fallback), singleton-runtime file (`writeRuntime`/`clearRuntime`, never double-spawns), `openBrowser`, SIGINT/SIGTERM `shutdown`, per-session `TOKEN` + `originAllowed` origin check + body-size limit, SSE (`handleSse`/`broadcast`) with `node:fs.watch` on the three host configs + the UTCP config for live re-plan. Routes: `GET /` (HTML), `GET /api/plan` (calls Task 7 `run` dry-run), `GET /events` (SSE), `POST /api/apply` (token-guarded; calls `run` with `apply`/`stripHost`), `GET /api/history` (`listBackups`).
- **SPA** (`scripts/host-import/index.html` + `app.js` + `styles.css`): panels — **Discovered** (host servers), **Plan** (risk badges safe/partial/manual + duplicate), **History** (backups). A blocking **confirm modal** ("this mutates real config: UTCP + N host files") before `POST /api/apply`. Reuse the config-builder dark-theme tokens.
- **Tasks:** (9) server lifecycle + security + routes; (10) SSE live-watch + re-plan; (11) SPA panels + confirm modal + apply wiring. Each ends with a smoke test (server boots, `/api/plan` returns the same object as the CLI) + manual UI verification.

---

## Execution Handoff

Plan complete and saved to `code-mode-mcp/docs/superpowers/plans/2026-06-25-host-mcp-import.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
