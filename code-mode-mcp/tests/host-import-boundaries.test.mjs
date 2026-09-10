import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../scripts/host-import-cli.mjs";
import { loadSources, recordSources, removeSources } from "../scripts/lib/host-import/sources.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "host-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = parseArgs([], { environment: {}, dotenvValues: {}, home: root, cwd: root });
  opts.utcpPath = join(root, "config.json");
  opts.paths = { claudeCode: join(root, "claude.json"), claudeDesktop: join(root, "desktop.json"), codex: join(root, "codex.toml") };
  writeFileSync(opts.utcpPath, '{"manual_call_templates":[]}');
  writeFileSync(opts.paths.claudeCode, '{"mcpServers":{}}');
  writeFileSync(opts.paths.claudeDesktop, '{"mcpServers":{}}');
  writeFileSync(opts.paths.codex, "");
  return { root, opts };
}

test("same-name sources with different harvested values are not stripped or merged", (t) => {
  const { root, opts } = fixture(t);
  const spec = (token) => ({ command: "fixture-server", args: [], env: { API_TOKEN: token } });
  writeFileSync(opts.paths.claudeCode, JSON.stringify({ mcpServers: { memory: spec("fixture-secret-alpha-for-test") } }));
  const desktop = JSON.stringify({ mcpServers: { memory: spec("fixture-secret-beta-for-test") } });
  writeFileSync(opts.paths.claudeDesktop, desktop);
  run({ ...opts, apply: true, stripHost: true });
  assert.deepEqual(JSON.parse(readFileSync(opts.paths.claudeCode, "utf8")).mcpServers, {});
  assert.equal(readFileSync(opts.paths.claudeDesktop, "utf8"), desktop);
  const sources = loadSources(opts.sourcesFile, opts.utcpPath).memory.sources;
  assert.deepEqual(sources.map((s) => s.host), ["claude-code"]);
  assert.match(readFileSync(join(root, "code-mode.env"), "utf8"), /fixture-secret-alpha-for-test/);
  assert.doesNotMatch(readFileSync(join(root, "code-mode.env"), "utf8"), /fixture-secret-beta-for-test/);
});

test("provenance remains independent across configs and preserves private atomic storage", (t) => {
  const { root, opts } = fixture(t);
  const second = join(root, "second.json");
  recordSources(opts.sourcesFile, "memory", opts.utcpPath, [{ host: "claude-code", scope: "global" }]);
  recordSources(opts.sourcesFile, "memory", second, [{ host: "codex", scope: "global" }]);
  assert.deepEqual(loadSources(opts.sourcesFile, opts.utcpPath).memory.sources.map((s) => s.host), ["claude-code"]);
  assert.deepEqual(loadSources(opts.sourcesFile, second).memory.sources.map((s) => s.host), ["codex"]);
  removeSources(opts.sourcesFile, ["memory"], second);
  assert.equal(loadSources(opts.sourcesFile, opts.utcpPath).memory.sources.length, 1);
  assert.deepEqual(loadSources(opts.sourcesFile, second), {});
  assert.equal(statSync(opts.sourcesFile).mode & 0o777, 0o600);
});

test("legacy provenance is scoped on read and retained during migration", (t) => {
  const { root, opts } = fixture(t);
  writeFileSync(opts.sourcesFile, JSON.stringify({ sources: { memory: { utcpPath: opts.utcpPath, sources: [{ host: "claude-code", scope: "global" }] } } }));
  const second = join(root, "second.json");
  assert.deepEqual(loadSources(opts.sourcesFile, second), {});
  recordSources(opts.sourcesFile, "memory", second, [{ host: "codex", scope: "global" }]);
  assert.equal(loadSources(opts.sourcesFile, opts.utcpPath).memory.sources[0].host, "claude-code");
});

test("corrupt provenance stops import before changing config or host files", (t) => {
  const { opts } = fixture(t);
  writeFileSync(opts.paths.claudeCode, '{"mcpServers":{"memory":{"command":"fixture-server"}}}');
  writeFileSync(opts.sourcesFile, "{broken");
  const before = readFileSync(opts.utcpPath, "utf8");
  assert.throws(() => run({ ...opts, apply: true, stripHost: true }));
  assert.equal(readFileSync(opts.utcpPath, "utf8"), before);
  assert.match(readFileSync(opts.paths.claudeCode, "utf8"), /fixture-server/);
});

test("a fresh import replaces orphaned provenance before later ejection", (t) => {
  const { opts } = fixture(t);
  recordSources(opts.sourcesFile, "memory", opts.utcpPath, [{ host: "claude-code", scope: "global", name: "memory" }]);
  writeFileSync(opts.paths.claudeDesktop, '{"mcpServers":{"memory":{"command":"fixture-server"}}}');
  run({ ...opts, apply: true });
  assert.deepEqual(loadSources(opts.sourcesFile, opts.utcpPath).memory.sources.map((source) => source.host), ["claude-desktop"]);
  run({ ...opts, eject: ["memory"] });
  assert.deepEqual(JSON.parse(readFileSync(opts.paths.claudeCode, "utf8")).mcpServers, {});
});
