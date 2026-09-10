import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "content";
const server = new Server(
  { name: "adapter-compat-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
const booleanSchema = {
  type: "object",
  properties: {
    first: { $ref: "#/$defs/shared" },
    second: { $ref: "#/$defs/shared" }
  },
  $defs: {
    anything: true,
    nothing: false,
    shared: {
      type: "object",
      properties: {
        anything: { $ref: "#/$defs/anything" },
        nothing: { $ref: "#/$defs/nothing" }
      },
      uniqueItems: true
    }
  }
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["mixed", "structured"].map((name) => ({
    name,
    description: "Synthetic adapter compatibility fixture",
    inputSchema: mode === "boolean" ? booleanSchema : { type: "object", properties: {} }
  }))
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) =>
  params.name === "mixed"
    ? {
        content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        structuredContent: { fixture: "structured" }
      }
    : { content: [], structuredContent: { result: ["one", "two"] } }
);
await server.connect(new StdioServerTransport());
