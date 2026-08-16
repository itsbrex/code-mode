# @utcp/code-mode

Execute TypeScript code with direct access to UTCP tools using `isolated-vm` for sandboxed execution.

## Installation

```bash
npm install @utcp/code-mode @utcp/sdk @utcp/direct-call isolated-vm
```

## Quick Start

```typescript
import { CodeModeUtcpClient } from "@utcp/code-mode";
import { addFunctionToUtcpDirectCall } from "@utcp/direct-call";

addFunctionToUtcpDirectCall("getWeatherManual", async () => ({
  utcp_version: "0.2.0",
  tools: [
    {
      name: "get_current",
      description: "Get current weather for a city",
      inputs: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"]
      },
      tool_call_template: {
        call_template_type: "direct-call",
        callable_name: "getWeather"
      }
    }
  ]
}));

addFunctionToUtcpDirectCall("getWeather", async (city: string) => ({
  city,
  temperature: 22,
  condition: "sunny"
}));

const client = await CodeModeUtcpClient.create();
await client.registerManual({
  name: "weather",
  call_template_type: "direct-call",
  callable_name: "getWeatherManual"
});

const { result, logs } = await client.callToolChain(`
  const data = weather.get_current({ city: "London" });
  console.log("Weather:", data);
  return data;
`);

console.log(result);
console.log(logs);
```

## API

### `CodeModeUtcpClient.create(root_dir?, config?)`

Create a new client instance backed by `UtcpClient`.

```typescript
const client = await CodeModeUtcpClient.create(
  process.cwd(),
  null
);
```

### `client.callToolChain(code, timeout?, memoryLimit?)`

Execute TypeScript code inside an async sandbox function with access to registered tools.
Top-level `await` is supported. Tool proxy calls may be written with or without
`await`; both forms resolve to the same bridged UTCP result.

```typescript
const { result, logs } = await client.callToolChain(
  `
    const current = weather.get_current({ city: "Tokyo" });
    console.log(current);
    return current;
  `,
  30_000,
  128
);
```

**Returns**

```typescript
{
  result: any;
  logs: string[];
}
```

### `client.getAllToolsTypeScriptInterfaces()`

Return TypeScript interface definitions for all registered tools.

```typescript
const interfaces = await client.getAllToolsTypeScriptInterfaces();
console.log(interfaces);
```

### `client.toolToTypeScriptInterface(tool)`

Return the TypeScript interface definition for a single UTCP tool.

### `CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE`

Static prompt guidance for agents using the code-mode runtime.

```typescript
const systemPrompt = CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE;
```

## Tool Access Pattern

Inside `callToolChain`, tools are exposed under their manual namespace:

```typescript
manual_name.tool_name({ param: value })
```

Examples:

```typescript
weather.get_current({ city: "Tokyo" });
await weather.get_current({ city: "Tokyo" });
procurement.search_parts({ mpn: "LM358" });
```

`await` is optional for sandbox tool calls. The main process bridges each call
to the async UTCP client, while the sandbox supports both direct and awaited
syntax.

## Runtime Context

Inside `callToolChain`, you have access to:

| Variable | Description |
|----------|-------------|
| `__interfaces` | String containing all generated TypeScript interfaces |
| `__getToolInterface(name)` | Lookup for a specific tool interface |
| `console.log/error/warn/info` | Captured into the returned `logs` array |
| Standard JS globals | `JSON`, `Math`, `Date`, `Array`, etc. |

## Chaining Tools

```typescript
const { result } = await client.callToolChain(`
  const parts = procurement.search_parts({ mpn: "LM358" });
  const pricing = parts.map((part) =>
    procurement.get_pricing({ part_id: part.id })
  );
  return { parts, pricing };
`);
```

## Using Text Templates

```typescript
import { CodeModeUtcpClient } from "@utcp/code-mode";
import "@utcp/text";

const client = await CodeModeUtcpClient.create();

await client.registerManual({
  name: "myapi",
  call_template_type: "text",
  file_path: "./my-api-manual.utcp.json"
});

const { result } = await client.callToolChain(`
  return myapi.some_tool({ param: "value" });
`);
```

## Security

Code execution uses [`isolated-vm`](https://github.com/laverdet/isolated-vm):

- isolated V8 context
- memory limits
- execution timeouts
- no direct Node.js filesystem or network access from the sandbox

## License

MPL-2.0
