import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, linkSync, renameSync } from "node:fs";
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

test("ejection rejects colliding recorded destinations including aliased host files", (t) => {
  for (const aliasHosts of ["same-host", "same-file", "symlink", "hardlink"]) {
    const opts = fixture(t, [manual("first", { command: "first-server" }), manual("second", { command: "second-server" })]);
    if (aliasHosts === "same-file") opts.paths.claudeDesktop = opts.paths.claudeCode;
    if (aliasHosts === "symlink" || aliasHosts === "hardlink") {
      const alias = `${opts.paths.claudeDesktop}.alias`;
      if (aliasHosts === "hardlink") linkSync(opts.paths.claudeCode, alias);
      else symlinkSync(opts.paths.claudeCode, alias, "file");
      opts.paths.claudeDesktop = alias;
    }
    recordSources(opts.sourcesFile, "first", opts.utcpPath, [{ host: "claude-code", scope: "global", name: "shared" }]);
    recordSources(opts.sourcesFile, "second", opts.utcpPath, [{ host: aliasHosts === "same-host" ? "claude-code" : "claude-desktop", scope: "global", name: "shared" }]);
    const files = [opts.utcpPath, ...Object.values(opts.paths), opts.sourcesFile];
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.throws(() => run({ ...opts, eject: ["first", "second"] }), /destination collision/);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
    assert.equal(existsSync(opts.backupRoot), false);
  }
});

test("explicit ejection rejects two manuals mapped to the same target name", (t) => {
  const opts = fixture(t, [manual("first"), manual("second")]);
  const files = [opts.utcpPath, ...Object.values(opts.paths)];
  const before = files.map((file) => readFileSync(file, "utf8"));
  assert.throws(() => ejectManuals(opts.utcpPath, ["first", "second"], [
    { host: "claude-code", name: "shared" }
  ], opts.paths, opts.backupRoot), /destination collision/);
  assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
  assert.equal(existsSync(opts.backupRoot), false);
});

test("ejection detects dangling destination aliases before either path is created", (t) => {
  for (const chained of [false, true]) {
    const opts = fixture(t, [manual("first"), manual("second")]);
    opts.paths.claudeCode = `${opts.utcpPath}.new-host.json`;
    opts.paths.claudeDesktop = `${opts.utcpPath}.alias.json`;
    const intermediate = `${opts.utcpPath}.intermediate.json`;
    if (chained) symlinkSync(opts.paths.claudeCode, intermediate, "file");
    symlinkSync(chained ? intermediate : opts.paths.claudeCode, opts.paths.claudeDesktop, "file");
    recordSources(opts.sourcesFile, "first", opts.utcpPath, [{ host: "claude-code", scope: "global", name: "shared" }]);
    recordSources(opts.sourcesFile, "second", opts.utcpPath, [{ host: "claude-desktop", scope: "global", name: "shared" }]);
    const files = [opts.utcpPath, opts.sourcesFile];
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.throws(() => run({ ...opts, eject: ["first", "second"] }), /destination collision/);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
    assert.equal(existsSync(opts.paths.claudeCode), false);
    assert.equal(existsSync(opts.backupRoot), false);
  }
});

test("ejection conservatively rejects unresolved case-only destination aliases", (t) => {
  for (const mixedFormats of [false, true]) {
    const opts = fixture(t, [manual("first"), manual("second")]);
    opts.paths.claudeCode = `${opts.utcpPath}.Host.json`;
    const secondPath = `${opts.utcpPath}.host.json`;
    if (mixedFormats) opts.paths.codex = secondPath;
    else opts.paths.claudeDesktop = secondPath;
    recordSources(opts.sourcesFile, "first", opts.utcpPath, [{ host: "claude-code", scope: "global", name: "shared" }]);
    recordSources(opts.sourcesFile, "second", opts.utcpPath, [{ host: mixedFormats ? "codex" : "claude-desktop", scope: "global", name: "shared" }]);
    const files = [opts.utcpPath, opts.sourcesFile];
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.throws(() => run({ ...opts, eject: ["first", "second"] }), /destination collision|Host formats cannot share/);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
    assert.equal(existsSync(opts.paths.claudeCode), false);
    assert.equal(existsSync(secondPath), false);
    assert.equal(existsSync(opts.backupRoot), false);
  }
});

test("existing case-distinct destinations use their actual file identities", (t) => {
  const opts = fixture(t, [manual("first", { command: "first-server" }), manual("second", { command: "second-server" })]);
  opts.paths.claudeCode = `${opts.utcpPath}.Host.json`;
  opts.paths.claudeDesktop = `${opts.utcpPath}.host.json`;
  writeFileSync(opts.paths.claudeCode, '{"mcpServers":{}}');
  const caseInsensitive = existsSync(opts.paths.claudeDesktop);
  if (!caseInsensitive) writeFileSync(opts.paths.claudeDesktop, '{"mcpServers":{}}', { flag: "wx" });
  recordSources(opts.sourcesFile, "first", opts.utcpPath, [{ host: "claude-code", scope: "global", name: "shared" }]);
  recordSources(opts.sourcesFile, "second", opts.utcpPath, [{ host: "claude-desktop", scope: "global", name: "shared" }]);
  if (caseInsensitive) {
    const files = [opts.utcpPath, opts.paths.claudeCode, opts.sourcesFile];
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.throws(() => run({ ...opts, eject: ["first", "second"] }), /destination collision/);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
  } else {
    const result = run({ ...opts, eject: ["first", "second"] });
    assert.deepEqual(result.removed, ["first", "second"]);
    assert.equal(JSON.parse(readFileSync(opts.paths.claudeCode, "utf8")).mcpServers.shared.command, "first-server");
    assert.equal(JSON.parse(readFileSync(opts.paths.claudeDesktop, "utf8")).mcpServers.shared.command, "second-server");
  }
});

test("import and ejection share provenance across real and symlink config paths", (t) => {
  for (const importViaAlias of [false, true]) {
    const opts = fixture(t);
    const alias = `${opts.utcpPath}.alias`;
    symlinkSync(opts.utcpPath, alias, "file");
    writeFileSync(opts.paths.claudeDesktop, JSON.stringify({ mcpServers: { memory: { command: "fixture-server" } } }));
    run({ ...opts, utcpPath: importViaAlias ? alias : opts.utcpPath, apply: true, stripHost: true });
    assert.deepEqual(JSON.parse(readFileSync(opts.paths.claudeDesktop, "utf8")).mcpServers, {});
    const replacement = `${opts.utcpPath}.replacement`;
    writeFileSync(replacement, readFileSync(opts.utcpPath));
    renameSync(replacement, opts.utcpPath);
    const result = run({ ...opts, utcpPath: importViaAlias ? opts.utcpPath : alias, eject: ["memory"] });
    assert.deepEqual(result.ejected[0].wroteTo, ["claude-desktop"]);
    assert.equal(JSON.parse(readFileSync(opts.paths.claudeDesktop, "utf8")).mcpServers.memory.command, "fixture-server");
    assert.deepEqual(JSON.parse(readFileSync(opts.paths.claudeCode, "utf8")).mcpServers, {});
    assert.deepEqual(loadSources(opts.sourcesFile, alias), {});
    assert.deepEqual(loadSources(opts.sourcesFile, opts.utcpPath), {});
  }
});

test("existing version-2 alias provenance is consumed through the real config path", (t) => {
  const opts = fixture(t, [manual("memory")]);
  const alias = `${opts.utcpPath}.alias`;
  symlinkSync(opts.utcpPath, alias, "file");
  writeFileSync(opts.sourcesFile, JSON.stringify({ schemaVersion: 2, configs: {
    [alias]: { memory: { utcpPath: alias, sources: [{ host: "claude-desktop", scope: "global", name: "raw-memory" }] } }
  } }));
  const result = run({ ...opts, eject: ["memory"] });
  assert.deepEqual(result.ejected[0].wroteTo, ["claude-desktop"]);
  assert.equal(JSON.parse(readFileSync(opts.paths.claudeDesktop, "utf8")).mcpServers["raw-memory"].command, "fixture-server");
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(opts.sourcesFile, "utf8")).configs, alias), false);
  assert.deepEqual(loadSources(opts.sourcesFile, alias), {});
});

test("conflicting provenance aliases fail before an ejection writes any file", (t) => {
  const opts = fixture(t, [manual("memory")]);
  const alias = `${opts.utcpPath}.alias`;
  symlinkSync(opts.utcpPath, alias, "file");
  writeFileSync(opts.sourcesFile, JSON.stringify({ schemaVersion: 2, configs: {
    [opts.utcpPath]: { memory: { sources: [{ host: "claude-code", scope: "global", name: "first" }] } },
    [alias]: { memory: { sources: [{ host: "claude-desktop", scope: "global", name: "second" }] } }
  } }));
  const files = [opts.utcpPath, ...Object.values(opts.paths), opts.sourcesFile];
  const before = files.map((file) => readFileSync(file, "utf8"));
  assert.throws(() => run({ ...opts, eject: ["memory"] }), /Conflicting provenance aliases/);
  assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
  assert.equal(existsSync(opts.backupRoot), false);
});

test("ejection refuses mixed host formats sharing one destination file", (t) => {
  const opts = fixture(t, [manual("memory")]);
  opts.paths.codex = opts.paths.claudeCode;
  recordSources(opts.sourcesFile, "memory", opts.utcpPath, [
    { host: "claude-code", scope: "global", name: "memory" },
    { host: "codex", scope: "global", name: "memory" }
  ]);
  const files = [opts.utcpPath, ...Object.values(opts.paths), opts.sourcesFile];
  const before = files.map((file) => readFileSync(file, "utf8"));
  assert.throws(() => run({ ...opts, eject: ["memory"] }), /Host formats cannot share/);
  assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
  assert.equal(existsSync(opts.backupRoot), false);
});

test("ejection keeps identical raw names in distinct project scopes independent", (t) => {
  const opts = fixture(t, [manual("first", { command: "first-server" }), manual("second", { command: "second-server" })]);
  for (const name of ["first", "second"]) {
    recordSources(opts.sourcesFile, name, opts.utcpPath, [{ host: "claude-code", scope: "project", projectKey: `/fixture/${name}`, name: "shared" }]);
  }
  const result = run({ ...opts, eject: ["first", "second"] });
  assert.deepEqual(result.removed, ["first", "second"]);
  const restored = JSON.parse(readFileSync(opts.paths.claudeCode, "utf8"));
  assert.equal(restored.projects["/fixture/first"].mcpServers.shared.command, "first-server");
  assert.equal(restored.projects["/fixture/second"].mcpServers.shared.command, "second-server");
  assert.deepEqual(loadSources(opts.sourcesFile, opts.utcpPath), {});
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
