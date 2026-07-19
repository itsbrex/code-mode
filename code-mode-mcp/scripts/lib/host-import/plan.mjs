import { existsSync, readFileSync } from "node:fs";
import { convertServer } from "./to-utcp.mjs";
import { isPinned } from "./pins.mjs";

// Canonical sanitizer shared by all scripts (re-exported for existing callers)
// — the UTCP SDK files tools under this sanitized form, so dedup must compare
// both spellings.
import { toManualIdentifier } from "../manual-name.mjs";
export { toManualIdentifier };

export function existingManualNames(utcpConfig) {
  const templates = Array.isArray(utcpConfig?.manual_call_templates) ? utcpConfig.manual_call_templates : [];
  const set = new Set();
  for (const t of templates) {
    if (typeof t?.name === "string") {
      set.add(t.name);
      set.add(toManualIdentifier(t.name));
    }
  }
  return set;
}

export function buildPlan(hosts, utcpConfig, pins = []) {
  const existing = existingManualNames(utcpConfig);
  const items = hosts.map((entry) => {
    const conv = convertServer(entry.name, entry.server);
    const duplicate = existing.has(entry.name) || existing.has(toManualIdentifier(entry.name));
    const pinned = isPinned(pins, entry);
    return {
      host: entry.host,
      scope: entry.scope,
      projectKey: entry.projectKey,
      name: entry.name,
      risk: conv.risk,
      reason: pinned ? "pinned — never touched" : duplicate ? "already present in the UTCP config" : conv.reason,
      duplicate,
      pinned,
      manual: conv.ok ? conv.manual : undefined,
      source: entry,
    };
  });
  return { items, existingNames: [...existing] };
}

export function selectManuals(plan, { risks = ["safe", "partial"] } = {}) {
  const allow = new Set(risks);
  const seen = new Set();
  const out = [];
  for (const item of plan.items) {
    if (item.duplicate || item.pinned || !item.manual || !allow.has(item.risk)) continue;
    if (seen.has(item.name)) continue; // same server in multiple hosts → emit once
    seen.add(item.name);
    out.push(item.manual);
  }
  return out;
}

export function readUtcpConfig(path) {
  if (!existsSync(path)) return { manual_call_templates: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { manual_call_templates: [] };
  }
}
