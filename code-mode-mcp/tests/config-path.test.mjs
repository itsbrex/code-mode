import test from "node:test";
import assert from "node:assert/strict";
import { resolveUtcpConfigPath } from "../config-path.mjs";

test("canonical path resolves from environment or dotenv", () => {
  for (const source of ["environment", "dotenvValues"]) {
    assert.equal(resolveUtcpConfigPath({ [source]: { UTCP_CONFIG_FILE: "config/canonical.json" }, cwd: "/workspace" }), "/workspace/config/canonical.json");
  }
});

test("retired path key fails closed even when canonical or explicit paths exist", () => {
  for (const source of ["environment", "dotenvValues"]) {
    for (const value of ["/workspace/config.json", "/workspace/old.json"]) {
      assert.throws(() => resolveUtcpConfigPath({
        explicit: "/workspace/explicit.json",
        environment: { UTCP_CONFIG_FILE: "/workspace/config.json", ...(source === "environment" ? { UTCP_CONFIG_PATH: value } : {}) },
        dotenvValues: source === "dotenvValues" ? { UTCP_CONFIG_PATH: value } : {},
        cwd: "/workspace"
      }), /UTCP_CONFIG_PATH is no longer supported; use UTCP_CONFIG_FILE/);
    }
  }
  assert.throws(() => resolveUtcpConfigPath({ environment: { UTCP_CONFIG_PATH: "/workspace/old.json" } }), /UTCP_CONFIG_PATH is no longer supported/);
});

test("empty retired key does not block canonical configuration", () => {
  assert.equal(resolveUtcpConfigPath({ environment: { UTCP_CONFIG_FILE: "/workspace/config.json", UTCP_CONFIG_PATH: "" } }), "/workspace/config.json");
});

test("equal canonical paths across environment and dotenv are allowed", () => {
  assert.equal(resolveUtcpConfigPath({ environment: { UTCP_CONFIG_FILE: "/workspace/config.json" }, dotenvValues: { UTCP_CONFIG_FILE: "/workspace/config.json" }, cwd: "/workspace" }), "/workspace/config.json");
});

test("divergent canonical paths fail closed even with an explicit path", () => {
  assert.throws(() => resolveUtcpConfigPath({ explicit: "/workspace/explicit.json", environment: { UTCP_CONFIG_FILE: "/workspace/config.json" }, dotenvValues: { UTCP_CONFIG_FILE: "/workspace/other.json" } }), /Conflicting UTCP config paths.*environment UTCP_CONFIG_FILE.*dotenv UTCP_CONFIG_FILE/);
});

test("explicit path wins after configured values pass validation", () => {
  assert.equal(resolveUtcpConfigPath({ explicit: "explicit.json", environment: { UTCP_CONFIG_FILE: "/workspace/config.json" }, cwd: "/workspace" }), "/workspace/explicit.json");
});
