import test from "node:test";
import assert from "node:assert/strict";

import { toManualIdentifier } from "../scripts/lib/manual-name.mjs";
import { toManualIdentifier as planCopy } from "../scripts/lib/host-import/plan.mjs";
import { sanitizeManualName } from "../dist/tool-exclusion.js";
import { sanitizeIdentifier } from "../dist/index.js";

// Drift between sanitizer copies caused FIX_ME #9 (phantom orphan manuals +
// exclusion rules that never matched). This test locks every implementation to
// the same behavior so a future edit to one copy fails loudly.

const FIXTURES = [
  ["salesforce-mcp", "salesforce_mcp"],
  ["proxyman-mcp", "proxyman_mcp"],
  ["typefully", "typefully"],
  ["already_sane", "already_sane"],
  ["dots.and-dashes", "dots_and_dashes"],
  ["1starts-with-digit", "_1starts_with_digit"],
  ["weird!chars@here", "weird_chars_here"],
  ["", ""]
];

test("all sanitizer implementations agree on the fixture set", () => {
  for (const [input, expected] of FIXTURES) {
    assert.equal(toManualIdentifier(input), expected, `manual-name.mjs(${input})`);
    assert.equal(planCopy(input), expected, `plan.mjs re-export(${input})`);
    assert.equal(sanitizeManualName(input), expected, `tool-exclusion.ts(${input})`);
    assert.equal(sanitizeIdentifier(input), expected, `index.ts(${input})`);
  }
});

test("plan.mjs re-export IS the canonical function (same reference)", () => {
  assert.equal(planCopy, toManualIdentifier);
});
