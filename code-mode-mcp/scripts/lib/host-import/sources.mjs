import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hosts = new Set(["claude-code", "claude-desktop", "codex"]);

function readStore(file) {
  if (!file) return { schemaVersion: 2, configs: {} };
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("Provenance symlinks are not supported");
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 2, configs: {} };
    throw error;
  }
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Invalid provenance JSON"); }
  if (!object(data)) throw new Error("Invalid provenance object");
  let configs;
  if (data.schemaVersion === 2 && object(data.configs)) configs = data.configs;
  else if (data.schemaVersion === undefined && object(data.sources)) {
    // Migrate legacy entries while retaining each config's identity.
    configs = Object.create(null);
    for (const [name, entry] of Object.entries(data.sources)) {
      if (!object(entry) || typeof entry.utcpPath !== "string") throw new Error("Invalid legacy provenance");
      const key = resolve(entry.utcpPath);
      if (!own(configs, key)) configs[key] = Object.create(null);
      configs[key][name] = entry;
    }
  } else throw new Error("Unsupported provenance format");
  for (const [config, entries] of Object.entries(configs)) {
    if (resolve(config) !== config || !object(entries)) throw new Error("Invalid provenance config");
    for (const entry of Object.values(entries)) {
      if (!object(entry) || !Array.isArray(entry.sources)) throw new Error("Invalid provenance sources");
      for (const source of entry.sources) {
        if (!object(source) || !hosts.has(source.host) || !["global", "project"].includes(source.scope) ||
          (source.scope === "project" && (source.host !== "claude-code" || typeof source.projectKey !== "string" || !source.projectKey)) ||
          (source.name !== undefined && typeof source.name !== "string") ||
          (source.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(source.fingerprint))) throw new Error("Invalid provenance source");
      }
    }
  }
  return { schemaVersion: 2, configs };
}

export function loadSources(file, utcpPath) {
  const store = readStore(file);
  if (!utcpPath) {
    const values = Object.values(store.configs);
    if (values.length > 1) throw new Error("Select a UTCP config when reading provenance");
    return values[0] ?? {};
  }
  const key = resolve(utcpPath);
  return own(store.configs, key) ? store.configs[key] : {};
}

function saveStore(file, store) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
const sourceKey = (s) => JSON.stringify([s.host, s.scope, s.projectKey ?? "", s.name ?? ""]);

export function recordSources(file, manualName, utcpPath, sources) {
  if (!file || !manualName) return loadSources(file, utcpPath);
  const store = readStore(file);
  const key = resolve(utcpPath);
  const all = own(store.configs, key) ? store.configs[key] : {};
  const prev = own(all, manualName) ? all[manualName].sources : [];
  const merged = new Map(prev.map((s) => [sourceKey(s), s]));
  for (const s of sources) {
    if (!hosts.has(s.host)) throw new Error("Invalid provenance host");
    const entry = { host: s.host, scope: s.scope === "project" ? "project" : "global",
      ...(s.projectKey ? { projectKey: s.projectKey } : {}), ...(s.name ? { name: s.name } : {}),
      ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}) };
    merged.set(sourceKey(entry), entry);
  }
  const updated = { ...all, [manualName]: { utcpPath: key, importedAt: new Date().toISOString(), sources: [...merged.values()] } };
  store.configs = { ...store.configs, [key]: updated };
  saveStore(file, store);
  return updated;
}

export function removeSources(file, manualNames, utcpPath) {
  const store = readStore(file);
  const key = utcpPath ? resolve(utcpPath) : Object.keys(store.configs).length === 1 ? Object.keys(store.configs)[0] : undefined;
  if (!key) {
    if (Object.keys(store.configs).length) throw new Error("Select a UTCP config when removing provenance");
    return {};
  }
  const all = own(store.configs, key) ? store.configs[key] : {};
  let touched = false;
  for (const name of Array.isArray(manualNames) ? manualNames : [manualNames]) {
    if (own(all, name)) { delete all[name]; touched = true; }
  }
  if (touched && file) saveStore(file, store);
  return all;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Include harvested values when comparing sources, but expose only a digest.
export function planItemFingerprint(item) {
  const harvested = [...(item.harvested ?? [])].sort((a, b) => a.var.localeCompare(b.var));
  return createHash("sha256").update(stableStringify({ manual: item.manual ?? item.source?.server ?? null, harvested })).digest("hex");
}
