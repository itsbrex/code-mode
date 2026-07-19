// Namespaced-variable helpers for `utcp login` — how a manual's `${VAR}`
// reference maps to the dotenv key the UTCP SDK actually looks up.

/**
 * Re-derives the namespaced dotenv key UTCP looks up for `${var}` in a manual.
 *
 * The odd two-step replace is DELIBERATE: it byte-for-byte mirrors the UTCP
 * SDK's own derivation in UtcpClient._getVariable (@utcp/sdk dist/index.js:
 * `namespace.replace(/_/g, "!").replace(/!/g, "__") + "_" + key`). The net
 * effect is `_` → `__`, but a literal `!` in a manual name ALSO becomes `__` —
 * and because we must produce exactly the key the SDK will read, we reproduce
 * the quirk rather than "fix" it here.
 *
 * NOTE: the SDK is internally inconsistent — its `substitute()` path uses a
 * plain `namespace.replace(/_/g, "__")` (no `!` folding). The two agree for
 * every sane manual name (no literal `!`), which the SDK's own sanitization
 * guarantees in practice. Flagged upstream; if the SDK ever unifies, update
 * this to match and the parity test will catch any drift.
 */
export function namespacedKey(manualName: string, varName: string): string {
  return manualName.replace(/_/g, '!').replace(/!/g, '__') + '_' + varName;
}

/** Extracts the variable name from an `access_token` template like `"${MY_TOKEN}"`. */
export function varNameFromTemplate(accessToken: string): string | null {
  const m = /\$\{?([a-zA-Z0-9_]+)\}?/.exec(accessToken || '');
  return m ? m[1]! : null;
}
