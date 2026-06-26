import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePin, loadPins, isPinned } from "../scripts/lib/host-import/pins.mjs";
import { buildPlan, selectManuals } from "../scripts/lib/host-import/plan.mjs";

test("parsePin handles plain and host-scoped forms", () => {
  assert.deepEqual(parsePin("memory"), { host: "*", name: "memory" });
  assert.deepEqual(parsePin("codex:context7"), { host: "codex", name: "context7" });
});

test("loadPins merges extra flags with no file", () => {
  const pins = loadPins(null, ["a", "claude-code:b"]);
  assert.deepEqual(pins, [{ host: "*", name: "a" }, { host: "claude-code", name: "b" }]);
});

test("isPinned matches any-host and scoped", () => {
  const pins = [{ host: "*", name: "a" }, { host: "codex", name: "b" }];
  assert.equal(isPinned(pins, { host: "codex", name: "a" }), true);
  assert.equal(isPinned(pins, { host: "codex", name: "b" }), true);
  assert.equal(isPinned(pins, { host: "claude-code", name: "b" }), false);
});

test("buildPlan marks pinned and selectManuals skips them", () => {
  const hosts = [
    { host: "codex", scope: "global", name: "memory", server: { command: "x" } },
    { host: "claude-code", scope: "global", name: "github", server: { command: "y" } },
  ];
  const plan = buildPlan(hosts, { manual_call_templates: [] }, [{ host: "*", name: "github" }]);
  const by = Object.fromEntries(plan.items.map((i) => [i.name, i]));
  assert.equal(by.github.pinned, true);
  assert.equal(by.memory.pinned, false);
  assert.deepEqual(selectManuals(plan).map((m) => m.name), ["memory"]);
});
