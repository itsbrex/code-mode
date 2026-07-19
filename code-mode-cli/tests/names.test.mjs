import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeIdentifier, utcpNameToTsInterfaceName } from "../dist/src/names.js";

// sanitizeIdentifier is a cross-package copy of code-mode-mcp's canonical
// sanitizer — this fixture set matches code-mode-mcp/tests/sanitizer-parity.test.mjs
// so drift between the packages fails loudly on either side.
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

test("sanitizeIdentifier matches the code-mode-mcp canonical fixture set", () => {
  for (const [input, expected] of FIXTURES) {
    assert.equal(sanitizeIdentifier(input), expected, `sanitizeIdentifier(${input})`);
  }
});

test("utcpNameToTsInterfaceName: manual.tool forms", () => {
  assert.equal(utcpNameToTsInterfaceName("openlibrary.read_search_json"), "openlibrary.read_search_json");
  assert.equal(utcpNameToTsInterfaceName("salesforce-mcp.run_soql"), "salesforce_mcp.run_soql");
  assert.equal(utcpNameToTsInterfaceName("m.server.tool-name"), "m.server_tool_name");
  assert.equal(utcpNameToTsInterfaceName("bare-name"), "bare_name");
});
