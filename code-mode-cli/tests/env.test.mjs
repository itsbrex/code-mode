import test from "node:test";
import assert from "node:assert/strict";
import { namespacedKey, varNameFromTemplate } from "../dist/src/env.js";

// namespacedKey must produce EXACTLY the key the UTCP SDK's
// UtcpClient._getVariable derives: namespace.replace(/_/g,"!").replace(/!/g,"__") + "_" + key.
// The SDK-quirk mirror (incl. '!' folding) is deliberate — see src/env.ts.
function sdkDerivation(namespace, key) {
  return namespace.replace(/_/g, "!").replace(/!/g, "__") + "_" + key;
}

test("namespacedKey matches the SDK derivation for typical manual names", () => {
  for (const [manual, varName] of [
    ["github", "GITHUB_TOKEN"],
    ["zoominfo_mcp", "ZI_TOKEN"],
    ["my_long_manual_name", "TOK"],
  ]) {
    assert.equal(namespacedKey(manual, varName), sdkDerivation(manual, varName));
  }
});

test("namespacedKey doubles underscores", () => {
  assert.equal(namespacedKey("zoominfo_mcp", "TOK"), "zoominfo__mcp_TOK");
  assert.equal(namespacedKey("plain", "TOK"), "plain_TOK");
});

test("namespacedKey mirrors the SDK's '!' quirk (deliberate)", () => {
  // A literal '!' also folds to '__' — because the SDK does exactly that.
  assert.equal(namespacedKey("we!rd", "TOK"), sdkDerivation("we!rd", "TOK"));
  assert.equal(namespacedKey("we!rd", "TOK"), "we__rd_TOK");
});

test("varNameFromTemplate extracts ${VAR} and $VAR forms", () => {
  assert.equal(varNameFromTemplate("${MY_TOKEN}"), "MY_TOKEN");
  assert.equal(varNameFromTemplate("$MY_TOKEN"), "MY_TOKEN");
  assert.equal(varNameFromTemplate("Bearer ${TOK}"), "TOK");
  assert.equal(varNameFromTemplate("no-var-here"), null);
  assert.equal(varNameFromTemplate(""), null);
});
