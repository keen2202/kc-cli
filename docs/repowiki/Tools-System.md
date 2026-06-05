# Tools System

21 built-in tools with two-phase execution, lazy loading, and plugin extensibility.

## Tool Registry

`src/tools.ts` -- `ToolRegistryImpl` manages three registries:

| Registry | Source | Loading |
|----------|--------|---------|
| `tools` | Built-in (21) | Eager (CRITICAL+HIGH) / Lazy (MEDIUM+LOW+DEFERRED) |
| `mcpTools` | MCP servers | On MCP connect |
| `pluginTools` | Plugins | On plugin init |

### Lazy Loading

Tools are registered in a `TOOL_MANIFEST` with priority levels:

| Priority | Level | Tools | Loading |
|----------|-------|-------|---------|
| 0 | CRITICAL | Bash, FileRead | Eager |
| 10 | HIGH | FileWrite, WebSearch, FileEdit, Grep, Glob, WebFetch, Git, Run | Eager |
| 20 | MEDIUM | Sql, Docker, Monitor, Config | Lazy |
| 30 | LOW | TodoWrite, TaskCreate, TaskGet, AskUser | Lazy |
| 40 | DEFERRED | Agent, Deploy, TeamCreate, LSP | Lazy |

`ensureTool(name)` loads on first use with deduplication. `assembleToolPool()` merges all sources with deny-rule filtering.

## ToolDefinition Interface

`src/tools/protocol.ts`:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  outputSchema?: ZodSchema;

  // Two-phase execution
  prepare?(input, context): Promise<PrepareResult>;
  call(input, context, onProgress?): Promise<ToolResult>;
  finalize?(input, result, context): Promise<ToolResult>;

  // Permission
  checkPermissions?(input, context): Promise<PermissionResult>;

  // Capabilities
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive: boolean;
  isEnabled?: () => boolean;

  // Timeout
  timeout?: number; // seconds
}
```

### Two-Phase Execution

```
prepare()  → Can modify input, skip execution, or return early result
call()     → Main execution logic
finalize() → Can transform or augment the result
```

Example: FileWriteTool's `prepare()` checks if the file exists and the content is different. If content is identical, it returns an early "no change" result without writing.

## Tool Factory (buildTool)

`src/Tool.ts` wraps tool `call()` with:
- Unified error handling (catches exceptions, wraps in `KCError`)
- Progress reporting via `onProgress` callback
- Result normalization

## Tool Executor

`src/executors/toolExecutor.ts`:

### executeSingle()

Full pipeline for one tool call:

```
1. Find tool in registry
2. plugin.preToolUse(toolName, input) hook
   └─ Can modify input or block (return null)
3. tool.prepare(input, context)
   └─ Can skip execution or return early
4. permissionEngine.check(tool, input)
   └─ deny-first evaluation
5. sandboxManager.wrapCommand() [if Bash/Run]
   └─ HMAC-signed isolation wrapper
6. tool.call(input, context, onProgress)
   └─ With timeout enforcement
7. tool.finalize(input, result, context)
   └─ Can transform result
8. plugin.postToolUse(toolName, input, result) hook
   └─ Can override result
```

### executeParallel()

Groups tool calls by `isConcurrencySafe`:

```
Tool calls: [A(safe), B(unsafe), C(safe), D(unsafe)]

Execution:
  Parallel:  [A, C]  ← Semaphore(limit=5)
  Sequential: B
  Sequential: D
```

### Sandbox Integration

`Bash` and `Run` tools are wrapped at the executor level with HMAC-signed markers:

```typescript
const SANDBOX_WRAPPED_MARKER = '__KC_SANDBOX_WRAPPED__';
const SANDBOX_SIGNATURE_KEY = process.pid + '-' + crypto.randomUUID();
```

The HMAC signature prevents external code from forging the sandbox-wrapped state.

## Built-in Tools

### CRITICAL (Priority 0)

| Tool | Description | Read-Only | Concurrency-Safe |
|------|-------------|-----------|------------------|
| Bash | Shell execution with dangerous-command detection | No | No |
| FileRead | File reading with size limits (100KB default) | Yes | Yes |

### HIGH (Priority 10)

| Tool | Description | Read-Only | Concurrency-Safe |
|------|-------------|-----------|------------------|
| FileWrite | File writing with path validation | No | No |
| FileEdit | Exact string replacement in files | No | No |
| Grep | Content search via ripgrep/grep | Yes | Yes |
| Glob | File pattern matching | Yes | Yes |
| WebSearch | Web search (Tavily/custom provider) | Yes | Yes |
| WebFetch | URL content fetching with HTML→MD | Yes | Yes |
| Git | Git operations (status, log, diff, commit, etc.) | Mixed | No |
| Run | Program compilation and execution | No | No |

### MEDIUM (Priority 20)

| Tool | Description | Read-Only | Concurrency-Safe |
|------|-------------|-----------|------------------|
| Sql | Database queries (SQLite/PostgreSQL/MySQL) | Mixed | No |
| Docker | Docker container and image operations | Mixed | No |
| Monitor | System resource monitoring | Yes | Yes |
| Config | Configuration management | Yes | Yes |

### LOW (Priority 30)

| Tool | Description | Read-Only | Concurrency-Safe |
|------|-------------|-----------|------------------|
| TodoWrite | Task list management | No | No |
| TaskCreate | Task creation for progress tracking | Yes | No |
| TaskGet | Task retrieval | Yes | Yes |
| AskUser | Interactive user prompts | Yes | Yes |

### DEFERRED (Priority 40)

| Tool | Description | Read-Only | Concurrency-Safe |
|------|-------------|-----------|------------------|
| Agent | Sub-agent spawning | No | No |
| Deploy | Application deployment | No | No |
| TeamCreate | Team creation via orchestrator | No | No |
| LSP | Language server operations | Yes | Yes |

## Tool Input Schemas

All tool inputs use Zod schemas for validation. The `zodToJsonSchema()` utility converts Zod schemas to JSON Schema for LLM function calling format.

Example (BashTool):
```typescript
const BashInputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z.number().optional().describe('Timeout in seconds'),
  background: z.boolean().optional().describe('Run in background'),
});
```

## TaskStore

`src/tools/TaskStore.ts` -- Shared in-memory store for TaskCreate/TaskGet/TodoWrite tools. Tasks have:
- `id`, `subject`, `description`, `status` (pending/in_progress/completed/deleted)
- `blocks`, `blockedBy` (dependency tracking)
- `owner`, `metadata`, `activeForm` (spinner text)
