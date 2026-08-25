import { UtcpClient, Tool, JsonSchema, UtcpClientConfig } from '@utcp/sdk';
import ivm from 'isolated-vm';

/**
 * CodeModeUtcpClient extends UtcpClient to provide TypeScript code execution capabilities.
 * This allows executing TypeScript code that can directly call registered tools as functions.
 */
export class CodeModeUtcpClient extends UtcpClient {
  private toolFunctionCache: Map<string, string> = new Map();

  /**
   * Standard prompt template for AI agents using CodeModeUtcpClient.
   * This provides guidance on how to properly discover and use tools within code execution.
   */
  public static readonly AGENT_PROMPT_TEMPLATE = `
## UTCP CodeMode Tool Usage Guide

You have access to a CodeModeUtcpClient that allows you to execute TypeScript code with access to registered tools. Follow this workflow:

### 1. Tool Discovery Phase
**Always start by discovering available tools:**
- Tools are organized by manual namespace (e.g., \`manual_name.tool_name\`)
- Use hierarchical access patterns: \`manual.tool({ param: value })\` (synchronous, no await)
- Multiple manuals can contain tools with the same name - namespaces prevent conflicts

### 2. Interface Introspection
**Understand tool contracts before using them:**
- Access \`__interfaces\` to see all available TypeScript interface definitions
- Use \`__getToolInterface('manual.tool')\` to get specific tool interfaces
- Interfaces show required inputs, expected outputs, and descriptions
- Look for "Access as: manual.tool(args)" comments for usage patterns

### 3. Code Execution Guidelines
**When writing code for \`callToolChain\`:**
- Your code runs as the body of an \`async function\`. Use \`return\` to return the final result.
- Use \`manual.tool({ param: value })\` syntax for all tool calls. Tool calls are synchronous from your perspective (no await needed) - the host bridges async work transparently. \`await manual.tool(...)\` also works if you prefer.
- \`async\`/\`await\` syntax is supported. Top-level \`await\` works directly inside your code.
- You have access to standard JavaScript globals: \`console\`, \`JSON\`, \`Math\`, \`Date\`, etc.
- All console output (\`console.log\`, \`console.error\`, etc.) is automatically captured and returned alongside the \`result\`.
- Build properly structured input objects based on interface definitions.
- Handle errors appropriately with try/catch blocks.
- Chain tool calls by using results from previous calls.

### 4. Best Practices
- **Discover first, code second**: Always explore available tools before writing execution code
- **Respect namespaces**: Use full \`manual.tool\` names to avoid conflicts
- **Parse interfaces**: Use interface information to construct proper input objects
- **Error handling**: Wrap tool calls in try/catch for robustness
- **Data flow**: Chain tools by passing outputs as inputs to subsequent tools

### 5. Available Runtime Context
- \`__interfaces\`: String containing all TypeScript interface definitions
- \`__getToolInterface(toolName)\`: Function to get specific tool interface
- All registered tools as \`manual.tool\` functions
- Standard JavaScript built-ins for data processing

Remember: Always discover and understand available tools before attempting to use them in code execution.
`.trim();

  /**
   * Creates a new CodeModeUtcpClient instance.
   * This creates a regular UtcpClient and then upgrades it to a CodeModeUtcpClient
   * with all the same configuration and additional code execution capabilities.
   * 
   * @param root_dir The root directory for the client to resolve relative paths from
   * @param config The configuration for the client
   * @returns A new CodeModeUtcpClient instance
   */
  public static async create(
    root_dir: string = process.cwd(),
    config: UtcpClientConfig | null = null
  ): Promise<CodeModeUtcpClient> {
    // Create a regular UtcpClient first
    const baseClient = await UtcpClient.create(root_dir, config);
    
    // Create a CodeModeUtcpClient using the same configuration
    const codeModeClient = Object.setPrototypeOf(baseClient, CodeModeUtcpClient.prototype) as CodeModeUtcpClient;
    
    // Initialize the cache
    (codeModeClient as any).toolFunctionCache = new Map();
    
    return codeModeClient;
  }

  /**
   * Sanitizes an identifier to be a valid TypeScript identifier.
   * Replaces any non-alphanumeric character (except underscore) with underscore
   * and ensures the first character is not a number.
   * 
   * @param name The name to sanitize
   * @returns Sanitized identifier
   */
  private sanitizeIdentifier(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^[0-9]/, '_$&');
  }

  /**
   * Converts a Tool object into a TypeScript function interface string.
   * This generates the function signature that can be used in TypeScript code.
   * 
   * @param tool The Tool object to convert
   * @returns TypeScript function interface as a string
   */
  public toolToTypeScriptInterface(tool: Tool): string {
    if (this.toolFunctionCache.has(tool.name)) {
      return this.toolFunctionCache.get(tool.name)!;
    }

    // Generate hierarchical interface structure
    let interfaceContent: string;
    let accessPattern: string;
    
    if (tool.name.includes('.')) {
      const [manualName, ...toolParts] = tool.name.split('.');
      const sanitizedManualName = this.sanitizeIdentifier(manualName);
      const toolName = toolParts.map(part => this.sanitizeIdentifier(part)).join('_');
      accessPattern = `${sanitizedManualName}.${toolName}`;
      
      // Generate interfaces within namespace
      const inputInterfaceContent = this.jsonSchemaToObjectContent(tool.inputs);
      const outputInterfaceContent = this.jsonSchemaToObjectContent(tool.outputs);
      
      interfaceContent = `
namespace ${sanitizedManualName} {
  interface ${toolName}Input {
${inputInterfaceContent}
  }

  interface ${toolName}Output {
${outputInterfaceContent}
  }
}`;
    } else {
      // No manual namespace, generate flat interfaces
      const sanitizedToolName = this.sanitizeIdentifier(tool.name);
      accessPattern = sanitizedToolName;
      const inputType = this.jsonSchemaToTypeScript(tool.inputs, `${sanitizedToolName}Input`);
      const outputType = this.jsonSchemaToTypeScript(tool.outputs, `${sanitizedToolName}Output`);
      interfaceContent = `${inputType}\n\n${outputType}`;
    }
    const interfaceString = `
${interfaceContent}

/**
 * ${this.escapeComment(tool.description)}
 * Tags: ${this.escapeComment(tool.tags.join(', '))}
 * Access as: ${accessPattern}(args)
 */`;

    this.toolFunctionCache.set(tool.name, interfaceString);
    return interfaceString;
  }

  /**
   * Converts all registered tools to TypeScript interface definitions.
   * This provides the complete type definitions for all available tools.
   * 
   * @returns A complete TypeScript interface definition string
   */
  public async getAllToolsTypeScriptInterfaces(): Promise<string> {
    const tools = await this.getTools();
    const interfaces = tools.map(tool => this.toolToTypeScriptInterface(tool));
    
    return `// Auto-generated TypeScript interfaces for UTCP tools
${interfaces.join('\n\n')}`;
  }

  /**
   * Executes TypeScript code with access to registered tools and captures console output.
   * The code can call tools directly as functions and has access to standard JavaScript globals.
   * Uses isolated-vm for secure sandboxed execution.
   * 
   * @param code TypeScript code to execute  
   * @param timeout Optional timeout in milliseconds (default: 30000)
   * @param memoryLimit Optional memory limit in MB (default: 128)
   * @returns Object containing both the execution result and captured console logs
   */
  public async callToolChain(
    code: string,
    timeout: number = 30000,
    memoryLimit: number = 128
  ): Promise<{result: any, logs: string[]}> {
    const tools = await this.getTools();
    const logs: string[] = [];

    // Create isolated VM
    const isolate = new ivm.Isolate({ memoryLimit });
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Settled (in `finally`) the moment this chain is over — result, error, or
    // timeout. Every bridged tool call races against it, and that race is
    // load-bearing for the process's health, not a nicety: the tool bridge
    // blocks the isolate's OS thread in `applySyncPromise` until the host-side
    // promise settles, and a tool call that never settles (a hung HTTP request,
    // an MCP server that stopped answering) would pin that thread FOREVER.
    // `dispose()` cannot reclaim it — termination is delivered via a V8
    // interrupt, which only fires when JS execution resumes, and a thread
    // parked in `applySyncPromise` never resumes on its own. Each such call
    // used to leak one native thread with barely any memory attached: task
    // counts climb while heap graphs stay flat, until the process hits a
    // pid/thread limit and can no longer fork. The race guarantees every
    // bridged call settles by end-of-chain, so the thread always unparks and
    // the terminate interrupt can land.
    const pendingToolCalls = new Set<string>();
    let releaseChain!: () => void;
    const chainDone = new Promise<never>((_, rej) => {
      releaseChain = () => {
        // Logged synchronously, before the rejection fans out, so the entries
        // are in `logs` by the time the caller sees the chain's result —
        // `Promise.race` never cancels its losers, so this set (not the race
        // arms) is what knows which calls were genuinely still in flight.
        for (const toolName of pendingToolCalls) {
          logs.push(`[WARN] Tool call "${toolName}" abandoned: the chain ended before it settled`);
        }
        pendingToolCalls.clear();
        rej(new Error('tool chain ended'));
      };
    });
    chainDone.catch(() => {}); // settled in finally on every path; never unhandled
    const boundedCallTool = (toolName: string, args: any): Promise<any> => {
      pendingToolCalls.add(toolName);
      const real = this.callTool(toolName, args).finally(() => {
        pendingToolCalls.delete(toolName);
      });
      // A late settlement after the chain ended must not surface as an
      // unhandled rejection — the race below has already moved on.
      real.catch(() => {});
      return Promise.race([
        real,
        chainDone.catch(() => {
          throw new Error(`Tool call "${toolName}" abandoned: the chain ended before it settled`);
        }),
      ]);
    };

    try {
      const context = await isolate.createContext();
      const jail = context.global;

      // Set up the jail with a reference to itself
      await jail.set('global', jail.derefInto());

      // Set up console logging bridges
      await this.setupConsoleBridge(isolate, context, jail, logs);

      // Set up tool bridges
      await this.setupToolBridges(isolate, context, jail, tools, boundedCallTool);
      
      // Set up utility functions and interfaces
      await this.setupUtilities(isolate, context, jail, tools);
      
      // User code runs as the body of an async function so `return` and top-level
      // `await` work naturally. isolated-vm's `script.run()` does not propagate the
      // Promise from an async script, so we transfer the resolved value back via a
      // callback Reference once the inner async function settles.
      let resolveResult!: (json: string) => void;
      let rejectResult!: (err: Error) => void;
      const resultPromise = new Promise<string>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });

      await jail.set(
        '__resolveResult',
        new ivm.Reference((jsonStr: string) => resolveResult(jsonStr))
      );
      await jail.set(
        '__rejectResult',
        new ivm.Reference((errStr: string) => rejectResult(new Error(errStr)))
      );

      const wrappedCode = `
        (async function() {
          try {
            const __result = await (async function() {
              ${code}
            })();
            __resolveResult.applySync(undefined, [JSON.stringify({ __result: __result === undefined ? null : __result })]);
          } catch (e) {
            __rejectResult.applySync(undefined, [String(e && e.stack ? e.stack : e)]);
          }
        })()
      `;

      // Set up the host-side timeout race BEFORE running the script so the
      // resultPromise always has a handler attached - otherwise an early
      // rejection from inside the isolate can race the await below and surface
      // as an unhandled rejection.
      const timeoutPromise = new Promise<string>((_, rej) => {
        timeoutHandle = setTimeout(
          () => rej(new Error(`Script execution timeout after ${timeout}ms`)),
          timeout
        );
      });
      const settledPromise = Promise.race([resultPromise, timeoutPromise]);
      // Swallow late rejections of the loser promise to avoid PromiseRejectionHandledWarning.
      resultPromise.catch(() => {});
      timeoutPromise.catch(() => {});

      const script = await isolate.compileScript(wrappedCode);
      // Kick off the async IIFE. `script.run` returns once the synchronous portion
      // of the wrapper completes (i.e. immediately, since the body is async).
      // `script.run` may itself reject if the isolate refuses to surface the
      // returned Promise; treat that as benign as long as the callback fires.
      // The exception is a rejection from an isolate that is already DISPOSED —
      // isolated-vm kills an isolate that hits its memoryLimit, so the
      // callbacks can never fire and waiting on them would strand the chain
      // until the generic timeout, reporting an out-of-memory as "timed out".
      // Surface the real error instead.
      script.run(context, { timeout }).catch((runErr) => {
        if (isolate.isDisposed) {
          rejectResult(runErr instanceof Error ? runErr : new Error(String(runErr)));
        }
      });

      const resultJson = await settledPromise;
      const result = JSON.parse(resultJson).__result;
      return { result, logs };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Push into the live array rather than returning a copy: `finally` runs
      // AFTER this return value is built, and the abandoned-call warnings it
      // writes (see `releaseChain`) must reach the caller too.
      logs.push(`[ERROR] Code execution failed: ${errorMessage}`);
      return { result: null, logs };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Unblock any tool call still parked in `applySyncPromise` BEFORE
      // disposing, so the isolate's thread can resume and take the terminate
      // interrupt (see `chainDone` above).
      releaseChain();
      this.disposeIsolateSafely(isolate);
    }
  }

  /**
   * Dispose an isolate without ever letting disposal failures replace the
   * chain's result, and without trusting a single attempt.
   *
   * A bare `isolate.dispose()` in a `finally` has two failure modes. An
   * isolate that blew its `memoryLimit` was already disposed by isolated-vm
   * itself, so the second dispose throws "Isolate is already disposed" — and
   * an exception thrown from a `finally` REPLACES the function's return
   * value, turning an orderly out-of-memory result into an opaque rejection.
   * And disposal of a busy isolate is delivered as a terminate request rather
   * than being instantaneous, with upstream reports
   * (https://github.com/laverdet/isolated-vm/issues/198) of isolates whose GC
   * threads out-live it; those leak an OS thread each, which is invisible in
   * memory metrics and only surfaces when the process exhausts a pid limit.
   *
   * So: guard on `isDisposed`, swallow (but log) a throwing dispose, and
   * re-check on a few unref'd timers so a slow teardown gets retried and a
   * genuinely stuck isolate is at least reported instead of silent.
   */
  private disposeIsolateSafely(isolate: ivm.Isolate): void {
    const tryDispose = (): void => {
      try {
        if (!isolate.isDisposed) isolate.dispose();
      } catch (err) {
        console.warn(
          `[code-mode] isolate dispose attempt failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };
    tryDispose();
    if (isolate.isDisposed) return;
    let attempts = 0;
    const retry = (): void => {
      attempts += 1;
      tryDispose();
      if (!isolate.isDisposed && attempts < 5) {
        const t = setTimeout(retry, 200 * attempts);
        t.unref?.();
      } else if (!isolate.isDisposed) {
        console.error(
          '[code-mode] isolate could not be disposed after retries — its thread and heap are likely leaked'
        );
      }
    };
    const t = setTimeout(retry, 100);
    t.unref?.();
  }

  /**
   * Sets up console bridge functions in the isolated context.
   * Console calls in the isolate are forwarded to the main process for logging.
   */
  private async setupConsoleBridge(
    isolate: ivm.Isolate,
    context: ivm.Context,
    jail: ivm.Reference<Record<string | number | symbol, unknown>>,
    logs: string[]
  ): Promise<void> {
    // Create log capture functions in main process
    const createLogHandler = (prefix: string) => {
      return new ivm.Reference((...args: any[]) => {
        const message = args.join(' ');
        logs.push(prefix ? `${prefix} ${message}` : message);
      });
    };

    // Set up console references in isolate
    await jail.set('__logRef', createLogHandler(''));
    await jail.set('__errorRef', createLogHandler('[ERROR]'));
    await jail.set('__warnRef', createLogHandler('[WARN]'));
    await jail.set('__infoRef', createLogHandler('[INFO]'));
    
    // Create console object in isolate that calls the references
    const consoleSetupScript = await isolate.compileScript(`
      const __stringify = (a) => typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a);
      global.console = {
        log: (...args) => __logRef.applySync(undefined, args.map(__stringify)),
        error: (...args) => __errorRef.applySync(undefined, args.map(__stringify)),
        warn: (...args) => __warnRef.applySync(undefined, args.map(__stringify)),
        info: (...args) => __infoRef.applySync(undefined, args.map(__stringify))
      };
    `);
    await consoleSetupScript.run(context);
  }

  /**
   * Sets up tool bridge functions in the isolated context.
   * Tool calls in the isolate are forwarded to the main process for execution.
   */
  private async setupToolBridges(
    isolate: ivm.Isolate,
    context: ivm.Context,
    jail: ivm.Reference<Record<string | number | symbol, unknown>>,
    tools: Tool[],
    // The in-isolate stubs block their OS thread in `applySyncPromise` until
    // this settles, so `callToolChain` passes a caller that is GUARANTEED to
    // settle by end-of-chain (see `chainDone` there). Defaults to the raw
    // client call for any external caller of this method.
    callTool: (toolName: string, args: any) => Promise<any> = (toolName, args) =>
      this.callTool(toolName, args)
  ): Promise<void> {
    // Create a reference for the tool caller in main process
    const toolCallerRef = new ivm.Reference(async (toolName: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson);
        const result = await callTool(toolName, args);
        return JSON.stringify({ success: true, result });
      } catch (error: any) {
        let errorMsg: string = error instanceof Error ? error.message : String(error);
        // HTTP response error handling
        if (error.response?.data) {
          errorMsg += ` Error data: ${JSON.stringify(error.response.data)}`;
        }
        return JSON.stringify({ 
          success: false, 
          error: errorMsg
        });
      }
    });
    
    await jail.set('__callToolRef', toolCallerRef);
    
    // Build tool namespace setup code
    const toolSetupParts: string[] = [];
    const namespaces = new Set<string>();
    
    for (const tool of tools) {
      if (tool.name.includes('.')) {
        const [manualName, ...toolParts] = tool.name.split('.');
        const sanitizedManualName = this.sanitizeIdentifier(manualName);
        const toolFnName = toolParts.map(part => this.sanitizeIdentifier(part)).join('_');
        
        if (!namespaces.has(sanitizedManualName)) {
          namespaces.add(sanitizedManualName);
          toolSetupParts.push(`global.${sanitizedManualName} = global.${sanitizedManualName} || {};`);
        }
        
        toolSetupParts.push(`
          global.${sanitizedManualName}.${toolFnName} = function(args) {
            // applySyncPromise blocks until async tool call completes in main process
            var resultJson = __callToolRef.applySyncPromise(undefined, [${JSON.stringify(tool.name)}, JSON.stringify(args || {})]);
            var parsed = JSON.parse(resultJson);
            if (!parsed.success) throw new Error(parsed.error);
            return parsed.result;
          };
        `);
      } else {
        const sanitizedToolName = this.sanitizeIdentifier(tool.name);
        toolSetupParts.push(`
          global.${sanitizedToolName} = function(args) {
            // applySyncPromise blocks until async tool call completes in main process
            var resultJson = __callToolRef.applySyncPromise(undefined, [${JSON.stringify(tool.name)}, JSON.stringify(args || {})]);
            var parsed = JSON.parse(resultJson);
            if (!parsed.success) throw new Error(parsed.error);
            return parsed.result;
          };
        `);
      }
    }
    
    // Execute tool setup in isolate
    const toolSetupScript = await isolate.compileScript(toolSetupParts.join('\n'));
    await toolSetupScript.run(context);
  }

  /**
   * Sets up utility functions and interfaces in the isolated context.
   */
  private async setupUtilities(
    isolate: ivm.Isolate,
    context: ivm.Context,
    jail: ivm.Reference<Record<string | number | symbol, unknown>>,
    tools: Tool[]
  ): Promise<void> {
    // Add TypeScript interface definitions
    const interfaces = await this.getAllToolsTypeScriptInterfaces();
    await jail.set('__interfaces', interfaces);
    
    // Create interface lookup map
    const interfaceMap: Record<string, string> = {};
    for (const tool of tools) {
      interfaceMap[tool.name] = this.toolToTypeScriptInterface(tool);
    }
    await jail.set('__interfaceMapJson', JSON.stringify(interfaceMap));
    
    // Execute utility setup in isolate
    const utilSetupScript = await isolate.compileScript(`
      global.__getToolInterface = (toolName) => {
        const map = JSON.parse(__interfaceMapJson);
        return map[toolName] || null;
      };
    `);
    await utilSetupScript.run(context);
  }

  /**
   * Converts a JSON Schema to TypeScript object content (properties only, no interface wrapper).
   * This generates the content inside an interface definition.
   * 
   * @param schema JSON Schema to convert
   * @returns TypeScript interface properties as string
   */
  private jsonSchemaToObjectContent(schema: JsonSchema): string {
    if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
      return '    [key: string]: any;';
    }

    const properties = schema.properties || {};
    const required = schema.required || [];
    const lines: string[] = [];

    for (const [propName, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(propName);
      const optionalMarker = isRequired ? '' : '?';
      const description = (propSchema as any).description || '';
      const tsType = this.jsonSchemaToTypeScriptType(propSchema as JsonSchema);

      if (description) {
        lines.push(`    /** ${this.escapeComment(description)} */`);
      }
      lines.push(`    ${propName}${optionalMarker}: ${tsType};`);
    }

    return lines.length > 0 ? lines.join('\n') : '    [key: string]: any;';
  }

  /**
   * Converts a JSON Schema to TypeScript interface definition.
   * This handles the most common JSON Schema patterns used in UTCP tools.
   * 
   * @param schema JSON Schema to convert
   * @param typeName Name for the generated TypeScript type
   * @returns TypeScript type definition as string
   */
  private jsonSchemaToTypeScript(schema: JsonSchema, typeName: string): string {
    if (!schema || typeof schema !== 'object') {
      return `type ${typeName} = any;`;
    }

    // Handle different schema types
    switch (schema.type) {
      case 'object':
        return this.objectSchemaToTypeScript(schema, typeName);
      case 'array':
        return this.arraySchemaToTypeScript(schema, typeName);
      case 'string':
        return this.primitiveSchemaToTypeScript(schema, typeName, 'string');
      case 'number':
      case 'integer':
        return this.primitiveSchemaToTypeScript(schema, typeName, 'number');
      case 'boolean':
        return this.primitiveSchemaToTypeScript(schema, typeName, 'boolean');
      case 'null':
        return `type ${typeName} = null;`;
      default:
        // Handle union types or fallback to any
        if (Array.isArray(schema.type)) {
          const types = schema.type.map(t => this.mapJsonTypeToTS(t)).join(' | ');
          return `type ${typeName} = ${types};`;
        }
        return `type ${typeName} = any;`;
    }
  }

  /**
   * Converts an object JSON Schema to TypeScript interface.
   */
  private objectSchemaToTypeScript(schema: JsonSchema, typeName: string): string {
    if (!schema.properties) {
      return `interface ${typeName} {
  [key: string]: any;
}`;
    }

    const properties = Object.entries(schema.properties).map(([key, propSchema]) => {
      const isRequired = schema.required?.includes(key) ?? false;
      const optional = isRequired ? '' : '?';
      const propType = this.jsonSchemaToTypeScriptType(propSchema);
      const description = propSchema.description ? `  /** ${this.escapeComment(propSchema.description)} */\n` : '';
      
      return `${description}  ${key}${optional}: ${propType};`;
    }).join('\n');

    return `interface ${typeName} {
${properties}
}`;
  }

  /**
   * Converts an array JSON Schema to TypeScript type.
   */
  private arraySchemaToTypeScript(schema: JsonSchema, typeName: string): string {
    if (!schema.items) {
      return `type ${typeName} = any[];`;
    }

    const itemType = Array.isArray(schema.items) 
      ? schema.items.map(item => this.jsonSchemaToTypeScriptType(item)).join(' | ')
      : this.jsonSchemaToTypeScriptType(schema.items);

    return `type ${typeName} = (${itemType})[];`;
  }

  /**
   * Converts a primitive JSON Schema to TypeScript type with enum support.
   */
  private primitiveSchemaToTypeScript(schema: JsonSchema, typeName: string, baseType: string): string {
    if (schema.enum) {
      const enumValues = schema.enum.map(val => 
        typeof val === 'string' ? JSON.stringify(val) : String(val)
      ).join(' | ');
      return `type ${typeName} = ${enumValues};`;
    }

    return `type ${typeName} = ${baseType};`;
  }

  /**
   * Converts a JSON Schema to a TypeScript type (not a full type definition).
   */
  private jsonSchemaToTypeScriptType(schema: JsonSchema): string {
    if (!schema || typeof schema !== 'object') {
      return 'any';
    }

    if (schema.enum) {
      return schema.enum.map(val => 
        typeof val === 'string' ? JSON.stringify(val) : String(val)
      ).join(' | ');
    }

    switch (schema.type) {
      case 'object':
        if (!schema.properties) return '{ [key: string]: any }';
        const props = Object.entries(schema.properties).map(([key, propSchema]) => {
          const isRequired = schema.required?.includes(key) ?? false;
          const optional = isRequired ? '' : '?';
          const propType = this.jsonSchemaToTypeScriptType(propSchema);
          return `${key}${optional}: ${propType}`;
        }).join('; ');
        return `{ ${props} }`;
      
      case 'array':
        if (!schema.items) return 'any[]';
        const itemType = Array.isArray(schema.items)
          ? schema.items.map(item => this.jsonSchemaToTypeScriptType(item)).join(' | ')
          : this.jsonSchemaToTypeScriptType(schema.items);
        return `(${itemType})[]`;
      
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      
      default:
        if (Array.isArray(schema.type)) {
          return schema.type.map(t => this.mapJsonTypeToTS(t)).join(' | ');
        }
        return 'any';
    }
  }

  /**
   * Escapes a string for safe use in JSDoc comments.
   * Prevents comment injection via star-slash sequences.
   */
  private escapeComment(text: string): string {
    return text.replace(/\*\//g, '*\\/').replace(/\n/g, ' ');
  }

  /**
   * Maps basic JSON Schema types to TypeScript types.
   */
  private mapJsonTypeToTS(type: string): string {
    switch (type) {
      case 'string': return 'string';
      case 'number':
      case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'object': return 'object';
      case 'array': return 'any[]';
      default: return 'any';
    }
  }
}
