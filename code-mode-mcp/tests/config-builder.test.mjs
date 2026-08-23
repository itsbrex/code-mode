import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { parseCliConfigArg, resolveConfigPath, withAllManualsEnabled } from "../scripts/lib/utcp-config.mjs";
import { buildConfig, stripExclusionKeys } from "../scripts/config-builder/serialize.js";

/* ------------------------------------------------------------ lib helpers */

test("parseCliConfigArg reads positional, --config, --config=, and -c forms", () => {
  assert.equal(parseCliConfigArg(["node", "s", "/p/x.json"]), "/p/x.json");
  assert.equal(parseCliConfigArg(["node", "s", "--config", "/p/y.json"]), "/p/y.json");
  assert.equal(parseCliConfigArg(["node", "s", "--config=/p/z.json"]), "/p/z.json");
  assert.equal(parseCliConfigArg(["node", "s", "-c", "/p/w.json"]), "/p/w.json");
  assert.equal(parseCliConfigArg(["node", "s", "--no-open"]), undefined);
});

test("resolveConfigPath: explicit arg wins over environment and resolves absolute", () => {
  const prev = process.env.UTCP_CONFIG_PATH;
  const prevFile = process.env.UTCP_CONFIG_FILE;
  process.env.UTCP_CONFIG_PATH = "/abs/from-env.json";
  // Pin the canonical var too so the ambient shell env (which may point both
  // vars at different files and trip the fail-closed conflict guard) can't
  // leak into this test. Divergent-path behavior is covered in
  // config-path.test.mjs; here both vars agree and explicit still wins.
  process.env.UTCP_CONFIG_FILE = "/abs/from-env.json";
  try {
    assert.equal(resolveConfigPath("/abs/explicit.json"), path.resolve("/abs/explicit.json"));
  } finally {
    if (prev === undefined) delete process.env.UTCP_CONFIG_PATH;
    else process.env.UTCP_CONFIG_PATH = prev;
    if (prevFile === undefined) delete process.env.UTCP_CONFIG_FILE;
    else process.env.UTCP_CONFIG_FILE = prevFile;
  }
});

test("withAllManualsEnabled flips enabled/disabled on manuals + mcpServers without mutating input", () => {
  const cfg = {
    manual_call_templates: [
      { name: "a", enabled: false, config: { mcpServers: { s1: { command: "x", disabled: true } } } },
      { name: "b", disabled: true }
    ]
  };
  const out = withAllManualsEnabled(cfg);

  // input untouched
  assert.equal(cfg.manual_call_templates[0].enabled, false);
  assert.equal(cfg.manual_call_templates[0].config.mcpServers.s1.disabled, true);

  // output force-enabled
  assert.equal(out.manual_call_templates[0].enabled, true);
  assert.equal("disabled" in out.manual_call_templates[0].config.mcpServers.s1, false);
  assert.equal(out.manual_call_templates[0].config.mcpServers.s1.enabled, true);
  assert.equal(out.manual_call_templates[1].enabled, true);
  assert.equal("disabled" in out.manual_call_templates[1], false);
});

/* -------------------------------------------------------------- serialize */

const base = {
  x: 1,
  manual_call_templates: [
    { name: "m1", call_template_type: "mcp", exclude_tools: ["stale"] },
    { name: "m2", call_template_type: "http" }
  ]
};
const manuals = [
  { name: "m1", tools: [{ name: "m1.s.a" }, { name: "m1.s.b" }] },
  { name: "m2", tools: [{ name: "m2.s.c" }] }
];
const dec = (o = {}) => ({ defaultDisabled: false, removed: false, hidden: new Set(), ...o });

test("stripExclusionKeys removes only the three custom keys", () => {
  assert.deepEqual(stripExclusionKeys({ name: "m", exclude_tools: [], include_tools: [], default_disabled: true, keep: 1 }), {
    name: "m",
    keep: 1
  });
});

test("buildConfig denylist writes exclude_tools for hidden tools and preserves base keys", () => {
  const decisions = new Map([["m1", dec({ hidden: new Set(["m1.s.a"]) })], ["m2", dec()]]);
  const out = buildConfig(base, manuals, decisions);
  assert.equal(out.x, 1);
  assert.deepEqual(out.manual_call_templates[0], { name: "m1", call_template_type: "mcp", exclude_tools: ["m1.s.a"] });
  assert.deepEqual(out.manual_call_templates[1], { name: "m2", call_template_type: "http" });
});

test("buildConfig allowlist writes default_disabled + include_tools for exposed tools", () => {
  const decisions = new Map([["m1", dec({ defaultDisabled: true, hidden: new Set(["m1.s.a"]) })], ["m2", dec()]]);
  const out = buildConfig(base, manuals, decisions);
  assert.deepEqual(out.manual_call_templates[0], {
    name: "m1",
    call_template_type: "mcp",
    default_disabled: true,
    include_tools: ["m1.s.b"]
  });
});

test("buildConfig passthrough strips any stale exclusion keys when nothing is hidden", () => {
  const decisions = new Map([["m1", dec()], ["m2", dec()]]);
  const out = buildConfig(base, manuals, decisions);
  assert.deepEqual(out.manual_call_templates[0], { name: "m1", call_template_type: "mcp" });
  assert.equal("exclude_tools" in out.manual_call_templates[0], false);
});

test("buildConfig drops manuals marked for removal", () => {
  const decisions = new Map([["m1", dec({ removed: true })], ["m2", dec()]]);
  const out = buildConfig(base, manuals, decisions);
  assert.equal(out.manual_call_templates.length, 1);
  assert.equal(out.manual_call_templates[0].name, "m2");
});

test("buildConfig emits templates in the supplied manual order", () => {
  const decisions = new Map([["m1", dec()], ["m2", dec()]]);
  const out = buildConfig(base, [manuals[1], manuals[0]], decisions);
  assert.deepEqual(out.manual_call_templates.map((t) => t.name), ["m2", "m1"]);
});
