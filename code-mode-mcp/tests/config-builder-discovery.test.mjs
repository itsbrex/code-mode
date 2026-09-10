import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverManuals } from "../scripts/lib/utcp-config.mjs";

function fixture(t, config) {
  const root = mkdtempSync(join(tmpdir(), "builder-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

test("empty discovery remains strict unless the config builder opts in", async (t) => {
  const path = fixture(t, { manual_call_templates: [] });
  const before = readFileSync(path, "utf8");
  await assert.rejects(discoverManuals(path), /No manual_call_templates found/);
  const result = await discoverManuals(path, undefined, { allowEmpty: true });
  assert.deepEqual(result.manuals, []);
  assert.equal(result.toolCount, 0);
  assert.equal(result.toolsByManual.size, 0);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("empty-config opt-in never accepts malformed manual lists", async (t) => {
  for (const config of [{}, { manual_call_templates: null }, { manual_call_templates: {} }, { manual_call_templates: "" }]) {
    const path = fixture(t, config);
    await assert.rejects(discoverManuals(path, undefined, { allowEmpty: true }), /No manual_call_templates found/);
  }
});

test("empty-config opt-in still validates the UTCP config schema", async (t) => {
  const path = fixture(t, { manual_call_templates: [], unexpected_setting: true });
  await assert.rejects(discoverManuals(path, undefined, { allowEmpty: true }));
});
