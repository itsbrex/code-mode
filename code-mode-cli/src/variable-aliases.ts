// Bare-name fallback for namespaced UTCP variables.
//
// UTCP resolves a manual's `${VAR}` against a NAMESPACED key: inside manual `m`
// it reads `m_VAR`, and an underscore in the manual name doubles, so manual
// `keep_rest` reads `keep__rest_VAR` (see namespacedKey()). `utcp login` writes
// that spelling, but a hand-written or generated `.env` almost always holds the
// bare `VAR` — and the failure is a registration-time
// `UtcpVariableNotFoundError: keep__rest_KEEP_API_KEY`, which names a key the
// author never typed.
//
// So when a referenced namespaced key is missing and the bare one is present,
// alias it. A namespaced key that already resolves is never overridden, so a
// config that deliberately isolates per-manual credentials keeps doing so.
import path from 'path';
import { promises as fs } from 'fs';
import { namespacedKey } from './env.js';

export interface AliasResult {
  /** Namespaced key -> value, to merge into the client config's `variables`. */
  variables: Record<string, string>;
  /** `namespaced <- bare` pairs, for logging. Never includes values. */
  notes: string[];
}

type AnyRecord = Record<string, any>;

const VAR_REF = /\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)/g;

/** Collects every `${VAR}` / `$VAR` name referenced anywhere inside a value. */
function collectVarRefs(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes('$ref')) return; // the SDK skips these too
    VAR_REF.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_REF.exec(value)) !== null) out.add((m[1] || m[2])!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVarRefs(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectVarRefs(item, out);
  }
}

/** Minimal dotenv reader: `KEY=value`, `export KEY=value`, # comments, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Loads every dotenv file the config declares, in declaration order. */
async function loadDeclaredDotenvs(
  config: AnyRecord,
  scriptDir: string,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  const loaders = config?.load_variables_from;
  if (!Array.isArray(loaders)) return merged;
  for (const loader of loaders) {
    if (loader?.variable_loader_type !== 'dotenv') continue;
    const file = loader?.env_file_path;
    if (typeof file !== 'string' || !file) continue;
    try {
      const text = await fs.readFile(path.resolve(scriptDir, file), 'utf-8');
      Object.assign(merged, parseDotenv(text));
    } catch {
      /* a missing .env is not an error here — the SDK reports it in context */
    }
  }
  return merged;
}

/**
 * Builds namespaced aliases for bare-named variables the manuals reference.
 * Reads the config's dotenv files and `process.env`; never writes anything.
 */
export async function buildVariableAliases(
  config: Record<string, unknown>,
  scriptDir: string,
): Promise<AliasResult> {
  const result: AliasResult = { variables: {}, notes: [] };
  const manuals = (config as AnyRecord)?.manual_call_templates;
  if (!Array.isArray(manuals)) return result;

  const declared = ((config as AnyRecord).variables ?? {}) as Record<string, string>;
  const dotenv = await loadDeclaredDotenvs(config as AnyRecord, scriptDir);
  const lookup = (key: string): string | undefined =>
    declared[key] ?? dotenv[key] ?? process.env[key] ?? undefined;

  for (const manual of manuals as AnyRecord[]) {
    const name = manual?.name;
    if (!manual || typeof name !== 'string' || !name) continue;
    const refs = new Set<string>();
    collectVarRefs(manual, refs);
    for (const varName of refs) {
      const key = namespacedKey(name, varName);
      if (lookup(key) !== undefined || result.variables[key] !== undefined) continue;
      const bare = lookup(varName);
      if (bare === undefined) continue; // genuinely missing — let the SDK say so
      result.variables[key] = bare;
      result.notes.push(`${key} <- ${varName}`);
    }
  }
  return result;
}
