import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addManualsToUtcp } from "../scripts/lib/host-import/apply.mjs";

function manual(name) {
  return { call_template_type: "mcp", config: { mcpServers: { [name]: { command: "x", args: [], env: {}, transport: "stdio" } } }, name };
}

test("addManualsToUtcp appends new, skips existing, backs up", () => {
  const d = mkdtempSync(join(tmpdir(), "apply-"));
  const p = join(d, "hide.utcp_config.json");
  writeFileSync(p, JSON.stringify({ manual_call_templates: [{ name: "memory" }] }, null, 2));
  const root = join(d, ".bk");
  const res = addManualsToUtcp(p, [manual("memory"), manual("github")], root, { stamp: "S" });
  assert.deepEqual(res.added, ["github"]);
  assert.deepEqual(res.skipped, ["memory"]);
  assert.equal(res.backup, join(root, "S", "hide.utcp_config.json"));
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(out.manual_call_templates.map((t) => t.name), ["memory", "github"]);
});

test("addManualsToUtcp creates manual_call_templates if absent", () => {
  const d = mkdtempSync(join(tmpdir(), "apply-"));
  const p = join(d, "c.json");
  writeFileSync(p, JSON.stringify({ load_variables_from: [] }));
  const res = addManualsToUtcp(p, [manual("a")], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.added, ["a"]);
  const out = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(out.manual_call_templates.length, 1);
});
