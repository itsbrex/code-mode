import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Resolve existing and dangling aliases without creating anything. lstat keeps
// a dangling link visible when realpath cannot yet resolve its final target.
// Native realpath also recovers filesystem spelling for existing case aliases.
export function canonicalFilePath(file) {
  let current = resolve(file);
  for (let links = 0; links < 40; links += 1) {
    try { return realpathSync.native(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const suffix = [];
    let ancestor = current;
    let stat;
    for (;;) {
      try { stat = lstatSync(ancestor); break; }
      catch (error) {
        const parent = dirname(ancestor);
        if (error.code !== "ENOENT" || parent === ancestor) throw error;
        suffix.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    if (stat.isSymbolicLink()) {
      current = resolve(dirname(ancestor), readlinkSync(ancestor), ...suffix);
    } else {
      return resolve(realpathSync.native(ancestor), ...suffix);
    }
  }
  throw new Error("File alias chain exceeds the resolution limit");
}

// Destination checks are transient, so inode identity can also catch existing
// hard links. Provenance uses canonical paths to survive atomic file replacement.
export function destinationFileIdentity(file) {
  const canonical = canonicalFilePath(file);
  try {
    const stat = statSync(canonical, { bigint: true });
    if (!stat.isFile()) throw new Error("Ejection destination must be a regular file");
    if (stat.ino !== 0n) return `inode:${stat.dev}:${stat.ino}`;
    return `path:${canonical}`;
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  // Missing names have no inode yet. Anchor them to the real existing parent,
  // then compare unresolved components conservatively without writing a probe
  // file or assuming the volume's case/Unicode rules from the operating system.
  const suffix = [basename(canonical)];
  let ancestor = dirname(canonical);
  for (;;) {
    try {
      const stat = statSync(ancestor, { bigint: true });
      if (!stat.isDirectory()) throw new Error("Ejection destination parent must be a directory");
      const parent = stat.ino !== 0n ? `inode:${stat.dev}:${stat.ino}` : `path:${canonicalFilePath(ancestor)}`;
      const folded = suffix.map((part) => part.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC"));
      return `missing:${parent}:${JSON.stringify(folded)}`;
    } catch (error) {
      const parent = dirname(ancestor);
      if (error.code !== "ENOENT" || parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
