import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

test("local HTTP boundary rejects rebound requests and imports the selected project source", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "config-api-"));
  const ctx = { configPath: join(root, "config.json"), hostPaths: { claudeCode: join(root, "claude.json"), claudeDesktop: join(root, "desktop.json"), codex: join(root, "codex.toml") }, sourcesFile: join(root, "sources.json"), pinsFile: join(root, "pins.json"), backupRoot: join(root, "backups") };
  const spec = (value) => ({ command: "fixture-server", args: value.includes("alpha") ? ["--fixture", "expanded"] : [], env: { API_TOKEN: value } });
  writeFileSync(ctx.configPath, '{"manual_call_templates":[]}');
  writeFileSync(ctx.hostPaths.claudeCode, JSON.stringify({ mcpServers: {}, projects: { "/fixture/a": { mcpServers: { memory: spec("fixture-secret-alpha-for-test") } }, "/fixture/b": { mcpServers: { memory: spec("fixture-secret-beta-for-test") } } } }));
  writeFileSync(ctx.hostPaths.claudeDesktop, '{"mcpServers":{}}');
  writeFileSync(ctx.hostPaths.codex, "");
  const op = join(root, "fake-op");
  const opLog = join(root, "op-called");
  const envFile = join(root, "fixture.env");
  writeFileSync(op, '#!/bin/sh\nprintf called > "$OP_CALLED_LOG"\nexit 0\n', { mode: 0o700 });
  writeFileSync(envFile, "# Synthetic file. No credentials.\n");
  const child = fork(fileURLToPath(new URL("./fixtures/config-builder-server.mjs", import.meta.url)), [JSON.stringify(ctx)], { execArgv: ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))], env: { PATH: process.env.PATH, OP_BIN: op, OP_CALLED_LOG: opLog, CODE_MODE_ENV_FILE: envFile }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  const [{ port }] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Fixture server failed to start"); })]);
  assert.equal(existsSync(opLog), false, "module import must not invoke credential tooling");
  function request(path, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
        let data = ""; res.on("data", (chunk) => data += chunk); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const manifest = await request("/api/manifest");
  assert.equal(manifest.status, 200);
  assert.equal((await request("/api/manifest", { headers: { host: `attacker.invalid:${port}` } })).status, 403);
  assert.equal((await request("/api/host-plan", { headers: { origin: "https://attacker.invalid" } })).status, 403);
  const headers = { origin: `http://127.0.0.1:${port}`, "x-config-builder-token": manifest.body.token, "content-type": "application/json" };
  assert.equal((await request("/api/host-apply", { method: "POST", headers: { ...headers, "x-config-builder-token": "wrong" }, body: { names: ["memory"] } })).status, 403);
  const before = await request("/api/host-plan");
  assert.notEqual(before.body.items[0].configHash, before.body.items[1].configHash);
  assert.ok(before.body.items.find((item) => item.projectKey === "/fixture/a").configFieldCount > before.body.items.find((item) => item.projectKey === "/fixture/b").configFieldCount, "automatic selection receives config detail counts rather than fixed-size hash lengths");
  const selected = { host: "claude-code", scope: "project", projectKey: "/fixture/b", name: "memory", configHash: before.body.items.find((item) => item.projectKey === "/fixture/b").configHash };
  assert.equal((await request("/api/host-apply", { method: "POST", headers, body: { selections: [{ ...selected, configHash: "stale" }] } })).status, 409);
  const applied = await request("/api/host-apply", { method: "POST", headers, body: { selections: [selected] } });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.added, ["memory"]);
  assert.match(readFileSync(join(root, "code-mode.env"), "utf8"), /fixture-secret-beta-for-test/);
  assert.doesNotMatch(readFileSync(join(root, "code-mode.env"), "utf8"), /fixture-secret-alpha-for-test/);
  const stripped = await request("/api/host-strip", { method: "POST", headers, body: { entries: [{ ...selected, projectKey: "/fixture/a" }, selected] } });
  assert.equal(stripped.body.refused.length, 1);
  const hosts = JSON.parse(readFileSync(ctx.hostPaths.claudeCode, "utf8"));
  assert.ok(hosts.projects["/fixture/a"].mcpServers.memory);
  assert.deepEqual(hosts.projects["/fixture/b"].mcpServers, {});
});
