import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Resolve existing and dangling aliases without creating anything. lstat keeps
// a dangling link visible when realpath cannot yet resolve its final target.
export function canonicalFilePath(file) {
  let current = resolve(file);
  for (let links = 0; links < 40; links += 1) {
    try { return realpathSync(current); }
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
      return resolve(realpathSync(ancestor), ...suffix);
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
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return `path:${canonical}`;
}
