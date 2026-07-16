#!/usr/bin/env node
// Tear down what dev-register.mjs set up: deregister the Claude Code MCP server
// and restore the registry version of @utcp/code-mode (overwrites the local
// dist/ overlay).
//
// Usage:
//   node scripts/dev-unregister.mjs [--name <mcp-name>]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const name = getArg("--name", "utcp-codemode-dev");

if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
  console.error(`✗ Invalid --name '${name}'. Must match [a-zA-Z0-9_-]+.`);
  process.exit(1);
}

let hadFailure = false;

// `claude mcp remove` is allowed to fail (entry may already be gone) — log
// but don't abort the rest of the cleanup. Other steps must succeed for the
// success message to be honest.
function tryRun(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}  (in ${opts.cwd ?? process.cwd()})`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.warn(`⚠ ${cmd} ${args[0] ?? ""} exited ${r.status}; continuing.`);
  }
}

function mustRun(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}  (in ${opts.cwd ?? process.cwd()})`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args[0] ?? ""} failed (exit ${r.status}).`);
    hadFailure = true;
  }
}

tryRun("claude", ["mcp", "remove", name, "--scope", "user"]);
// Reinstall @utcp/code-mode from the registry, undoing the dev-register dist
// overlay. --no-save keeps package.json untouched.
mustRun("npm", ["install", "@utcp/code-mode", "--no-save"], { cwd: bridgeDir });

if (hadFailure) {
  console.error(`\n✗ Unregister completed with errors. Registry @utcp/code-mode may not have been restored — re-run 'npm install' manually before publishing.`);
  process.exit(1);
}

console.log(`\n✓ Unregistered '${name}' and restored registry @utcp/code-mode.`);
console.log(`  Restart Claude Code so it stops trying to spawn the dev bridge.`);
