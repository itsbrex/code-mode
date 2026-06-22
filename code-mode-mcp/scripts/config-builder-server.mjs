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
 * Config path resolution (same as the generator): CLI arg, `.env`
 * (UTCP_CONFIG_PATH / UTCP_CONFIG_FILE), then environment variables.
 *
 * Flags:
 *   --port <n>     preferred port (default 7821; auto-increments if taken)
 *   --host <h>     bind host (default 127.0.0.1)
 *   --no-open      do not auto-open the browser
 */

import http from "http";
import { promises as fs } from "fs";
import path from "path";
import process from "process";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { resolveConfigPath, discoverManuals } from "./lib/utcp-config.mjs";
import {
  buildExclusionRegistryFromConfig,
  isToolExcluded,
  utcpNameToTsInterfaceName
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "config-builder");
const DEFAULT_PORT = 7821;
const SAVE_DIR_NAME = "configs";

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
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

async function buildManifest(configPath) {
  const { rawConfig, manuals, toolCount } = await discoverManuals(configPath, (msg) =>
    console.error(msg)
  );

  // Authoritative initial state: reuse the exact matcher the MCP server enforces.
  const { registry } = buildExclusionRegistryFromConfig(rawConfig);

  const manifestManuals = manuals.map((manual) => ({
    name: manual.name,
    type: manual.type,
    defaultDisabled: manual.defaultDisabled,
    exclude_tools: manual.exclude_tools,
    include_tools: manual.include_tools,
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
    manuals: manifestManuals
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

async function serveStatic(res, filePath) {
  const data = await fs.readFile(filePath);
  const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

async function serveIndex(res, manifest) {
  const template = await fs.readFile(path.join(APP_DIR, "index.html"), "utf-8");
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
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function createServer(manifest) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        await serveIndex(res, manifest);
        return;
      }

      if (req.method === "GET" && pathname === "/api/manifest") {
        sendJson(res, 200, manifest);
        return;
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
        await fs.writeFile(outPath, JSON.stringify(payload.config, null, 2) + "\n");
        sendJson(res, 200, { ok: true, path: outPath });
        return;
      }

      if (req.method === "GET" && (pathname === "/styles.css" || pathname === "/app.js")) {
        await serveStatic(res, path.join(APP_DIR, pathname.slice(1)));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function listenWithFallback(server, host, startPort, attempts = 25) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let triesLeft = attempts;

    const tryListen = () => {
      server.removeAllListeners("error");
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && triesLeft > 0) {
          triesLeft -= 1;
          port += 1;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(port, host, () => resolve(port));
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
  const host = parseFlag(argv, "--host") ?? "127.0.0.1";
  const portFlag = parseFlag(argv, "--port");
  const preferredPort = portFlag ? Number(portFlag) : DEFAULT_PORT;

  const configPath = resolveConfigPath();
  console.error(`Source config: ${configPath}`);

  const manifest = await buildManifest(configPath);

  const server = createServer(manifest);
  const port = await listenWithFallback(server, host, preferredPort);
  const url = `http://${host}:${port}/`;

  console.error("");
  console.error(`  Tool Exclusion Config Builder`);
  console.error(`  ${manifest.manualCount} manual(s), ${manifest.toolCount} tool(s)`);
  console.error(`  ${url}`);
  console.error("");
  console.error("  Press Ctrl+C to stop.");

  if (!noOpen) {
    openBrowser(url);
  }
}

main().catch((error) => {
  console.error(`config-builder failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
