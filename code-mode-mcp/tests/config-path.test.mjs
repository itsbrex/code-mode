import test from "node:test";
import assert from "node:assert/strict";

import { resolveUtcpConfigPath } from "../config-path.mjs";

test("UTCP_CONFIG_FILE is canonical and UTCP_CONFIG_PATH is a legacy fallback", () => {
  assert.equal(
    resolveUtcpConfigPath({
      environment: { UTCP_CONFIG_FILE: "config/canonical.json" },
      cwd: "/workspace"
    }),
    "/workspace/config/canonical.json"
  );
  assert.equal(
    resolveUtcpConfigPath({
      environment: { UTCP_CONFIG_PATH: "config/legacy.json" },
      cwd: "/workspace"
    }),
    "/workspace/config/legacy.json"
  );
});

test("equal canonical and legacy paths across environment and dotenv are allowed", () => {
  assert.equal(
    resolveUtcpConfigPath({
      environment: {
        UTCP_CONFIG_FILE: "/workspace/config.json",
        UTCP_CONFIG_PATH: "/workspace/config.json"
      },
      dotenvValues: {
        UTCP_CONFIG_FILE: "/workspace/config.json",
        UTCP_CONFIG_PATH: "/workspace/config.json"
      },
      cwd: "/workspace"
    }),
    "/workspace/config.json"
  );
});

test("divergent config paths fail closed even when an explicit path is present", () => {
  assert.throws(
    () =>
      resolveUtcpConfigPath({
        explicit: "/workspace/explicit.json",
        environment: { UTCP_CONFIG_FILE: "/workspace/canonical.json" },
        dotenvValues: { UTCP_CONFIG_PATH: "/workspace/legacy.json" },
        cwd: "/workspace"
      }),
    /Conflicting UTCP config paths.*UTCP_CONFIG_FILE.*UTCP_CONFIG_PATH/
  );
});

test("explicit config path wins after configured values pass conflict validation", () => {
  assert.equal(
    resolveUtcpConfigPath({
      explicit: "explicit.json",
      environment: { UTCP_CONFIG_FILE: "/workspace/config.json" },
      dotenvValues: { UTCP_CONFIG_PATH: "/workspace/config.json" },
      cwd: "/workspace"
    }),
    "/workspace/explicit.json"
  );
});
