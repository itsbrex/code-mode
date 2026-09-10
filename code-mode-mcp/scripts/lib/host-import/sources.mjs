import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Import provenance sidecar (~/.host-import-sources.json).
 *
 * The UTCP client config schema is strict (unrecognized top-level keys are
 * rejected by UtcpClientConfigSerializer, and call templates likewise), so
 * provenance cannot ride inside the UTCP config itself. Like the pins file,
 * it lives in the home directory instead:
 *
 *   { "sources": { "<manualName>": {
 *       "utcpPath": "/abs/config.json",
 *       "importedAt": "2026-08-25T…",
 *       "sources": [{ "host": "claude-code", "scope": "global",
 *                     "projectKey": "…?", "name": "<raw host name>" }]
 *   } } }
 *
 * When identical same-named servers are found on several hosts, ONE manual is
 * imported and every host is recorded here — so `--eject <name>` without
 * `--to` knows every client the server originally came from.
 */

export function loadSources(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data.sources === "object" && data.sources !== null ? data.sources : {};
  } catch {
    return {};
  }
}

const sourceKey = (s) => `${s.host}|${s.scope || "global"}|${s.projectKey || ""}`;

/** Merge-record the source hosts for one imported manual (unique per host/scope). */
export function recordSources(file, manualName, utcpPath, sources) {
  if (!file || !manualName) return loadSources(file);
  const all = loadSources(file);
  const prev = all[manualName]?.sources ?? [];
  const seen = new Set(prev.map(sourceKey));
  const merged = [...prev];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s.host !== "string") continue;
    const entry = { host: s.host, scope: s.scope === "project" ? "project" : "global" };
    if (s.projectKey) entry.projectKey = s.projectKey;
    if (s.name) entry.name = s.name;
    if (seen.has(sourceKey(entry))) continue;
    seen.add(sourceKey(entry));
    merged.push(entry);
  }
  all[manualName] = { utcpPath, importedAt: new Date().toISOString(), sources: merged };
  writeFileSync(file, JSON.stringify({ sources: all }, null, 2) + "\n");
  return all;
}

/** Drop provenance for ejected/removed manuals. */
export function removeSources(file, manualNames) {
  const all = loadSources(file);
  let touched = false;
  for (const n of Array.isArray(manualNames) ? manualNames : [manualNames]) {
    if (n in all) {
      delete all[n];
      touched = true;
    }
  }
  if (touched && file) writeFileSync(file, JSON.stringify({ sources: all }, null, 2) + "\n");
  return all;
}

/** Key-order-independent stringify, for "is this the same config?" comparisons. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
