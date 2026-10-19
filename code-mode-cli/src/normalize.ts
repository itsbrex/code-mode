// Config normalization for @utcp/* 1.1.x.
//
// Two fields are mandatory in practice but easy to leave out of a hand-written
// or generated .utcp_config.json, and both fail in ways that do not point at
// the config:
//
//   1. `transport` on an mcp manual's server entry. @utcp/mcp dispatches on it
//      and throws "Unsupported MCP transport: 'undefined'" when it is missing.
//
//   2. `auth_tools` on an http (OpenAPI) manual that has `auth`. The OpenAPI
//      converter authenticates the spec fetch with `auth`, but copies
//      `auth_tools` onto each generated tool — so with `auth` alone the spec
//      loads, every tool registers, and every call goes out unauthenticated
//      (typically a 401 that looks like a bad key).
//
// Both are recoverable from the config itself, so normalize instead of failing.

export interface NormalizeResult {
  config: Record<string, unknown>;
  /** Human-readable description of each field that was filled in. */
  changes: string[];
}

type AnyRecord = Record<string, any>;

const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamable_http', 'sse']);

/** Infers an MCP transport from the shape of a server entry. */
export function inferTransport(server: AnyRecord): string | undefined {
  const declared = typeof server?.type === 'string' ? server.type.toLowerCase() : '';
  if (HTTP_TYPES.has(declared)) return 'http';
  if (typeof server?.command === 'string' && server.command) return 'stdio';
  if (typeof server?.url === 'string' && server.url) return 'http';
  return undefined;
}

/**
 * Returns a deep copy of `raw` with `transport` and `auth_tools` filled in where
 * they can be inferred. The input object is never mutated.
 */
export function normalizeUtcpConfig(raw: Record<string, unknown>): NormalizeResult {
  const changes: string[] = [];
  const config: AnyRecord = raw ? JSON.parse(JSON.stringify(raw)) : {};
  const manuals = config.manual_call_templates;
  if (!Array.isArray(manuals)) return { config, changes };

  for (const manual of manuals as AnyRecord[]) {
    if (!manual || typeof manual !== 'object') continue;
    const name = typeof manual.name === 'string' ? manual.name : '<unnamed>';

    if (manual.call_template_type === 'mcp') {
      const servers = manual.config?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [serverName, server] of Object.entries(servers as AnyRecord)) {
          if (!server || typeof server !== 'object') continue;
          if (typeof server.transport === 'string' && server.transport) continue;
          const transport = inferTransport(server);
          if (!transport) continue;
          server.transport = transport;
          changes.push(`${name}: mcpServers.${serverName}.transport="${transport}"`);
        }
      }
      continue;
    }

    if (manual.call_template_type === 'http' && manual.auth && !manual.auth_tools) {
      manual.auth_tools = JSON.parse(JSON.stringify(manual.auth));
      changes.push(`${name}: auth_tools mirrored from auth`);
    }
  }

  return { config, changes };
}
