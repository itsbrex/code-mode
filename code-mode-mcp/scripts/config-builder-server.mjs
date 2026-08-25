#!/usr/bin/env node
/**
 * config-builder-server.mjs
 *
 * Launches the Tool Exclusion Config Builder: a local dark-mode dashboard for
 * visually choosing which tools each UTCP manual exposes, then exporting a named
 * `.utcp_config.json` with `exclude_tools` / `include_tools` / `default_disabled`
 * written in.
 *
 * Flow: resolve config -> register manuals -> discover real tools -> compute each
 * tool's initial hidden state with the SAME matcher the MCP server uses -> inject
 * the manifest into the SPA -> serve on localhost -> open the browser.
 *
 * Config path resolution (same as the generator): CLI arg, environment
 * variables (UTCP_CONFIG_FILE / UTCP_CONFIG_PATH), then `.env`.
 *
 * Flags:
 *   --port <n>     preferred port (default 7821, or $PORT; auto-increments if taken)
 *   --host <h>     bind host (default 127.0.0.1)
 *   --no-open      do not auto-open the browser
 *   --legacy       serve the previous dashboard UI (scripts/config-builder/legacy/)
 */

import http from "http";
import crypto from "crypto";
import { promises as fs, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import process from "process";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { intro, outro, note, log, spinner } from "@clack/prompts";

import { resolveConfigPath, discoverManuals } from "./lib/utcp-config.mjs";
// Host-import core (shared with the `npm run host-import` CLI). The web panel
// drives these to migrate host MCP servers into the UTCP config and strip them
// from the live host configs — every mutation is backup-on-write.
import { readAllHosts, defaultHostPaths } from "./lib/host-import/read-hosts.mjs";
import { buildPlan, readUtcpConfig, existingManualNames } from "./lib/host-import/plan.mjs";
import { addManualsToUtcp, stripFromClaudeJson, stripFromCodexToml } from "./lib/host-import/apply.mjs";
import { loadPins } from "./lib/host-import/pins.mjs";
import { DENYLIST } from "./lib/host-import/to-utcp.mjs";
// Run via `tsx` (see package.json `config-builder` script): tsx transpiles the
// TypeScript entry on the fly under Node, so no `tsc`/`dist` build is needed to
// launch. (Node — not Bun — because the discovery pipeline loads the native
// `isolated-vm` addon, which Bun cannot dlopen.)
import {
  buildExclusionRegistryFromConfig,
  isToolExcluded,
  utcpNameToTsInterfaceName
} from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "config-builder");
const LEGACY_APP_DIR = path.join(APP_DIR, "legacy");
const DEFAULT_PORT = 7821;
const SAVE_DIR_NAME = "configs";

// Per-launch CSRF token. Every mutating endpoint requires it in the
// `x-config-builder-token` header. The SPA receives it inside the manifest,
// which cross-origin pages cannot read (same-origin policy), so a malicious
// website cannot forge POSTs against the live host/UTCP configs.
const SESSION_TOKEN = crypto.randomBytes(16).toString("hex");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function parseFlag(argv, name) {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function shortNameOf(toolName, manualName) {
  const prefix = `${manualName}.`;
  if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  // Tools are filed under the SDK's sanitized manual id (e.g. "salesforce_mcp."),
  // which differs from the config manual name — strip the leading "<manual>."
  // segment regardless of exact spelling.
  const dot = toolName.indexOf(".");
  return dot === -1 ? toolName : toolName.slice(dot + 1);
}

async function buildManifest(configPath, onProgress = () => {}) {
  const { rawConfig, manuals, toolCount } = await discoverManuals(configPath, onProgress);

  // Authoritative initial state: reuse the exact matcher the MCP server enforces.
  const { registry } = buildExclusionRegistryFromConfig(rawConfig);

  const manifestManuals = manuals.map((manual) => ({
    name: manual.name,
    type: manual.type,
    defaultDisabled: manual.defaultDisabled,
    exclude_tools: manual.exclude_tools,
    include_tools: manual.include_tools,
    diagnostics: manual.diagnostics ?? { structureValid: true, registered: undefined, errors: [] },
    tools: manual.tools.map((tool) => ({
      name: tool.name,
      shortName: shortNameOf(tool.name, manual.name),
      description: tool.description,
      tags: tool.tags,
      initiallyHidden: isToolExcluded(tool.name, utcpNameToTsInterfaceName(tool.name), registry)
    }))
  }));

  return {
    source: configPath,
    toolCount,
    manualCount: manifestManuals.length,
    config: rawConfig,
    manuals: manifestManuals,
    token: SESSION_TOKEN
  };
}

function sanitizeFilename(name) {
  const base = path.basename(typeof name === "string" ? name : "").trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const withName = cleaned.length > 0 ? cleaned : "custom.utcp_config.json";
  return withName.endsWith(".json") ? withName : `${withName}.json`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(res, dirs, name) {
  let data = null;
  let served = null;
  for (const dir of dirs) {
    try {
      data = await fs.readFile(path.join(dir, name));
      served = name;
      break;
    } catch {
      /* try the next dir */
    }
  }
  if (data === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = CONTENT_TYPES[path.extname(served)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

async function serveIndex(res, uiDir, manifest) {
  const template = await fs.readFile(path.join(uiDir, "index.html"), "utf-8");
  // Embed the manifest so the app renders instantly on open (no fetch race).
  // Escape `</` so the JSON can never terminate the surrounding <script> tag.
  const injected = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  const html = template.replace("window.__MANIFEST__ = null;", `window.__MANIFEST__ = ${injected};`);
  res.writeHead(200, { "content-type": CONTENT_TYPES[".html"], "cache-control": "no-store" });
  res.end(html);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error("Request body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// --- Host import (live migrate / strip over the real host configs) -----------

function planItemView(it) {
  return {
    host: it.host,
    scope: it.scope,
    projectKey: it.projectKey ?? null,
    name: it.name,
    risk: it.risk,
    reason: it.reason,
    duplicate: it.duplicate,
    pinned: it.pinned,
    // a row is migratable when it converts cleanly and isn't already federated/pinned
    canMigrate: Boolean(it.manual) && !it.duplicate && !it.pinned
  };
}

function buildHostPlan(ctx) {
  const hosts = readAllHosts(ctx.hostPaths);
  const utcp = readUtcpConfig(ctx.configPath);
  const pins = loadPins(ctx.pinsFile, []);
  return buildPlan(hosts, utcp, pins);
}

function hostPlanView(ctx) {
  const plan = buildHostPlan(ctx);
  return {
    utcpPath: ctx.configPath,
    hostPaths: ctx.hostPaths,
    items: plan.items.map(planItemView),
    pins: loadPins(ctx.pinsFile, []).map((p) => (p.host && p.host !== "*" ? `${p.host}:${p.name}` : p.name))
  };
}

// Migrate the named host servers into the UTCP config (deduped, backup-on-write).
function applyImport(ctx, names) {
  const want = new Set(Array.isArray(names) ? names : []);
  const plan = buildHostPlan(ctx);
  const seen = new Set();
  const manuals = [];
  for (const it of plan.items) {
    if (!want.has(it.name) || it.duplicate || it.pinned || !it.manual) continue;
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    manuals.push(it.manual);
  }
  if (!manuals.length) return { added: [], skipped: [], backup: null };
  return addManualsToUtcp(ctx.configPath, manuals, ctx.backupRoot);
}

// Strip the given host entries from their real configs. Guarded: never strips a
// denylisted bridge (code-mode/*-code-mode), and only strips servers actually
// federated in the UTCP config (so we never delete a host server code-mode isn't
// already providing). Grouped by file so each config is backed up + written once.
function stripHosts(ctx, entries) {
  const federated = existingManualNames(readUtcpConfig(ctx.configPath));
  const groups = new Map();
  const refused = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.name !== "string") continue;
    if (DENYLIST.has(e.name)) { refused.push({ name: e.name, reason: "denylisted bridge" }); continue; }
    if (!federated.has(e.name)) { refused.push({ name: e.name, reason: "not federated in UTCP" }); continue; }
    const scope = e.scope === "project" ? "project" : "global";
    const key = `${e.host}|${scope}|${e.projectKey || ""}`;
    if (!groups.has(key)) groups.set(key, { host: e.host, scope, projectKey: e.projectKey || undefined, names: [] });
    groups.get(key).names.push(e.name);
  }
  const stripped = [];
  for (const g of groups.values()) {
    let r;
    if (g.host === "codex") r = stripFromCodexToml(ctx.hostPaths.codex, g.names, ctx.backupRoot);
    else if (g.host === "claude-desktop") r = stripFromClaudeJson(ctx.hostPaths.claudeDesktop, g.names, ctx.backupRoot, { scope: "global" });
    else r = stripFromClaudeJson(ctx.hostPaths.claudeCode, g.names, ctx.backupRoot, { scope: g.scope, projectKey: g.projectKey });
    stripped.push({ host: g.host, scope: g.scope, projectKey: g.projectKey ?? null, removed: r.removed, backup: r.backup });
  }
  return { stripped, refused };
}

// Pin/unpin a server (per-host or any-host) in ~/.host-import-pins.json.
function setPin(ctx, name, host, pinned) {
  let data = { pins: [] };
  if (existsSync(ctx.pinsFile)) {
    try { data = JSON.parse(readFileSync(ctx.pinsFile, "utf-8")); } catch { data = { pins: [] }; }
  }
  const asStr = (p) => (typeof p === "string" ? p : p && p.host && p.host !== "*" ? `${p.host}:${p.name}` : p && p.name) || "";
  const set = new Set((Array.isArray(data.pins) ? data.pins : []).map(asStr).filter(Boolean));
  const key = host && host !== "*" ? `${host}:${name}` : name;
  if (pinned) set.add(key);
  else {
    // Unpin removes every spelling of this server's pin: the bare name and any
    // host-scoped `host:name` entries (an any-host unpin must not leave those).
    set.delete(key);
    set.delete(name);
    if (!host || host === "*") {
      for (const entry of [...set]) if (entry.endsWith(`:${name}`)) set.delete(entry);
    }
  }
  const out = { ...data, pins: [...set] };
  writeFileSync(ctx.pinsFile, JSON.stringify(out, null, 2) + "\n");
  return { pins: out.pins };
}

function createServer(manifest, ctx, uiDir = APP_DIR) {
  const staticDirs = [uiDir, APP_DIR];
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        await serveIndex(res, uiDir, manifest);
        return;
      }

      if (req.method === "GET" && pathname === "/api/manifest") {
        sendJson(res, 200, manifest);
        return;
      }

      // Every mutating endpoint requires the per-launch token (CSRF guard: a
      // cross-origin page can send a POST here but can never read the token).
      if (req.method === "POST") {
        if (req.headers["x-config-builder-token"] !== SESSION_TOKEN) {
          sendJson(res, 403, { error: "Missing or invalid session token" });
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/save") {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (!payload || typeof payload.config !== "object" || payload.config === null) {
          sendJson(res, 400, { error: "Missing 'config' object" });
          return;
        }
        const filename = sanitizeFilename(payload.filename);
        const outDir = path.resolve(process.cwd(), SAVE_DIR_NAME);
        await fs.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, filename);
        // Never clobber an existing file silently — the client confirms first.
        if (payload.overwrite !== true && existsSync(outPath)) {
          sendJson(res, 409, { error: `${filename} already exists`, exists: true, path: outPath });
          return;
        }
        await fs.writeFile(outPath, JSON.stringify(payload.config, null, 2) + "\n");
        sendJson(res, 200, { ok: true, path: outPath });
        return;
      }

      // --- Host import API (live; reads/writes the real host + UTCP configs) ---
      if (ctx && req.method === "GET" && pathname === "/api/host-plan") {
        sendJson(res, 200, hostPlanView(ctx));
        return;
      }

      if (ctx && req.method === "POST" && (pathname === "/api/host-apply" || pathname === "/api/host-strip" || pathname === "/api/host-pin")) {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: "Invalid JSON body" }); return; }

        if (pathname === "/api/host-apply") {
          const result = applyImport(ctx, body && body.names);
          sendJson(res, 200, { ok: true, ...result, plan: hostPlanView(ctx) });
          return;
        }
        if (pathname === "/api/host-strip") {
          const result = stripHosts(ctx, body && body.entries);
          sendJson(res, 200, { ok: true, ...result, plan: hostPlanView(ctx) });
          return;
        }
        // /api/host-pin
        if (!body || typeof body.name !== "string") { sendJson(res, 400, { error: "Missing 'name'" }); return; }
        const result = setPin(ctx, body.name, body.host || "*", body.pinned !== false);
        sendJson(res, 200, { ok: true, ...result, plan: hostPlanView(ctx) });
        return;
      }

      if (req.method === "GET" && /^\/[A-Za-z0-9_-]+\.(js|mjs|css|svg)$/.test(pathname)) {
        await serveStatic(res, staticDirs, path.basename(pathname));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      // Best-effort error response; the socket may already be gone (e.g. the
      // 413 path destroys it) — never let that take the whole server down.
      try {
        if (!res.headersSent && !res.writableEnded) {
          sendJson(res, error?.statusCode ?? 500, { error: error instanceof Error ? error.message : String(error) });
        }
      } catch {
        /* socket already closed */
      }
    }
  });
}

function listenWithFallback(server, host, startPort, attempts = 25) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let triesLeft = attempts;

    const tryListen = () => {
      server.removeAllListeners("error");
      const onError = (err) => {
        if (err.code === "EADDRINUSE" && triesLeft > 0) {
          triesLeft -= 1;
          port += 1;
          tryListen();
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        // Drop the bind-retry handler once listening — a later runtime error
        // must not re-enter listen() on an already-listening server.
        server.removeListener("error", onError);
        resolve(port);
      });
    };

    tryListen();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const noOpen = argv.includes("--no-open") || process.env.CONFIG_BUILDER_NO_OPEN === "1";
  const legacyUi = argv.includes("--legacy") || process.env.CONFIG_BUILDER_UI === "legacy";
  const host = parseFlag(argv, "--host") ?? "127.0.0.1";
  const portFlag = parseFlag(argv, "--port") ?? process.env.PORT;
  const parsedPort = Number(portFlag);
  const preferredPort =
    portFlag !== undefined && Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_PORT;

  intro("Tool Exclusion Config Builder");

  const configPath = resolveConfigPath();
  log.step(`Source: ${configPath}`);

  const spin = spinner();
  spin.start("Registering manuals & discovering tools");

  // Silence the UTCP SDK's own console chatter so the spinner stays clean.
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = () => {};
  // Keep the spinner message within the terminal width. clack only erases a
  // single row between frames, so a message that wraps leaves the previous
  // frames behind — clamp it to one line so the spinner stays put.
  const fitLine = (msg) => {
    const max = Math.max(16, (process.stdout.columns || 80) - 8);
    return msg.length > max ? msg.slice(0, max - 1) + "…" : msg;
  };
  let manifest;
  try {
    manifest = await buildManifest(configPath, (msg) => spin.message(fitLine(msg)));
  } finally {
    Object.assign(console, original);
  }
  spin.stop(`Discovered ${manifest.toolCount} tools across ${manifest.manualCount} manuals`);

  // Attributable per-manual failures first (structure or registration), then
  // the residue: manuals that registered fine but genuinely exposed nothing.
  const broken = manifest.manuals.filter(
    (m) => m.diagnostics && (m.diagnostics.structureValid === false || m.diagnostics.registered === false)
  );
  for (const m of broken) {
    log.warn(`${m.name}: ${m.diagnostics.errors[0] ?? "registration failed"}`);
  }
  const empty = manifest.manuals.filter((m) => m.tools.length === 0 && !broken.includes(m));
  if (empty.length) {
    log.warn(`${empty.length} manual(s) registered but returned no tools: ${empty.map((m) => m.name).join(", ")}`);
  }

  const home = process.env.HOME || os.homedir();
  const hostImportCtx = {
    configPath,
    hostPaths: defaultHostPaths(home),
    backupRoot: path.join(home, ".host-import-backups"),
    pinsFile: path.join(home, ".host-import-pins.json")
  };
  const server = createServer(manifest, hostImportCtx, legacyUi ? LEGACY_APP_DIR : APP_DIR);
  const port = await listenWithFallback(server, host, preferredPort);
  const url = `http://${host}:${port}/`;

  // Ctrl+C / SIGTERM: close the HTTP server and force-exit. Discovery spawns
  // child MCP processes and isolated-vm holds worker threads, which keep the
  // event loop alive — without an explicit exit, the default SIGINT just hangs.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    try {
      outro("Stopping…");
    } catch {
      /* clack may already be torn down */
    }
    server.close();
    // Don't wait on lingering child stdio handles — exit now. Children exit on
    // their own when their stdin pipe closes.
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  note(
    `${url}\n\n${manifest.manualCount} manuals · ${manifest.toolCount} tools` + (noOpen ? "" : "\nOpening your browser…"),
    "Ready"
  );

  if (!noOpen) {
    openBrowser(url);
  }

  outro("Running — press Ctrl+C to stop.");
}

main().catch((error) => {
  log.error(`config-builder failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
