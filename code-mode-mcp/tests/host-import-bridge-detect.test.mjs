import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodeModeBridge, convertServer } from "../scripts/lib/host-import/to-utcp.mjs";
import { buildPlan } from "../scripts/lib/host-import/plan.mjs";

test("isCodeModeBridge: exact-name denylist", () => {
  assert.equal(isCodeModeBridge("code-mode", { command: "node" }), true);
  assert.equal(isCodeModeBridge("attio-code-mode-mcp", {}), true);
});

test("isCodeModeBridge: code-mode substring in command/args (paths, packages, env files)", () => {
  assert.equal(isCodeModeBridge("linkedin", {
    command: "/usr/local/bin/op",
    args: ["run", "--env-file=/x/linkedin-code-mode-mcp/.env", "--", "node", "dist/index.js"]
  }), true);
  assert.equal(isCodeModeBridge("x", { command: "npx", args: ["-y", "@itsbrex/code-mode-mcp"] }), true);
});

test("isCodeModeBridge: UTCP config env vars", () => {
  assert.equal(isCodeModeBridge("anything", { command: "node", args: ["/srv/app.js"], env: { UTCP_CONFIG_FILE: "/x.json" } }), true);
  assert.equal(isCodeModeBridge("anything", { command: "node", env: { UTCP_CONFIG_PATH: "/x.json" } }), true);
});

test("isCodeModeBridge: content probe finds wire markers in the entry script", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  const entry = join(d, "index.js");
  writeFileSync(entry, 'server.tool("call_tool_chain", async () => {});\n');
  assert.equal(isCodeModeBridge("mybridge", { command: "node", args: [entry] }), true);
});

test("isCodeModeBridge: content probe follows relative imports one level", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  mkdirSync(join(d, "server"));
  const entry = join(d, "index.js");
  writeFileSync(entry, 'import { startStdioServer } from "./server/stdio.js";\nstartStdioServer();\n');
  writeFileSync(join(d, "server", "stdio.js"), 'registerTool("call_tool_chain");\n');
  assert.equal(isCodeModeBridge("forked-bridge", { command: "node", args: [entry] }), true);
});

test("isCodeModeBridge: plain servers stay plain", () => {
  const d = mkdtempSync(join(tmpdir(), "brdg-"));
  const entry = join(d, "plain.js");
  writeFileSync(entry, 'import { x } from "./missing.js";\nconsole.log("hello mcp server");\n');
  assert.equal(isCodeModeBridge("memory", { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }), false);
  assert.equal(isCodeModeBridge("local", { command: "node", args: [entry] }), false);
  assert.equal(isCodeModeBridge("remote", { url: "https://mcp.context7.com/mcp" }), false);
});

test("bridge probing follows bare, dynamic, and CommonJS relative imports", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs");
  writeFileSync(join(root, "bridge.mjs"), 'registerTool("call_tool_chain");');
  for (const source of ['import "./bridge.mjs";', 'await import("./bridge.mjs");', 'require ( "./bridge.mjs" );']) {
    writeFileSync(entry, source);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, source);
  }
});

test("bridge probing parses literal import syntax instead of matching source text", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs");
  writeFileSync(join(root, "bridge.js"), 'registerTool("call_tool_chain");');
  for (const source of [
    'require(`./bridge.js`);', 'await import(`./bridge.js`);',
    'require("./bridge\\u002Ejs");', 'require /* comment */ ("./bridge.js");',
    'export * from "./bridge.js";', 'import type { Item } from "./plain.js"; import bridge = require("./bridge.js");',
    'const view = <span />; await import(`./bridge.js`);',
  ]) {
    writeFileSync(entry, source);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, source);
  }
});

test("bridge probing ignores comment/string decoys and evaluated template imports", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs");
  writeFileSync(join(root, "bridge.js"), 'registerTool("call_tool_chain");');
  for (const source of [
    '// require("./bridge.js");',
    `const example = ${JSON.stringify('require("./bridge.js")')};`,
    'const name = "bridge"; import(`./${name}.js`);',
  ]) {
    writeFileSync(entry, source);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), false, source);
  }
});

test("bridge probing pins literal module.require delegates without evaluating member names", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  writeFileSync(join(root, "bridge.js"), 'throw new Error("must not execute"); // call_tool_chain');
  const server = { command: "node", args: [entry] };
  for (const source of [
    'module.require("./bridge");', 'module /* comment */ . require(`./bridge`);',
    'module["require"]("./bridge");', 'module[`require`]("./bridge");',
    'module?.require?.("./bridge");', 'module?.["require"]("./bridge");',
  ]) {
    writeFileSync(entry, source);
    const { items } = buildPlan([{ host: "claude-code", scope: "global", name: "fixture", server }], { manual_call_templates: [] }, []);
    assert.equal(items[0].bridge, true, source);
    assert.equal(items[0].manual, undefined, source);
  }
  for (const source of [
    'other.require("./bridge");', 'module[method]("./bridge");',
    'module["re" + "quire"]("./bridge");', '// module.require("./bridge");',
    `const example = ${JSON.stringify('module.require("./bridge")')};`,
  ]) {
    writeFileSync(entry, source);
    assert.equal(isCodeModeBridge("fixture", server), false, source);
  }
});

test("ESM bridge imports use URL path semantics without changing CommonJS paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs");
  writeFileSync(join(root, "bridge.mjs"), 'registerTool("call_tool_chain");');
  const spec = { command: "node", args: [entry] };
  for (const relative of ["./bridge.mjs?version=1", "./bridge.mjs#worker", "./%62ridge.mjs?version=1#worker"]) {
    writeFileSync(entry, `import ${JSON.stringify(relative)};`);
    assert.equal(isCodeModeBridge("fixture", spec), true, relative);
  }
  writeFileSync(entry, 'require("./bridge.mjs?version=1");');
  assert.equal(isCodeModeBridge("fixture", spec), false, "CommonJS treats the question mark as a filename character");
  writeFileSync(entry, 'import "./invalid%2Fbridge.mjs";');
  assert.equal(isCodeModeBridge("fixture", spec), false, "invalid encoded separators do not crash a scan");
});

test("CommonJS directory metadata accepts the UTF-8 BOM accepted by Node", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder", "package.json"), "\uFEFF" + JSON.stringify({ main: "bridge.js" }));
  writeFileSync(join(root, "folder", "bridge.js"), 'registerTool("call_tool_chain");');
  writeFileSync(entry, 'require("./folder");');
  assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true);
});

test("bridge probing follows the real entry location and preserves logical symlink mode", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "real"));
  const entry = join(root, "real", "entry.mjs");
  const link = join(root, "linked.mjs");
  writeFileSync(entry, 'import "./bridge.mjs";');
  writeFileSync(join(root, "real", "bridge.mjs"), 'registerTool("call_tool_chain");');
  symlinkSync(entry, link, "file");
  assert.equal(isCodeModeBridge("fixture", { command: "node", args: [link] }), true);
  writeFileSync(join(root, "real", "bridge.mjs"), 'export const plain = true;');
  writeFileSync(join(root, "bridge.mjs"), 'registerTool("call_tool_chain");');
  assert.equal(isCodeModeBridge("fixture", { command: "node", args: ["--preserve-symlinks-main", link] }), true);
});

test("CommonJS bridge probing resolves extensionless files and directory entrypoints without execution", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  const marker = 'throw new Error("probe must not execute modules"); // call_tool_chain';
  writeFileSync(join(root, "bridge.js"), marker);
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder", "index.js"), marker);
  mkdirSync(join(root, "package", "lib"), { recursive: true });
  writeFileSync(join(root, "package", "package.json"), JSON.stringify({ main: "lib/start" }));
  writeFileSync(join(root, "package", "lib", "start.js"), marker);
  mkdirSync(join(root, "directory-main", "lib"), { recursive: true });
  writeFileSync(join(root, "directory-main", "package.json"), JSON.stringify({ main: "lib" }));
  writeFileSync(join(root, "directory-main", "lib", "index.js"), marker);
  for (const relative of ["./bridge", "./folder", "./package", "./directory-main"]) {
    writeFileSync(entry, `require(${JSON.stringify(relative)});`);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, relative);
  }
});

test("CommonJS bridge probing honors file priority and fresh package metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  const spec = { command: "node", args: [entry] };
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder.js"), 'module.exports = "plain";');
  writeFileSync(join(root, "folder", "index.js"), 'registerTool("call_tool_chain");');
  writeFileSync(entry, 'require("./folder");');
  assert.equal(isCodeModeBridge("fixture", spec), false, "an existing .js file wins over the directory");
  writeFileSync(entry, 'require("./folder/");');
  assert.equal(isCodeModeBridge("fixture", spec), true, "a trailing slash selects the directory");
  writeFileSync(entry, 'require("./folder");');
  rmSync(join(root, "folder.js"));
  assert.equal(isCodeModeBridge("fixture", spec), true);
  const packagePath = join(root, "folder", "package.json");
  writeFileSync(join(root, "folder", "plain.js"), 'module.exports = "plain";');
  writeFileSync(packagePath, JSON.stringify({ main: "plain.js" }));
  assert.equal(isCodeModeBridge("fixture", spec), false);
  writeFileSync(packagePath, JSON.stringify({ main: "index.js" }));
  assert.equal(isCodeModeBridge("fixture", spec), true, "package entrypoint replacement must not use the Node resolver cache");
});

test("CommonJS probing uses directory index for non-string package main values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder", "index.js"), 'registerTool("call_tool_chain");');
  writeFileSync(entry, 'require("./folder");');
  for (const main of [3, true, {}, [], null, false, 0]) {
    writeFileSync(join(root, "folder", "package.json"), JSON.stringify({ main }));
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, JSON.stringify(main));
  }
});

test("CommonJS probing preserves terminal dot-segment directory intent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.cjs");
  mkdirSync(join(root, "folder", "child"), { recursive: true });
  writeFileSync(join(root, "folder.js"), 'module.exports = "plain";');
  writeFileSync(join(root, "folder", "index.js"), 'registerTool("call_tool_chain");');
  for (const relative of ["./folder/.", "./folder/child/.."]) {
    writeFileSync(entry, `require(${JSON.stringify(relative)});`);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, relative);
  }
  writeFileSync(join(root, "index.js"), 'registerTool("call_tool_chain");');
  for (const relative of [".", "./"]) {
    writeFileSync(entry, `require(${JSON.stringify(relative)});`);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [entry] }), true, relative);
  }
  const childEntry = join(root, "folder", "entry.cjs");
  for (const relative of ["..", "../"]) {
    writeFileSync(childEntry, `require(${JSON.stringify(relative)});`);
    assert.equal(isCodeModeBridge("fixture", { command: "node", args: [childEntry] }), true, relative);
  }
});

test("bridge probing observes replacements of entries and imported modules", (t) => {
  const root = mkdtempSync(join(tmpdir(), "brdg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs");
  const child = join(root, "child.mjs");
  const spec = { command: "node", args: [entry] };
  writeFileSync(entry, 'console.log("plain");');
  assert.equal(isCodeModeBridge("fixture", spec), false);
  writeFileSync(entry, 'registerTool("call_tool_chain");');
  assert.equal(isCodeModeBridge("fixture", spec), true);
  writeFileSync(entry, 'import { start } from "./child.mjs";');
  writeFileSync(child, 'export const start = () => {};');
  assert.equal(isCodeModeBridge("fixture", spec), false);
  writeFileSync(child, 'registerTool("call_tool_chain");');
  assert.equal(isCodeModeBridge("fixture", spec), true);
});

test("convertServer refuses a detected bridge with bridge:true", () => {
  const conv = convertServer("brandjet", { command: "node", args: ["/x.js"], env: { UTCP_CONFIG_FILE: "/c.json" } });
  assert.equal(conv.ok, false);
  assert.equal(conv.bridge, true);
  assert.match(conv.reason, /auto-detected/);
});

test("buildPlan: bridge outranks duplicate — never migratable, reason says bridge", () => {
  const hosts = [{
    host: "claude-code", scope: "global", name: "hookmark",
    server: { command: "node", args: ["/x/hook.js"], env: { UTCP_CONFIG_FILE: "/c.json" } }
  }];
  const utcp = { manual_call_templates: [{ name: "hookmark" }] }; // federated name collision
  const { items } = buildPlan(hosts, utcp, []);
  assert.equal(items[0].bridge, true);
  assert.equal(items[0].duplicate, true);
  assert.equal(items[0].manual, undefined);
  assert.match(items[0].reason, /bridge/);
});
