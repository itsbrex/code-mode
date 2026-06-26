import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile, pruneBackups, listBackups } from "../scripts/lib/host-import/backup.mjs";

test("backupFile copies into stamped dir, returns path", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "config.json");
  writeFileSync(f, '{"a":1}');
  const root = join(d, ".backups");
  const dest = backupFile(f, root, "2026-06-25T00-00-00");
  assert.equal(dest, join(root, "2026-06-25T00-00-00", "config.json"));
  assert.equal(readFileSync(dest, "utf8"), '{"a":1}');
});

test("backupFile returns null for missing file", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  assert.equal(backupFile(join(d, "nope.json"), join(d, ".b")), null);
});

test("pruneBackups keeps newest N", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "c.json");
  writeFileSync(f, "x");
  const root = join(d, ".backups");
  for (const s of ["2026-01-01", "2026-01-02", "2026-01-03"]) backupFile(f, root, s);
  pruneBackups(root, 2);
  const dirs = readdirSync(root).sort();
  assert.deepEqual(dirs, ["2026-01-02", "2026-01-03"]);
  assert.equal(existsSync(join(root, "2026-01-01")), false);
});

test("listBackups returns newest first", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "c.json");
  writeFileSync(f, "x");
  const root = join(d, ".backups");
  for (const s of ["2026-01-01", "2026-01-02"]) backupFile(f, root, s);
  assert.deepEqual(listBackups(root).map((b) => b.id), ["2026-01-02", "2026-01-01"]);
});

test("backupFile never clobbers an earlier backup in the same stamp", () => {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  const f = join(d, "config.json");
  const root = join(d, ".backups");
  writeFileSync(f, "v1");
  const first = backupFile(f, root, "SAME");
  writeFileSync(f, "v2");
  const second = backupFile(f, root, "SAME");
  assert.notEqual(first, second);
  assert.equal(readFileSync(first, "utf8"), "v1"); // pristine copy retained
  assert.equal(readFileSync(second, "utf8"), "v2");
});
