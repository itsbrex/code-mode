import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/src/args.js";

test("defaults: bare invocation is help", () => {
  const a = parseArgs([]);
  assert.equal(a.command, "help");
  assert.deepEqual(a.positionals, []);
  assert.equal(a.paste, false);
  assert.equal(a.offline, false);
  assert.equal(a.manualMode, false);
});

test("command + positionals + value flags", () => {
  const a = parseArgs(["search", "send", "slack", "message", "--limit", "5", "--config", "/tmp/c.json"]);
  assert.equal(a.command, "search");
  assert.deepEqual(a.positionals, ["send", "slack", "message"]);
  assert.equal(a.limit, 5);
  assert.equal(a.config, "/tmp/c.json");
});

test("run flags: -c / --file / --timeout", () => {
  const a = parseArgs(["run", "-c", "return 1", "--timeout", "5000"]);
  assert.equal(a.command, "run");
  assert.equal(a.code, "return 1");
  assert.equal(a.timeout, 5000);
});

test("login flags: --paste and --code", () => {
  const a = parseArgs(["login", "github", "--paste", "--code", "abc123"]);
  assert.equal(a.command, "login");
  assert.deepEqual(a.positionals, ["github"]);
  assert.equal(a.paste, true);
  assert.equal(a.authCode, "abc123");
});

test("validate flags: --offline and --manual", () => {
  const a = parseArgs(["validate", "--offline", "--manual", "m1.json", "m2.json"]);
  assert.equal(a.command, "validate");
  assert.equal(a.offline, true);
  assert.equal(a.manualMode, true);
  assert.deepEqual(a.positionals, ["m1.json", "m2.json"]);
});
