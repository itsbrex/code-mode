import test from "node:test";
import assert from "node:assert/strict";

import { safeJsonStringify } from "../dist/index.js";

/* Regression: recursive tool schemas (e.g. Salesforce SOSL/SOQL filter
   grammar) get their $refs dereferenced into live object cycles by
   @utcp/mcp. Discovery serialization must never crash on those. */

test("safeJsonStringify leaves acyclic output byte-identical to JSON.stringify", () => {
  const value = { a: 1, b: { c: [1, 2, 3], d: "x" }, e: null };
  assert.equal(safeJsonStringify(value, 2), JSON.stringify(value, null, 2));
});

test("safeJsonStringify preserves legitimate shared (DAG) references", () => {
  const shared = { kind: "leaf" };
  const value = { left: shared, right: shared };
  // Shared-but-acyclic reuse must be fully serialized on BOTH branches,
  // not collapsed to a [Circular] marker.
  const out = JSON.parse(safeJsonStringify(value, 0));
  assert.deepEqual(out, { left: { kind: "leaf" }, right: { kind: "leaf" } });
});

test("safeJsonStringify breaks a self-referential cycle instead of throwing", () => {
  const node = { type: "object" };
  node.self = node; // direct cycle
  const text = safeJsonStringify(node, 0);
  assert.match(text, /\[Circular\]/);
  assert.doesNotThrow(() => JSON.parse(text));
});

test("safeJsonStringify handles a deep recursive-schema cycle", () => {
  // Mirrors a dereferenced recursive JSON Schema: condition -> or[] -> condition
  const condition = { type: "object", properties: {} };
  condition.properties.or = { type: "array", items: condition };
  const schema = { type: "object", properties: { filter: condition } };
  const text = safeJsonStringify(schema, 0);
  assert.match(text, /\[Circular\]/);
  const parsed = JSON.parse(text);
  assert.equal(parsed.properties.filter.type, "object");
});
