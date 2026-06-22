import test from "node:test";
import assert from "node:assert/strict";

import {
  parseExclusionRule,
  stripExclusionKeys,
  getManualNameFromToolName,
  getToolShortName,
  isToolExcluded,
  applyManualExclusion,
  buildExclusionRegistryFromConfig
} from "../dist/index.js";

test("parseExclusionRule returns null when no exclusion keys present", () => {
  assert.equal(parseExclusionRule({ name: "m", call_template_type: "mcp" }), null);
  assert.equal(parseExclusionRule(null), null);
});

test("parseExclusionRule reads denylist and allowlist fields", () => {
  const rule = parseExclusionRule({
    name: "m",
    exclude_tools: ["a", "b"],
    include_tools: ["c"],
    default_disabled: true
  });
  assert.deepEqual(rule, { defaultDisabled: true, exclude: ["a", "b"], include: ["c"] });
});

test("parseExclusionRule defaults missing arrays and flag", () => {
  const rule = parseExclusionRule({ exclude_tools: ["a"] });
  assert.deepEqual(rule, { defaultDisabled: false, exclude: ["a"], include: [] });
});

test("stripExclusionKeys removes only the three custom keys", () => {
  const stripped = stripExclusionKeys({
    name: "m",
    call_template_type: "mcp",
    exclude_tools: ["a"],
    include_tools: ["b"],
    default_disabled: true
  });
  assert.deepEqual(stripped, { name: "m", call_template_type: "mcp" });
});

test("getManualNameFromToolName / getToolShortName split on first dot", () => {
  assert.equal(getManualNameFromToolName("proxyman_mcp.get_flows"), "proxyman_mcp");
  assert.equal(getManualNameFromToolName("solo"), "solo");
  assert.equal(getToolShortName("proxyman_mcp.get_flows", "proxyman_mcp"), "get_flows");
  assert.equal(getToolShortName("proxyman_mcp.srv.get_flows", "proxyman_mcp"), "srv.get_flows");
});

test("isToolExcluded denylist hides listed tools by short, full, or access name", () => {
  const registry = new Map([
    ["proxyman_mcp", { defaultDisabled: false, exclude: ["get_flows"], include: [] }]
  ]);
  assert.equal(isToolExcluded("proxyman_mcp.get_flows", "proxyman_mcp.get_flows", registry), true);
  assert.equal(isToolExcluded("proxyman_mcp.get_version", "proxyman_mcp.get_version", registry), false);
});

test("isToolExcluded allowlist hides everything except include list", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: true, exclude: [], include: ["mail_list"] }]
  ]);
  assert.equal(isToolExcluded("msgcli.mail_list", "msgcli.mail_list", registry), false);
  assert.equal(isToolExcluded("msgcli.mail_send", "msgcli.mail_send", registry), true);
});

test("isToolExcluded returns false when manual has no rule", () => {
  assert.equal(isToolExcluded("other.tool", "other.tool", new Map()), false);
});

test("isToolExcluded denylist matches 3-segment mcp names by bare tool name", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: false, exclude: ["mail_delete"], include: [] }]
  ]);
  // Real MCP canonical names are manual.server.tool; the config uses the bare tool name.
  assert.equal(isToolExcluded("msgcli.msgcli.mail_delete", "msgcli.msgcli_mail_delete", registry), true);
  // The clean alias form (manual.tool) also matches.
  assert.equal(isToolExcluded("msgcli.msgcli.mail_delete", "msgcli.mail_delete", registry), true);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_list", "msgcli.msgcli_mail_list", registry), false);
});

test("isToolExcluded allowlist on 3-segment mcp names keeps only bare-listed tools", () => {
  const registry = new Map([
    ["msgcli", { defaultDisabled: true, exclude: [], include: ["mail_list"] }]
  ]);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_list", "msgcli.msgcli_mail_list", registry), false);
  assert.equal(isToolExcluded("msgcli.msgcli.mail_send", "msgcli.msgcli_mail_send", registry), true);
});

test("applyManualExclusion records the rule and strips keys", () => {
  const registry = new Map();
  const sanitized = applyManualExclusion(registry, {
    name: "m",
    call_template_type: "mcp",
    exclude_tools: ["a"]
  });
  assert.deepEqual(sanitized, { name: "m", call_template_type: "mcp" });
  assert.deepEqual(registry.get("m"), { defaultDisabled: false, exclude: ["a"], include: [] });
});

test("applyManualExclusion clears a stale rule when keys removed", () => {
  const registry = new Map([["m", { defaultDisabled: false, exclude: ["a"], include: [] }]]);
  applyManualExclusion(registry, { name: "m", call_template_type: "mcp" });
  assert.equal(registry.has("m"), false);
});

test("buildExclusionRegistryFromConfig builds registry and sanitized config", () => {
  const raw = {
    manual_call_templates: [
      { name: "m1", call_template_type: "mcp", exclude_tools: ["x"] },
      { name: "m2", call_template_type: "http" }
    ]
  };
  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig(raw);
  assert.deepEqual(registry.get("m1"), { defaultDisabled: false, exclude: ["x"], include: [] });
  assert.equal(registry.has("m2"), false);
  assert.deepEqual(sanitizedConfig.manual_call_templates[0], { name: "m1", call_template_type: "mcp" });
  assert.deepEqual(sanitizedConfig.manual_call_templates[1], { name: "m2", call_template_type: "http" });
});

test("buildExclusionRegistryFromConfig tolerates missing manual_call_templates", () => {
  const { registry, sanitizedConfig } = buildExclusionRegistryFromConfig({});
  assert.equal(registry.size, 0);
  assert.deepEqual(sanitizedConfig, {});
});
