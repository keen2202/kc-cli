# Architecture

KC-CLI follows a layered architecture with clear module boundaries enforced by protocol-first design.

## Layer Diagram

```
┌─────────────────────────────────────────────────────┐
│                    Presentation                      │
│   UI (components, overlays, layout, theme, mouse)   │
│   JSON mode (NDJSON streaming for IDE integration)   │
│   ACP (JSON-RPC 2.0 over stdio)                     │
├─────────────────────────────────────────────────────┤
│                    Application                       │
│   QueryEngine (state machine facade)                │
│   Orchestrator (multi-agent coordination)           │
│   AGP (Autogenesis Protocol, self-evolving agents)  │
│   Commands (/branch, /checkout, /history)           │
├─────────────────────────────────────────────────────┤
│                      Domain                          │
│   Tools (21 built-in + MCP + plugins)               │
│   Permissions (6-step deny-first)                   │
│   Memory (file-based persistent)                    │
│   SessionTree (non-linear branching)                │
├─────────────────────────────────────────────────────┤
│                    Infrastructure                    │
│   API Clients (11 providers)                        │
│   Sandbox (Docker/Bubblewrap/seccomp)               │
│   LSP (language server integration)                 │
│   MCP (Model Context Protocol)                      │
│   Cache (tiered: memory + disk)                     │
│   Budget (token/cost enforcement)                   │
├─────────────────────────────────────────────────────┤
│                    Foundation                        │
│   State Store (observable, immutable)               │
│   Error Handling (Result<T,E>, KCError)             │
│   ExecutionEnv (swappable FS + Shell)               │
│   ServiceContainer (DI)                             │
│   Configuration (5-layer)                           │
│   Logging (structured)                              │
└─────────────────────────────────────────────────────┘
```

## Module Source Paths

| Layer | Module | Path |
|-------|--------|------|
| Presentation | UI Components | `src/ui/components/` |
| Presentation | Terminal Renderer | `src/ui/renderer.ts` |
| Presentation | Layout Manager | `src/ui/layout.ts` |
| Presentation | Theme System | `src/ui/theme.ts` |
| Application | QueryEngine | `src/query/QueryEngine.ts` |
| Application | Orchestrator | `src/orchestrator/agent-orchestrator.ts` |
| Application | AGP | `src/agp/` |
| Application | Commands | `src/commands/` |
| Domain | Tools | `src/tools/` (20 built-in) |
| Domain | Permissions | `src/permissions/engine.ts` |
| Domain | Memory | `src/memory/` |
| Infrastructure | API Clients | `src/api/` (11 providers) |
| Infrastructure | Sandbox | `src/services/sandbox*.ts` |
| Infrastructure | LSP | `src/lsp/` |
| Infrastructure | MCP | `src/mcp/` |
| Infrastructure | Cache | `src/services/cache/` |
| Infrastructure | Budget | `src/services/budget.ts` |
| Foundation | State Store | `src/state/store.ts` |
| Foundation | Error Types | `src/utils/errors.ts`, `src/utils/result.ts` |
| Foundation | ExecutionEnv | `src/services/execution-env.ts` |
| Foundation | Config | `src/bootstrap/config.ts` |
| Foundation | Logging | `src/services/logger.ts` |

## Initialization Sequence (main.ts)

The entry point performs 5 phases in order:

```
Phase 1: State Init
  └─ Set CWD, session ID, verbose, permission mode, budget

Phase 2: Config Load (parallel)
  ├─ User config (~/.kc-cli/settings.json)
  └─ Project config (.kc-cli/settings.json)
  Then merge: defaults < user < project < env < CLI args

Phase 3: Tool Registration
  ├─ Register built-in tools (CRITICAL+HIGH eager, MEDIUM+LOW+DEFERRED lazy)
  ├─ Connect MCP servers (parallel)
  └─ Load plugins -> initAll() -> onInit()

Phase 4: QueryEngine Creation
  ├─ Create API client (provider-specific)
  ├─ Initialize state machine + store
  ├─ Wire up compaction, memory, error handlers
  └─ Build system prompt with memory context

Phase 5: Execution Mode
  ├─ --json / --json-pretty  → NDJSON event stream
  ├─ Single prompt            → execute + stream + exit
  ├─ Interactive TTY          → renderInkUI (terminal UI)
  └─ Fallback                 → readline REPL
```

## Module Interconnections

```
main.ts
 ├─► bootstrap/config.ts        (loadConfig)
 ├─► bootstrap/state.ts         (initializeState)
 ├─► tools.ts                   (registerBuiltInTools → ToolRegistry)
 ├─► mcp/                       (MCPClientManager, loadMCPConfig)
 ├─► plugins/                   (PluginManager)
 ├─► query/QueryEngine.ts
 │    ├─► api/                  (createAPIClient → BaseApiClient subclass)
 │    ├─► state/                (AgentStateMachine, ObservableStateStore)
 │    ├─► executors/            (toolExecutor)
 │    │    ├─► permissions/     (hasPermissionsToUseTool)
 │    │    ├─► services/        (SandboxManager, ExecutionEnv)
 │    │    └─► plugins/         (preToolUse / postToolUse hooks)
 │    ├─► query/QueryEngineState.ts    (ConversationState → SessionTree)
 │    ├─► query/QueryEngineCompaction.ts (CompactionHandler → compaction/)
 │    ├─► query/QueryEngineMemory.ts   (MemoryHandler → memory/)
 │    ├─► query/QueryEngineError.ts    (ErrorHandler → circuitBreaker)
 │    ├─► services/cachePrefix.ts      (CachePrefixService)
 │    ├─► services/behavioralAdapter.ts
 │    └─► services/userProfile.ts
 ├─► agp/                       (Autogenesis Protocol)
 │    ├─► registry.ts           (Agent/solution registry)
 │    ├─► sepl/                 (Self-Evolving Pipeline: reflect→select→improve→evaluate→commit)
 │    ├─► strategies/           (prompt-evolution, solution-evolution)
 │    ├─► adapters/             (agent, env, mem, prompt, tool adapters)
 │    └─► version-manager.ts   (Version tracking and rollback)
 └─► ui/                        (renderInkUI / REPL / JSON mode)
      ├─► components/App.ts
      ├─► layout.ts             (LayoutManager)
      ├─► overlay-manager.ts
      └─► event-bus.ts          (UIEventBus)
```

## Circular Dependency Prevention

Modules avoid circular imports through two strategies:

1. **Protocol files**: Each module defines its public types in `protocol.ts`. Other modules import types from protocol, not implementation.
2. **Interface abstractions**: The orchestrator uses `QueryEngineLike` interface instead of importing QueryEngine directly. The tool executor uses `ExecutionEnv` interface instead of concrete implementations.

```
orchestrator/ ──imports──► query/protocol.ts (QueryEngineLike)
                             NOT query/QueryEngine.ts

executors/    ──imports──► services/execution-env.ts (interface)
                             NOT services/execution-env-local.ts (impl)
```

## Data Flow: User Message → Tool Execution → Response

```
1. User types message
2. QueryEngine.submitMessage(message) → AsyncGenerator<AgentEvent>
3. State: idle → compacting
   └─ CompactionHandler.check() → compact if needed
4. State: compacting → streaming
   └─ API client.streamChat(messages, tools) → LLMStreamEvent[]
5. State: streaming → deciding
   └─ Parse response: text / tool_calls / thinking
6. State: deciding → executing
   └─ ToolExecutor.executeParallel(toolCalls)
      ├─ For each tool:
      │  ├─ plugin.preToolUse() hook
      │  ├─ tool.prepare()
      │  ├─ permissionEngine.check()
      │  ├─ sandboxManager.wrapCommand() [if Bash/Run]
      │  ├─ tool.call()
      │  ├─ tool.finalize()
      │  └─ plugin.postToolUse() hook
      └─ Budget check after each result
7. State: executing → streaming (loop if tool results)
   └─ Append tool results to messages, goto step 4
8. State: executing → completed
   └─ Yield final text response
9. State: completed → idle
   └─ postTurnHooks fire
   └─ MemoryHandler.extract() if idle
```
