import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../scripts/host-import-cli.mjs";
import { ejectManuals } from "../scripts/lib/host-import/eject.mjs";
import { loadSources, recordSources } from "../scripts/lib/host-import/sources.mjs";

const manual = (name, server = { command: "fixture-server", args: [], transport: "stdio" }) => ({
  call_template_type: "mcp", name, config: { mcpServers: { [name]: server } }
});

function fixture(t, manuals = []) {
  const root = mkdtempSync(join(tmpdir(), "eject-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = parseArgs([], { environment: {}, dotenvValues: {}, home: root, cwd: root });
  opts.utcpPath = join(root, "config.json");
  opts.paths = { claudeCode: join(root, "claude.json"), claudeDesktop: join(root, "desktop.json"), codex: join(root, "codex.toml") };
  writeFileSync(opts.utcpPath, JSON.stringify({ manual_call_templates: manuals }));
  writeFileSync(opts.paths.claudeCode, '{"mcpServers":{}}');
  writeFileSync(opts.paths.claudeDesktop, '{"mcpServers":{}}');
  writeFileSync(opts.paths.codex, "");
  return opts;
}

test("ejection validates every selected manual before explicit or provenance-routed writes", async (t) => {
  for (const to of [["claude-code"], null]) {
    await t.test(to ? "explicit target" : "recorded targets", (t) => {
      const opts = fixture(t, [manual("memory"), { call_template_type: "http", name: "crm", url: "https://fixture.invalid/schema" }]);
      recordSources(opts.sourcesFile, "memory", opts.utcpPath, [{ host: "claude-desktop", scope: "global", name: "memory" }]);
      const files = [opts.utcpPath, ...Object.values(opts.paths), opts.sourcesFile];
      const before = files.map((file) => readFileSync(file, "utf8"));
      assert.throws(() => run({ ...opts, eject: ["memory", "crm"], to }), /cannot be ejected as a single MCP server/);
      assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
      assert.equal(existsSync(opts.backupRoot), false);
    });
  }
});

test("ejection refuses empty and multi-server MCP manuals without removing them", async (t) => {
  for (const [name, servers] of Object.entries({ empty: {}, malformed: { bad: {} }, multiple: { first: { command: "one" }, second: { command: "two" } } })) {
    await t.test(name, (t) => {
      const opts = fixture(t, [{ call_template_type: "mcp", name, config: { mcpServers: servers } }]);
      const before = readFileSync(opts.utcpPath, "utf8");
      assert.throws(() => run({ ...opts, eject: [name], to: ["claude-code"] }), /cannot be ejected as a single MCP server/);
      assert.equal(readFileSync(opts.utcpPath, "utf8"), before);
      assert.equal(readFileSync(opts.paths.claudeCode, "utf8"), '{"mcpServers":{}}');
    });
  }
});

test("ejection rejects unsupported target scopes before any host write", (t) => {
  const opts = fixture(t, [manual("memory")]);
  const before = readFileSync(opts.utcpPath, "utf8");
  assert.throws(() => ejectManuals(opts.utcpPath, ["memory"], [
    { host: "claude-desktop", scope: "global" }, { host: "claude-code", scope: "profile" }
  ], opts.paths, opts.backupRoot), /explicit supported host targets and project scope/);
  assert.equal(readFileSync(opts.utcpPath, "utf8"), before);
  assert.equal(readFileSync(opts.paths.claudeDesktop, "utf8"), '{"mcpServers":{}}');
});

test("malformed recorded target identities stop the complete ejection before writes", (t) => {
  for (const invalidSource of [
    { host: "claude-code", scope: "global", name: "" },
    { host: "claude-code", scope: "global", name: "   " },
    { host: "claude-code", scope: "project", projectKey: "   ", name: "second" }
  ]) {
    const opts = fixture(t, [manual("first"), manual("second")]);
    writeFileSync(opts.sourcesFile, JSON.stringify({ schemaVersion: 2, configs: {
      [opts.utcpPath]: {
        first: { sources: [{ host: "claude-desktop", scope: "global", name: "first" }] },
        second: { sources: [invalidSource] }
      }
    } }));
    const files = [opts.utcpPath, ...Object.values(opts.paths), opts.sourcesFile];
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.throws(() => run({ ...opts, eject: ["first", "second"] }), /Invalid provenance source/);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
    assert.equal(existsSync(opts.backupRoot), false);
  }
});

test("ejection restores raw source names and project scope without consuming another config's provenance", (t) => {
  const opts = fixture(t);
  const sourceName = "crm.sales-prod";
  const projectKey = "/fixture/project-one";
  const server = { command: "fixture-server", args: [] };
  writeFileSync(opts.paths.claudeCode, JSON.stringify({ mcpServers: {}, projects: { [projectKey]: { mcpServers: { [sourceName]: server } } } }));
  writeFileSync(opts.paths.claudeDesktop, JSON.stringify({ mcpServers: { [sourceName]: server } }));
  const imported = run({ ...opts, apply: true, stripHost: true });
  assert.equal(imported.applied.added.length, 1);
  const [name] = imported.applied.added;
  const otherConfig = join(tmpdir(), "unread-other-config.json");
  recordSources(opts.sourcesFile, name, otherConfig, [{ host: "codex", scope: "global", name: "other-source" }]);
  const result = run({ ...opts, eject: [name] });
  assert.deepEqual(result.removed, [name]);
  const restored = JSON.parse(readFileSync(opts.paths.claudeCode, "utf8"));
  assert.deepEqual(restored.mcpServers, {});
  assert.deepEqual(Object.keys(restored.projects[projectKey].mcpServers), [sourceName]);
  assert.equal(restored.projects[projectKey].mcpServers[sourceName].command, server.command);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(opts.paths.claudeDesktop, "utf8")).mcpServers), [sourceName]);
  assert.equal(readFileSync(opts.paths.codex, "utf8"), "");
  assert.deepEqual(loadSources(opts.sourcesFile, opts.utcpPath), {});
  assert.equal(loadSources(opts.sourcesFile, otherConfig)[name].sources[0].name, "other-source");
});
