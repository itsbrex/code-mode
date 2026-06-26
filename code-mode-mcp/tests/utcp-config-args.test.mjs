import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliConfigArg } from "../scripts/lib/utcp-config.mjs";

const argv = (...rest) => ["node", "script.mjs", ...rest];

test("parseCliConfigArg returns an explicit positional config path", () => {
  assert.equal(parseCliConfigArg(argv("/abs/c.utcp_config.json")), "/abs/c.utcp_config.json");
});

test("parseCliConfigArg reads --config / -c / --config=", () => {
  assert.equal(parseCliConfigArg(argv("--config", "/a.json")), "/a.json");
  assert.equal(parseCliConfigArg(argv("-c", "/b.json")), "/b.json");
  assert.equal(parseCliConfigArg(argv("--config=/c.json")), "/c.json");
});

test("parseCliConfigArg does NOT mistake --port/--host values for the path", () => {
  // the regression: `--port 7833` used to return "7833" as the config path
  assert.equal(parseCliConfigArg(argv("--no-open", "--port", "7833")), undefined);
  assert.equal(parseCliConfigArg(argv("--host", "127.0.0.1", "--port", "7821")), undefined);
});

test("parseCliConfigArg still finds a real positional alongside value-flags", () => {
  assert.equal(parseCliConfigArg(argv("/cfg.json", "--port", "7833")), "/cfg.json");
  assert.equal(parseCliConfigArg(argv("--port", "7833", "/cfg.json")), "/cfg.json");
});
