import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(projectRoot, "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("Local Bridge package is private, installable, and internally consistent", () => {
  const manifest = readJson(join(projectRoot, "package.json"));
  const lock = readJson(join(projectRoot, "package-lock.json"));

  assert.equal(manifest.name, "@itsbrex/code-mode-mcp");
  assert.equal(manifest.private, true);
  assert.equal(manifest.publishConfig, undefined);
  assert.equal(manifest.engines.node, ">=22");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(lock.packages[""].engines.node, ">=22");
  assert.equal(manifest.dependencies["patch-package"], "^8.0.1");
  assert.equal(manifest.devDependencies["patch-package"], undefined);
  assert.equal(
    manifest.scripts.prepack,
    "npm run build && node scripts/apply-mcp-patch.mjs"
  );
  assert.equal(manifest.scripts.plan, undefined);
  assert.equal(manifest.scripts["plan:no-open"], undefined);
  assert.equal(manifest.files.includes("patches/**/*"), true);
  assert.equal(manifest.files.includes("scripts/**/*"), true);
  assert.equal(manifest.dependencies["@utcp/mcp"], "1.1.3");
  assert.deepEqual(manifest.bundledDependencies, ["@utcp/mcp"]);
});

test("Node 22 floor is consistent across Node package manifests and locks", () => {
  for (const directory of ["code-mode-mcp", "typescript-library", "code-mode-cli"]) {
    const manifest = readJson(join(repositoryRoot, directory, "package.json"));
    const lock = readJson(join(repositoryRoot, directory, "package-lock.json"));
    assert.equal(manifest.engines.node, ">=22", `${directory} manifest`);
    assert.equal(lock.packages[""].engines.node, ">=22", `${directory} lock root`);
  }
});

test("CLI source maintenance uses refreshed UTCP adapter baselines", () => {
  const manifest = readJson(join(repositoryRoot, "code-mode-cli", "package.json"));
  const lock = readJson(join(repositoryRoot, "code-mode-cli", "package-lock.json"));

  assert.equal(manifest.dependencies["@utcp/sdk"], "^1.1.2");
  assert.equal(manifest.dependencies["@utcp/http"], "^1.1.11");
  assert.equal(lock.packages["node_modules/@utcp/sdk"].version, "1.1.2");
  assert.equal(lock.packages["node_modules/@utcp/http"].version, "1.1.11");
});
