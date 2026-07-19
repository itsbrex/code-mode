import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addManualsToUtcp, stripFromClaudeJson, stripFromCodexToml } from "../scripts/lib/host-import/apply.mjs";
import { removeManualsFromUtcp } from "../scripts/lib/host-import/eject.mjs";
import { manualToHostServer } from "../scripts/lib/host-import/from-utcp.mjs";

// A mutation helper that finds nothing to change must leave the target file
// byte-identical (no gratuitous reformat) and create no backup (no churn that
// prunes real backups out of the retention window).

test("stripFromClaudeJson is a no-op when no named server exists", () => {
  const d = mkdtempSync(join(tmpdir(), "noop-"));
  const p = join(d, ".claude.json");
  const original = JSON.stringify({ mcpServers: { keep: { command: "x" } } }); // deliberately unformatted
  writeFileSync(p, original);
  const res = stripFromClaudeJson(p, ["absent"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, []);
  assert.equal(res.backup, null);
  assert.equal(readFileSync(p, "utf8"), original);
  assert.ok(!existsSync(join(d, ".bk")));
});

test("stripFromCodexToml is a no-op when no named table exists", () => {
  const d = mkdtempSync(join(tmpdir(), "noop-"));
  const p = join(d, "config.toml");
  const original = '[mcp_servers.memory]\ncommand = "npx"\n';
  writeFileSync(p, original);
  const res = stripFromCodexToml(p, ["absent"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, []);
  assert.equal(res.backup, null);
  assert.equal(readFileSync(p, "utf8"), original);
  assert.ok(!existsSync(join(d, ".bk")));
});

test("addManualsToUtcp is a no-op when every manual is already present", () => {
  const d = mkdtempSync(join(tmpdir(), "noop-"));
  const p = join(d, "u.json");
  const original = JSON.stringify({ manual_call_templates: [{ name: "memory" }] });
  writeFileSync(p, original);
  const res = addManualsToUtcp(p, [{ name: "memory" }], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.added, []);
  assert.deepEqual(res.skipped, ["memory"]);
  assert.equal(res.backup, null);
  assert.equal(readFileSync(p, "utf8"), original);
  assert.ok(!existsSync(join(d, ".bk")));
});

test("removeManualsFromUtcp is a no-op when no named manual exists", () => {
  const d = mkdtempSync(join(tmpdir(), "noop-"));
  const p = join(d, "u.json");
  const original = JSON.stringify({ manual_call_templates: [{ name: "memory" }] });
  writeFileSync(p, original);
  const res = removeManualsFromUtcp(p, ["absent"], join(d, ".bk"), { stamp: "S" });
  assert.deepEqual(res.removed, []);
  assert.equal(res.backup, null);
  assert.equal(readFileSync(p, "utf8"), original);
  assert.ok(!existsSync(join(d, ".bk")));
});

test("manualToHostServer skips a malformed --header value with no colon", () => {
  const m = {
    name: "ctx",
    config: {
      mcpServers: {
        ctx: {
          command: "npx",
          args: ["-y", "mcp-remote", "https://x/mcp", "--header", "NotAHeader", "--header", "X-Key: abc"],
          env: {},
          transport: "stdio"
        }
      }
    }
  };
  // The colon-less value is dropped; the well-formed header still parses.
  assert.deepEqual(manualToHostServer(m), { name: "ctx", server: { url: "https://x/mcp", headers: { "X-Key": "abc" } } });
});
