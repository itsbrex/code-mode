// Config normalization for @utcp/* 1.1.x.
//
// Two fields are mandatory in practice but easy to leave out of a hand-written
// or generated call template, and both fail in ways that do not point at the
// template:
//
//   1. `transport` on an mcp manual's server entry. @utcp/mcp dispatches on it
//      and throws "Unsupported MCP transport: 'undefined'" when it is missing.
//
//   2. `auth_tools` on an http (OpenAPI) manual that has `auth`. The OpenAPI
//      converter authenticates the spec fetch with `auth`, but copies
//      `auth_tools` onto each generated tool — so with `auth` alone the spec
//      loads, every tool registers, and every call goes out unauthenticated
//      (typically a 401 that reads like a bad credential).
//
// Both are recoverable from the template itself, so normalize instead of failing.

export interface NormalizeResult<T> {
  value: T;
  /** Human-readable description of each field that was filled in. */
  changes: string[];
}

type AnyRecord = Record<string, any>;

const HTTP_TYPES = new Set(["http", "streamable-http", "streamable_http", "sse"]);

/** Infers an MCP transport from the shape of a server entry. */
export function inferMcpTransport(server: AnyRecord): string | undefined {
  const declared = typeof server?.type === "string" ? server.type.toLowerCase() : "";
  if (HTTP_TYPES.has(declared)) return "http";
  if (typeof server?.command === "string" && server.command) return "stdio";
  if (typeof server?.url === "string" && server.url) return "http";
  return undefined;
}

/** Fills in `transport` / `auth_tools` on a single manual call template, in place. */
function normalizeTemplateInPlace(manual: AnyRecord, changes: string[]): void {
  if (!manual || typeof manual !== "object") return;
  const name = typeof manual.name === "string" ? manual.name : "<unnamed>";

  if (manual.call_template_type === "mcp") {
    const servers = manual.config?.mcpServers;
    if (!servers || typeof servers !== "object") return;
    for (const [serverName, server] of Object.entries(servers as AnyRecord)) {
      if (!server || typeof server !== "object") continue;
      if (typeof server.transport === "string" && server.transport) continue;
      const transport = inferMcpTransport(server);
      if (!transport) continue;
      server.transport = transport;
      changes.push(`${name}: mcpServers.${serverName}.transport="${transport}"`);
    }
    return;
  }

  if (manual.call_template_type === "http" && manual.auth && !manual.auth_tools) {
    manual.auth_tools = JSON.parse(JSON.stringify(manual.auth));
    changes.push(`${name}: auth_tools mirrored from auth`);
  }
}

/** Returns a normalized deep copy of one manual call template. */
export function normalizeManualCallTemplate(
  template: Record<string, unknown>
): NormalizeResult<Record<string, unknown>> {
  const changes: string[] = [];
  if (!template || typeof template !== "object") return { value: template, changes };
  const value = JSON.parse(JSON.stringify(template)) as AnyRecord;
  normalizeTemplateInPlace(value, changes);
  return { value, changes };
}

/** Returns a normalized deep copy of a whole UTCP client config. */
export function normalizeUtcpConfig(
  raw: Record<string, unknown>
): NormalizeResult<Record<string, unknown>> {
  const changes: string[] = [];
  const value: AnyRecord = raw ? (JSON.parse(JSON.stringify(raw)) as AnyRecord) : {};
  const manuals = value.manual_call_templates;
  if (!Array.isArray(manuals)) return { value, changes };
  for (const manual of manuals as AnyRecord[]) normalizeTemplateInPlace(manual, changes);
  return { value, changes };
}
