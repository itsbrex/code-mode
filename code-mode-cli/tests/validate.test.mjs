import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Protocol plugins self-register on import (side effect) — in the real CLI
// index.ts does this; a direct validate.js import must do it too, or every
// call_template_type is "invalid".
import "@utcp/http";
import { validateManualFiles } from "../dist/src/validate.js";

const GOOD_MANUAL = {
  utcp_version: "1.0.0",
  manual_version: "1.0.0",
  tools: [
    {
      name: "echo",
      description: "Echo a message",
      inputs: { type: "object", properties: { msg: { type: "string" } } },
      outputs: { type: "object", properties: { msg: { type: "string" } } },
      tags: [],
      tool_call_template: {
        name: "echo",
        call_template_type: "http",
        http_method: "GET",
        url: "https://example.com/echo",
        content_type: "application/json"
      }
    }
  ]
};

test("validateManualFiles: well-formed manual passes with tool listing", async () => {
  const d = mkdtempSync(join(tmpdir(), "vm-"));
  const p = join(d, "good.json");
  writeFileSync(p, JSON.stringify(GOOD_MANUAL));
  const res = await validateManualFiles([p]);
  assert.equal(res.valid, true);
  assert.equal(res.manuals[0].tool_count, 1);
  assert.deepEqual(res.manuals[0].tools, ["echo"]);
});

test("validateManualFiles: malformed JSON and bad shape both fail attributably", async () => {
  const d = mkdtempSync(join(tmpdir(), "vm-"));
  const bad = join(d, "bad.json");
  const notJson = join(d, "not.json");
  writeFileSync(bad, JSON.stringify({ tools: "not-an-array" }));
  writeFileSync(notJson, "{nope");
  const res = await validateManualFiles([bad, notJson]);
  assert.equal(res.valid, false);
  assert.equal(res.manuals.length, 2);
  for (const m of res.manuals) {
    assert.equal(m.valid, false);
    assert.ok(m.errors.length > 0);
  }
});
