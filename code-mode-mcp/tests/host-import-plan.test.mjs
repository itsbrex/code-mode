import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, existingManualNames, selectManuals, toManualIdentifier } from "../scripts/lib/host-import/plan.mjs";

const hosts = [
  { host: "codex", scope: "global", name: "memory", server: { command: "npx", args: ["-y", "m"] } },
  { host: "claude-code", scope: "global", name: "context7", server: { url: "https://x/mcp", headers: { K: "v" } } },
  { host: "claude-desktop", scope: "global", name: "code-mode", server: { command: "x" } },
  { host: "codex", scope: "global", name: "salesforce-mcp", server: { command: "sf" } }, // dup
];
const utcp = { manual_call_templates: [{ name: "salesforce-mcp" }] };

test("existingManualNames includes raw + sanitized", () => {
  const set = existingManualNames(utcp);
  assert.ok(set.has("salesforce-mcp"));
  assert.ok(set.has("salesforce_mcp"));
  assert.equal(toManualIdentifier("salesforce-mcp"), "salesforce_mcp");
});

test("buildPlan tags risk, duplicate, and emits manuals", () => {
  const { items } = buildPlan(hosts, utcp);
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.memory.risk, "safe");
  assert.equal(by.memory.duplicate, false);
  assert.equal(by.context7.risk, "partial");
  assert.equal(by["code-mode"].risk, "manual");
  assert.equal(by["code-mode"].manual, undefined);
  assert.equal(by["salesforce-mcp"].duplicate, true);
});

test("selectManuals defaults to non-duplicate safe+partial", () => {
  const plan = buildPlan(hosts, utcp);
  const names = selectManuals(plan).map((m) => m.name).sort();
  assert.deepEqual(names, ["context7", "memory"]);
});

test("selectManuals can narrow to safe only", () => {
  const plan = buildPlan(hosts, utcp);
  const names = selectManuals(plan, { risks: ["safe"] }).map((m) => m.name);
  assert.deepEqual(names, ["memory"]);
});

test("buildPlan fails closed when different host names sanitize to one manual identifier", () => {
  const plan = buildPlan(
    [
      { host: "codex", scope: "global", name: "my-server", server: { command: "a" } },
      { host: "claude-code", scope: "global", name: "my.server", server: { command: "b" } }
    ],
    { manual_call_templates: [] }
  );

  assert.equal(plan.items.every((item) => item.collision === true), true);
  assert.equal(plan.items.every((item) => item.risk === "manual"), true);
  assert.deepEqual(selectManuals(plan), []);
});
