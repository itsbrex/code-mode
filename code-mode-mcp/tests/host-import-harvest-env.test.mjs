import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHarvestedEnv, envFormsFor } from "../scripts/lib/host-import/apply.mjs";

test("envFormsFor emits plain + sanitized + dashes-doubled forms", () => {
  assert.deepEqual(envFormsFor("the-swarm", "THE_SWARM_API_KEY").sort(), [
    "THE_SWARM_API_KEY",
    "the__swarm_THE_SWARM_API_KEY",
    "the_swarm_THE_SWARM_API_KEY",
  ].sort());
  assert.deepEqual(envFormsFor("memory", "TOK"), ["TOK", "memory_TOK"]);
});

test("appendHarvestedEnv appends missing forms, 0600, never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "harvest."));
  const envPath = join(dir, "code-mode.env");
  writeFileSync(envPath, "EXISTING_KEY=oldvalue\n");

  const r1 = appendHarvestedEnv(
    envPath,
    [
      { manual: "svc", var: "SVC_API_KEY", value: "sk_0123456789abcdef" },
      { manual: "svc", var: "EXISTING_KEY", value: "different" },
    ],
    join(dir, "backups"),
  );
  assert.ok(r1.written.includes("SVC_API_KEY"));
  assert.ok(r1.written.includes("svc_SVC_API_KEY"));
  assert.ok(r1.conflicts.includes("EXISTING_KEY")); // differing value untouched
  const text = readFileSync(envPath, "utf8");
  assert.match(text, /^EXISTING_KEY=oldvalue$/m);
  assert.match(text, /^SVC_API_KEY=sk_0123456789abcdef$/m);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);

  // idempotent: same entries again → nothing new written
  const r2 = appendHarvestedEnv(
    envPath,
    [{ manual: "svc", var: "SVC_API_KEY", value: "sk_0123456789abcdef" }],
    join(dir, "backups"),
  );
  assert.equal(r2.written.length, 0);
  assert.ok(r2.skipped.length >= 1);
});
