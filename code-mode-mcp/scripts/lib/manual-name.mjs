/**
 * CANONICAL manual-name → identifier sanitizer for the scripts side.
 *
 * Mirrors the UTCP SDK's sanitization: the SDK files discovered tools under
 * this sanitized form of the manual name (e.g. "salesforce-mcp" →
 * "salesforce_mcp.<tool>"), so any code matching config template names back to
 * discovered tools must compare both spellings. Drift between sanitizer copies
 * caused the FIX_ME #9 phantom-orphan-manual bug — this module is the single
 * source of truth for .mjs consumers.
 *
 * Keep in sync with tool-exclusion.ts sanitizeManualName (the TS-side
 * canonical copy) — tests/sanitizer-parity.test.mjs asserts they agree.
 */
export function toManualIdentifier(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}
