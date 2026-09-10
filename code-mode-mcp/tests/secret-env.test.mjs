import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("credential wrapper preserves masking and uses only the supplied fake executable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "secret-env-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "fake-op");
  const envFile = join(root, "fixture.env");
  const output = join(root, "args.json");
  writeFileSync(envFile, "# Synthetic; no credentials\n");
  writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv[2]!=='--version') fs.writeFileSync(process.env.FIXTURE_ARGS,JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const script = `import {ensureSecretEnv} from ${JSON.stringify(new URL("../scripts/lib/secret-env.mjs", import.meta.url).href)}; ensureSecretEnv();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH, OP_BIN: binary, CODE_MODE_ENV_FILE: envFile, FIXTURE_ARGS: output } });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(args[0], "run");
  assert.ok(args.includes(`--env-file=${envFile}`));
  assert.equal(args.includes("--no-masking"), false);
});
