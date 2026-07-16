#!/usr/bin/env node
// Wire up the local code-mode-mcp bridge as an MCP server in Claude Code,
// pointed at the local @utcp/code-mode build so edits in ../typescript-library
// flow through after rebuild + Claude Code restart.
//
// Strategy: overlay the locally-built dist/ on top of the registry version
// inside node_modules. We avoid `npm link` because modern npm treats `npm
// unlink <pkg>` as `npm uninstall --save`, which mutates package.json.
//
// Usage:
//   node scripts/dev-register.mjs [--name <mcp-name>] [--config <path>]
//
// Defaults:
//   --name    utcp-codemode-dev
//   --config  ./.utcp_config.json (relative to bridge package)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, "..");
const libDir = path.resolve(bridgeDir, "..", "typescript-library");

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const name = getArg("--name", "utcp-codemode-dev");
const configPath = path.resolve(bridgeDir, getArg("--config", ".utcp_config.json"));

// Validate --name against the same character set Claude Code's managed-server
// schema accepts ([a-zA-Z0-9_-]). The value is later interpolated into a shell
// command string (because Windows .cmd shims require shell: true and cmd.exe
// won't strip our JSON quoting otherwise), so anything outside this set could
// break out of the argument and execute attacker-supplied commands.
if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
  console.error(`✗ Invalid --name '${name}'. Must match [a-zA-Z0-9_-]+.`);
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error(`✗ Config file not found: ${configPath}`);
  console.error(`  Pass --config <path> or create one at ${configPath}.`);
  process.exit(1);
}
if (!existsSync(libDir)) {
  console.error(`✗ Sibling library not found at ${libDir}.`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}  (in ${opts.cwd ?? process.cwd()})`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`✗ Command failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

// 1. Make sure the bridge has its registry deps installed (provides
//    node_modules/@utcp/code-mode for us to overlay onto).
if (!existsSync(path.join(bridgeDir, "node_modules", "@utcp", "code-mode"))) {
  run("npm", ["install"], { cwd: bridgeDir });
}

// 2. Build the local lib so dist/ is current.
run("npm", ["run", "build"], { cwd: libDir });

// 3. Overlay the local lib's dist/ over the registry copy in the bridge's
//    node_modules. This is non-destructive — `npm install` later restores the
//    registry version.
const localDist = path.join(libDir, "dist");
const targetDist = path.join(bridgeDir, "node_modules", "@utcp", "code-mode", "dist");
console.log(`> overlay  ${localDist}  ->  ${targetDist}`);
rmSync(targetDist, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });
cpSync(localDist, targetDist, { recursive: true });

// 4. Build the bridge against the overlaid lib.
run("npm", ["run", "build"], { cwd: bridgeDir });

// 5. Register with Claude Code (user scope). Removes a stale entry first so the
//    command is idempotent.
spawnSync("claude", ["mcp", "remove", name, "--scope", "user"], {
  stdio: "ignore",
  shell: true,
});

const distEntry = path.join(bridgeDir, "dist", "index.js").replace(/\\/g, "/");
const cfg = configPath.replace(/\\/g, "/");
const mcpJson = JSON.stringify({
  type: "stdio",
  command: "node",
  args: [distEntry],
  env: { UTCP_CONFIG_FILE: cfg },
});

const isWindows = os.platform() === "win32";
const quotedJson = isWindows
  ? `"${mcpJson.replace(/"/g, '\\"')}"`
  : `'${mcpJson.replace(/'/g, `'\\''`)}'`;

const cmdLine = `claude mcp add-json --scope user ${name} ${quotedJson}`;
console.log(`> ${cmdLine}`);
const r = spawnSync(cmdLine, { stdio: "inherit", shell: true });
if (r.status !== 0) {
  console.error(`✗ claude mcp add-json failed (exit ${r.status}).`);
  process.exit(r.status ?? 1);
}

console.log(`\n✓ Registered MCP server '${name}' (user scope).`);
console.log(`  Entry:  ${distEntry}`);
console.log(`  Config: ${cfg}`);
console.log(`\nRestart Claude Code to load the server. Then call`);
console.log(`'mcp__${name}__call_tool_chain' to test changes.`);
console.log(`\nAfter editing the library or bridge, re-run this script to rebuild +`);
console.log(`re-register, then restart Claude Code again.`);
