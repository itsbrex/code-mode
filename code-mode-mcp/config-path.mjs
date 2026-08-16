import path from "node:path";

const CONFIG_KEYS = ["UTCP_CONFIG_FILE", "UTCP_CONFIG_PATH"];

function configuredEntries(environment, dotenvValues, cwd) {
  const entries = [];
  for (const key of CONFIG_KEYS) {
    for (const [source, values] of [
      ["environment", environment],
      ["dotenv", dotenvValues]
    ]) {
      const value = values?.[key];
      if (typeof value === "string" && value.length > 0) {
        entries.push({ key, source, path: path.resolve(cwd, value) });
      }
    }
  }
  return entries;
}

/**
 * Resolve selected UTCP config without allowing divergent canonical/legacy
 * values to choose different files in different consumers.
 */
export function resolveUtcpConfigPath({
  explicit,
  environment = {},
  dotenvValues = {},
  cwd = process.cwd()
} = {}) {
  const entries = configuredEntries(environment, dotenvValues, cwd);
  const uniquePaths = new Set(entries.map((entry) => entry.path));
  if (uniquePaths.size > 1) {
    const sources = entries
      .map((entry) => `${entry.source} ${entry.key}`)
      .join(", ");
    throw new Error(`Conflicting UTCP config paths: ${sources}`);
  }

  if (typeof explicit === "string" && explicit.length > 0) {
    return path.resolve(cwd, explicit);
  }

  return entries[0]?.path;
}
