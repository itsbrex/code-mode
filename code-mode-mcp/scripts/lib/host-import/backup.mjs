import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";

// Copy `file` into `backupRoot/<stamp>/<basename>`. stamp is injectable so tests
// stay deterministic; in production it defaults to a filesystem-safe ISO time.
export function backupFile(file, backupRoot, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  if (!existsSync(file)) return null;
  const dir = join(backupRoot, stamp);
  mkdirSync(dir, { recursive: true });
  const base = basename(file);
  let dest = join(dir, base);
  // One run can back up the same file more than once within a single stamp
  // window (e.g. global + project strips of ~/.claude.json land in the same
  // millisecond). Never clobber an earlier backup — suffix so the pristine
  // copy is always retained.
  if (existsSync(dest)) {
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    let n = 1;
    do {
      dest = join(dir, `${stem}.${n}${ext}`);
      n += 1;
    } while (existsSync(dest));
  }
  copyFileSync(file, dest);
  return dest;
}

export function pruneBackups(backupRoot, keep = 30) {
  if (!existsSync(backupRoot)) return;
  const dirs = readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    rmSync(join(backupRoot, name), { recursive: true, force: true });
  }
}

export function listBackups(backupRoot) {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, path: join(backupRoot, d.name) }))
    .sort((a, b) => b.id.localeCompare(a.id));
}
