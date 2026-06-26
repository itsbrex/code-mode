import { existsSync, readFileSync } from "node:fs";

// Pin string forms: "name" (any host) | "host:name" (specific host).
export function parsePin(str) {
  const s = String(str);
  const i = s.indexOf(":");
  if (i === -1) return { host: "*", name: s.trim() };
  return { host: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
}

export function loadPins(path, extra = []) {
  const pins = [];
  if (path && existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      for (const p of data.pins ?? []) {
        if (typeof p === "string") pins.push(parsePin(p));
        else if (p && typeof p.name === "string") pins.push({ host: p.host || "*", name: p.name });
      }
    } catch {
      /* malformed pins file → no pins */
    }
  }
  for (const s of extra) pins.push(parsePin(s));
  return pins;
}

export function isPinned(pins, entry) {
  return pins.some((p) => p.name === entry.name && (p.host === "*" || p.host === entry.host));
}
