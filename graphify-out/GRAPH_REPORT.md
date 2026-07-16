# Graph Report - .  (2026-04-26)

## Corpus Check
- Corpus is ~8,949 words - fits in a single context window. You may not need a graph.

## Summary
- 81 nodes · 110 edges · 10 communities detected
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.87)
- Token cost: 9,800 input · 4,200 output

## Community Hubs (Navigation)
- [[_COMMUNITY_TypeScript Interface Generation|TypeScript Interface Generation]]
- [[_COMMUNITY_MCP Server Documentation|MCP Server Documentation]]
- [[_COMMUNITY_Client Core Methods|Client Core Methods]]
- [[_COMMUNITY_MCP Entry & Tool Lookup|MCP Entry & Tool Lookup]]
- [[_COMMUNITY_Isolated Sandbox Execution|Isolated Sandbox Execution]]
- [[_COMMUNITY_Test Suite & Config|Test Suite & Config]]
- [[_COMMUNITY_Client Initialization & Config|Client Initialization & Config]]
- [[_COMMUNITY_MCP Server Transport|MCP Server Transport]]
- [[_COMMUNITY_Package Build & Exports|Package Build & Exports]]
- [[_COMMUNITY_Agent Prompt Template|Agent Prompt Template]]

## God Nodes (most connected - your core abstractions)
1. `CodeModeUtcpClient` - 29 edges
2. `Code-Mode Library` - 9 edges
3. `callToolChain(code, timeout, memoryLimit)` - 7 edges
4. `toolToTypeScriptInterface(tool)` - 7 edges
5. `setupMcpTools()` - 7 edges
6. `UTCP Code Mode MCP Bridge` - 5 edges
7. `CodeModeUtcpClient Test Suite` - 5 edges
8. `setupUtilities(isolate, context, jail, tools)` - 4 edges
9. `initializeUtcpClient()` - 4 edges
10. `main()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `sanitizeIdentifier(name)` --semantically_similar_to--> `CodeModeUtcpClient`  [INFERRED] [semantically similar]
  code-mode-mcp/index.ts → /Users/hack/github/code-mode/typescript-library/src/code_mode_utcp_client.ts
- `@utcp/code-mode npm package` --documents--> `CodeModeUtcpClient`  [EXTRACTED]
  typescript-library/README.md → /Users/hack/github/code-mode/typescript-library/src/code_mode_utcp_client.ts
- `AGENT_PROMPT_TEMPLATE (static)` --documents--> `AGENT_PROMPT_TEMPLATE`  [INFERRED]
  README.md → typescript-library/src/code_mode_utcp_client.ts
- `CodeModeUtcpClient.create(root_dir, config)` --instantiates--> `CodeModeUtcpClient`  [EXTRACTED]
  typescript-library/src/code_mode_utcp_client.ts → /Users/hack/github/code-mode/typescript-library/src/code_mode_utcp_client.ts
- `CodeModeUtcpClient` --has_static_property--> `AGENT_PROMPT_TEMPLATE`  [EXTRACTED]
  /Users/hack/github/code-mode/typescript-library/src/code_mode_utcp_client.ts → typescript-library/src/code_mode_utcp_client.ts

## Hyperedges (group relationships)
- **isolated-vm code execution pipeline: callToolChain orchestrates setupConsoleBridge, setupToolBridges, setupUtilities inside a single ivm.Isolate context** — code_mode_utcp_client_calltoolchain, code_mode_utcp_client_setupconsolebride, code_mode_utcp_client_setuptoolbridges, code_mode_utcp_client_setuputilities, tslib_readme_isolated_vm [EXTRACTED 1.00]
- **MCP call_tool_chain tool delegates through initializeUtcpClient to CodeModeUtcpClient.callToolChain, bridging MCP ecosystem to UTCP sandbox execution** — mcp_index_tool_call_tool_chain, mcp_index_initializeutcpclient, code_mode_utcp_client_codemodeutcpclient, code_mode_utcp_client_calltoolchain [EXTRACTED 1.00]
- **TypeScript interface generation pipeline: toolToTypeScriptInterface (with caching) → getAllToolsTypeScriptInterfaces → injected as __interfaces and __getToolInterface into sandbox runtime context** — code_mode_utcp_client_tooltotypescriptinterface, code_mode_utcp_client_getalltoolstypescriptinterfaces, code_mode_utcp_client_toolfunction_cache, code_mode_utcp_client_setuputilities, tslib_readme_runtime_context [EXTRACTED 1.00]

## Communities

### Community 0 - "TypeScript Interface Generation"
Cohesion: 0.15
Nodes (16): getAllToolsTypeScriptInterfaces(), jsonSchemaToTypeScript(schema, typeName), setupUtilities(isolate, context, jail, tools), toolFunctionCache (Map<string, string>), toolToTypeScriptInterface(tool), findToolByName(client, name), sanitizeIdentifier(name), setupMcpTools() (+8 more)

### Community 1 - "MCP Server Documentation"
Cohesion: 0.2
Nodes (11): Rationale: CLI plugin disabled by default for security, Exposed MCP Tools (register_manual, search_tools, call_tool_chain, etc.), UTCP Code Mode MCP Bridge, Anthropic MCP Code Execution Study, Python Benchmark Study (imran31415/codemode_python_benchmark), Cloudflare Code Mode Research, Code-Mode Library, Rationale: LLMs excel at code generation vs tool orchestration (+3 more)

### Community 2 - "Client Core Methods"
Cohesion: 0.31
Nodes (2): CodeModeUtcpClient, @utcp/code-mode npm package

### Community 3 - "MCP Entry & Tool Lookup"
Cohesion: 0.39
Nodes (6): findToolByName(), initializeUtcpClient(), main(), sanitizeIdentifier(), setupMcpTools(), utcpNameToTsInterfaceName()

### Community 4 - "Isolated Sandbox Execution"
Cohesion: 0.29
Nodes (8): applySyncPromise (isolated-vm sync cross-context call mechanism), callToolChain(code, timeout, memoryLimit), setupConsoleBridge(isolate, context, jail, logs), setupToolBridges(isolate, context, jail, tools), toolCallerRef (ivm.Reference bridge to callTool), MCP Tool: call_tool_chain, Secure VM Sandboxing via Node.js isolates, isolated-vm sandboxing dependency

### Community 6 - "Test Suite & Config"
Cohesion: 0.5
Nodes (5): Jest Configuration (ts-jest, node environment), CodeModeUtcpClient Test Suite, Direct-call test tools (add, greet, processData, throwError, getCurrentTime, sumArray), getTestManual direct-call function (UTCP manual provider), direct-call tool registration pattern

### Community 7 - "Client Initialization & Config"
Cohesion: 0.4
Nodes (5): CodeModeUtcpClient.create(root_dir, config), initializeUtcpClient(), UTCP_CONFIG_FILE environment variable, UtcpClientConfigSerializer, .utcp_config.json Configuration File

### Community 9 - "MCP Server Transport"
Cohesion: 1.0
Nodes (2): McpServer (CodeMode-MCP, version 1.0.0), StdioServerTransport

### Community 10 - "Package Build & Exports"
Cohesion: 1.0
Nodes (2): index.ts export: CodeModeUtcpClient, tsup Build Configuration (ESM + CJS dual output)

### Community 11 - "Agent Prompt Template"
Cohesion: 1.0
Nodes (2): AGENT_PROMPT_TEMPLATE, AGENT_PROMPT_TEMPLATE (static)

## Knowledge Gaps
- **22 isolated node(s):** `Rationale: LLMs excel at code generation vs tool orchestration`, `Python Benchmark Study (imran31415/codemode_python_benchmark)`, `Progressive Tool Discovery`, `AGENT_PROMPT_TEMPLATE (static)`, `Multi-Protocol Tool Support (MCP, HTTP, File, CLI)` (+17 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Client Core Methods`** (10 nodes): `CodeModeUtcpClient`, `.callToolChain()`, `.getAllToolsTypeScriptInterfaces()`, `.mapJsonTypeToTS()`, `.sanitizeIdentifier()`, `.setupConsoleBridge()`, `.setupToolBridges()`, `.setupUtilities()`, `@utcp/code-mode npm package`, `code_mode_utcp_client.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `MCP Server Transport`** (2 nodes): `McpServer (CodeMode-MCP, version 1.0.0)`, `StdioServerTransport`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Package Build & Exports`** (2 nodes): `index.ts export: CodeModeUtcpClient`, `tsup Build Configuration (ESM + CJS dual output)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Agent Prompt Template`** (2 nodes): `AGENT_PROMPT_TEMPLATE`, `AGENT_PROMPT_TEMPLATE (static)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CodeModeUtcpClient` connect `Client Core Methods` to `TypeScript Interface Generation`, `MCP Entry & Tool Lookup`, `Isolated Sandbox Execution`, `JSON Schema Type Conversion`, `Test Suite & Config`, `Client Initialization & Config`, `Code Generation Utilities`, `MCP Server Transport`, `Package Build & Exports`, `Agent Prompt Template`?**
  _High betweenness centrality (0.679) - this node is a cross-community bridge._
- **Why does `callToolChain(code, timeout, memoryLimit)` connect `Isolated Sandbox Execution` to `TypeScript Interface Generation`, `Client Core Methods`, `Test Suite & Config`?**
  _High betweenness centrality (0.274) - this node is a cross-community bridge._
- **What connects `Rationale: LLMs excel at code generation vs tool orchestration`, `Python Benchmark Study (imran31415/codemode_python_benchmark)`, `Progressive Tool Discovery` to the rest of the system?**
  _22 weakly-connected nodes found - possible documentation gaps or missing edges._