import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    ...options
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

test("packed Local Bridge installs with runtime files and required MCP patch", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "code-mode-mcp-pack-"));
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({ name: "packed-install-fixture", private: true })
  );
  const isolatedUserConfig = join(fixtureDir, "empty-user.npmrc");
  writeFileSync(isolatedUserConfig, "");
  const installEnvironment = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: isolatedUserConfig
  };
  delete installEnvironment.NPM_CONFIG_ALLOW_SCRIPTS;
  delete installEnvironment.npm_config_allow_scripts;

  run("npm", ["pack", "--ignore-scripts", "--pack-destination", fixtureDir], {
    cwd: projectRoot
  });
  const tarball = join(
    fixtureDir,
    readdirSync(fixtureDir).find((name) => name.endsWith(".tgz"))
  );
  const members = run("tar", ["-tf", tarball]).stdout.split("\n");
  for (const required of [
    "package/dist/index.js",
    "package/dist/config-path.mjs",
    "package/patches/@utcp+mcp+1.1.3.patch",
    "package/scripts/apply-mcp-patch.mjs",
    "package/scripts/host-import-cli.mjs"
  ]) {
    assert.equal(members.includes(required), true, `missing ${required}`);
  }

  run(
    "npm",
    ["install", "--no-audit", "--no-fund", tarball],
    {
      cwd: fixtureDir,
      env: installEnvironment
    }
  );
  const installedRoot = join(
    fixtureDir,
    "node_modules",
    "@itsbrex",
    "code-mode-mcp"
  );
  const installedManifest = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8")
  );
  assert.equal(installedManifest.private, true);

  const dependencyRoot = readdirSync(join(installedRoot, "node_modules", "@utcp")).includes("mcp")
    ? join(installedRoot, "node_modules", "@utcp", "mcp")
    : join(fixtureDir, "node_modules", "@utcp", "mcp");
  for (const runtimeFile of ["index.js", "index.cjs"]) {
    const patchedMcp = readFileSync(
      join(dependencyRoot, "dist", runtimeFile),
      "utf8"
    );
    assert.match(patchedMcp, /circular: "ignore"/);
    assert.match(patchedMcp, /UTCP_MCP_CHILD_STDERR/);
    assert.match(patchedMcp, /result\.structuredContent != null/);
  }
});
