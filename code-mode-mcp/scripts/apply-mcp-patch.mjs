#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
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
const dependencyVersion = JSON.parse(readFileSync(join(dependencyRoot, "package.json"), "utf8")).version;
if (dependencyVersion !== "1.1.7") {
  throw new Error(`Local Bridge requires @utcp/mcp@1.1.7; found ${dependencyVersion}`);
}
const requiredMarkers = [
  'circular: "ignore"',
  "UTCP_MCP_CHILD_STDERR",
  "_normalizeBooleanSchemas",
  "new WeakMap()",
  "!hasContent && result.structuredContent != null",
  "return result.structuredContent;"
];
function patchIsInstalled() {
  return ["index.js", "index.cjs"].every((file) => {
    const source = readFileSync(join(dependencyRoot, "dist", file), "utf8");
    const parser = file.endsWith(".cjs") ? "import_json_schema_ref_parser.default" : "$RefParser";
    return requiredMarkers.every((marker) => source.includes(marker)) &&
      source.includes(`resolved = await ${parser}.dereference(schema, {`);
  });
}

if (!patchIsInstalled()) {
  const options = {
    appPath: appRoot,
    reverse: false,
    patchDir: relative(appRoot, join(packageRoot, "patches")),
    shouldExitWithError: true,
    shouldExitWithWarning: false,
    bestEffort: false
  };
  // patch-package exits its process even on success. Keep verification here
  // alive by running its installer in a child with explicit argv, without a shell.
  const applied = spawnSync(process.execPath, [
    "-e",
    "require(process.argv[1]).applyPatchesForApp(JSON.parse(process.argv[2]))",
    require.resolve("patch-package/dist/applyPatches"),
    JSON.stringify(options)
  ], { cwd: appRoot, stdio: "inherit", timeout: 30_000 });
  if (applied.error) throw applied.error;
  if (applied.status !== 0) {
    throw new Error(`Local Bridge MCP patch installer failed: ${applied.signal ?? applied.status}`);
  }
}
if (!patchIsInstalled()) {
  throw new Error("Local Bridge MCP compatibility patch verification failed");
}
console.log("@utcp/mcp@1.1.7 Local Bridge patch verified");
