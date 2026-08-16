#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { applyPatchesForApp } = require("patch-package/dist/applyPatches");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findDependencyRoot(start) {
  let candidate = start;
  while (true) {
    if (existsSync(join(candidate, "node_modules", "@utcp", "mcp", "package.json"))) {
      return candidate;
    }
    const parent = resolve(candidate, "..");
    if (parent === candidate) {
      throw new Error("Cannot locate installed @utcp/mcp dependency for Local Bridge patch");
    }
    candidate = parent;
  }
}

const appRoot = findDependencyRoot(packageRoot);
const dependencyRoot = join(appRoot, "node_modules", "@utcp", "mcp");
const requiredMarkers = [
  'circular: "ignore"',
  "UTCP_MCP_CHILD_STDERR",
  "result.structuredContent != null"
];
const runtimeFiles = ["index.js", "index.cjs"].map((file) =>
  readFileSync(join(dependencyRoot, "dist", file), "utf8")
);
if (
  runtimeFiles.every((source) =>
    requiredMarkers.every((marker) => source.includes(marker))
  )
) {
  console.log("@utcp/mcp@1.1.3 Local Bridge patch verified");
  process.exit(0);
}

const patchDir = relative(appRoot, join(packageRoot, "patches"));

applyPatchesForApp({
  appPath: appRoot,
  reverse: false,
  patchDir,
  shouldExitWithError: true,
  shouldExitWithWarning: false,
  bestEffort: false
});
