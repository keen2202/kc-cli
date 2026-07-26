# KC-CLI

AI-powered intelligent CLI agent system for software development. v3.2.0, TypeScript, ESM.

## Quick Commands

```bash
npm run dev            # Development mode
npm run typecheck      # Type check (tsc --noEmit)
npm test               # Run tests (vitest)
npm run test:coverage  # Tests with coverage report
npm run build          # Build TypeScript
npm run kc             # Start interactive REPL
```

## Architecture

- **Entry**: `src/main.ts` → REPL + CLI command handling
- **Core loop**: `src/query/QueryEngine.ts` — Facade over 4 sub-modules (State, Compaction, Memory, Error); idle→compact→stream→decide→execute state machine with steering support; protocol types in `query/protocol.ts`
- **Tools**: `src/tools/` — 22 built-in tools using `buildTool()` factory with Zod schemas, two-phase execution (prepare/execute/finalize)
- **API clients**: `src/api/` — 11 providers (Anthropic, OpenAI, DeepSeek, Qwen, GLM, Mimo, Kimi, Step, Gemini, OpenAI-compatible, Ollama); extend `BaseApiClient`; protocol types in `api/protocol.ts`
- **Permissions**: `src/permissions/` — 6-step deny-first with bypass-immune protected paths + plugin-contributed rules (Step 1.5)
- **Sandbox**: `src/services/sandbox*.ts` — Docker/Bubblewrap/seccomp backends with fallback chain
- **Orchestrator**: `src/orchestrator/` — Multi-agent with `AsyncLocalStorage` isolation; protocol types in `orchestrator/protocol.ts`
- **Memory**: `src/memory/` — File-based persistent memory with YAML frontmatter, 4 types (user/feedback/project/reference), relevance search, auto-extraction and consolidation
- **UI**: `src/ui/` — Terminal UI with theme system, mouse support, multi-panel layout, steer mode (Ctrl+I)
- **LSP**: `src/lsp/` — Language server integration (TS, Go, Python, Rust, Java, C++, Ruby)
- **MCP**: `src/mcp/` — Model Context Protocol client with stdio/HTTP transports
- **State**: `src/state/` — Observable state store (`store.ts`), state machine validation (`machine.ts`), session tree for branching conversations (`session-tree.ts`), event types (`events.ts`); protocol types in `state/protocol.ts`
- **Plugins**: `src/plugins/` — Contribution-based plugin system (tools, hooks, permissionRules, prompts, mcpServers)
- **Compaction**: `src/services/compaction/` — Tiered engine (CachedMicro→Snip→Full→Force) with priority-based selection
- **Cache**: `src/services/cache/` — TieredCache (memory + disk), LRU eviction, compression, consistency
- **Budget**: `src/services/budget.ts` — Proactive token/cost budget enforcement per session/turn/tool-result/sub-agent
- **ExecutionEnv**: `src/services/execution-env.ts` — Swappable FileSystem/Shell abstraction for tools
- **Commands**: `src/commands/` — CLI command handlers (/branch, /checkout, /history)
- **Metrics**: `src/metrics/` — Cache hit/miss tracking
- **Terminal**: `src/terminal/` — Terminal utilities
- **Executors**: `src/executors/` — Tool execution orchestration (`toolExecutor.ts`)
- **Hooks**: `src/hooks/` — Post-turn hook processing (`postTurnHooks.ts`)
- **Utils**: `src/utils/` — Shared utilities (error handling, path security, semaphore, token estimation, format)
- **ACP**: `src/acp/` — Agent Communication Protocol server and handlers
- **AGP**: `src/agp/` — Autogenesis Protocol for self-evolving multi-agent system (adapters, SEPL evolution loop, strategies)

## Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Path alias: `@/*` → `src/*`
- Tool inputs use Zod schemas for validation
- Tests in `src/` co-located as `*.test.ts` files
- Coverage thresholds: lines 60%, branches 50%, functions 60%, statements 60%
- Config priority: defaults < user (`~/.kc-cli/settings.json`) < project (`.kc-cli/settings.json`) < env (`KC_*`) < CLI args
- Protocol-first: each module defines public types in `protocol.ts`

## Key Types

- `ToolDefinition` — Tool interface with optional `prepare`/`finalize` methods
- `AgentEvent` — Discriminated union for state machine events (includes thinking_delta, cache_status, steered)
- `ChatMessage` / `ToolCall` — Message types for LLM conversation
- `PermissionResult` — Permission decision (allow/deny/ask)
- `MemoryEntry` — Persistent memory with YAML frontmatter
- `Result<T, E>` — Sum type for explicit error handling (ok/err)
- `KCError` — Typed error with stable ErrorCode (18 codes: api_rate_limit, tool_timeout, budget_exceeded, etc.)
- `ExecutionEnv` — Swappable FileSystem + Shell abstraction for tool backends
- `SessionTree` — Non-linear conversation tree with branching, checkout, merge

## Testing

- Framework: vitest
- Mock LLM: `MockLLMClient` for preset responses and error injection
- Mock ExecutionEnv: `MockFileSystem` + `MockShell` for tool testing without real I/O
- Sandbox tests: `sandbox-e2e.test.ts` for isolation verification
- Multi-agent tests: `multi-agent.test.ts` for orchestrator coverage

### UI red lines (ui-structural-hardening, non-negotiable)

- **Any UI behavior change MUST ship with a behavior-level test** in `test/ui/behavior/**` (real AppRoot rendered via the harness). Arithmetic-only test edits (tweaking layout math assertions) do NOT count as coverage.
- **ESC semantics**: the focus stack (`src/ui/focus-stack.ts`) is the single arbiter — never add a second `useInput` for keys, never bind `escape` in the keybinding schema; changes to ESC behavior must update `esc-matrix.test.tsx`.
- **Layout truth**: Yoga (ink flexbox) owns all measurement; `src/ui/layout.ts` is policy-only — never reintroduce reserved-height constants or parent-computed child heights (guarded by `layout.test.ts` and `layout-anchor.test.tsx`).
- **Data contracts** live in `src/ui/view-protocol.ts` only; never import contracts from component files (enforced by `dead-path-guard.test.ts` — its deny/exemption lists are the reviewed source of truth).

## Documentation

- **Reference**: `docs/repowiki/` — 15 deep-dive documents covering all subsystems (Home, Architecture, Query-Engine, Tools-System, API-Clients, Permission-System, Sandbox, Orchestrator, Memory-System, Plugin-System, UI-System, State-Management, Configuration, Testing, Development-Guide)
- **Guides**: `docs/guides/` — Tool development, API clients, MCP, LSP, plugins, migration, SWE-bench
- **Specs**: `docs/specs/` — Architecture optimization, UI event system, NEXT optimization
- **Tasks**: `docs/tasks/` — Active task breakdowns (tech review V2, self-evolving, v3.1/v4)
- **Archive**: `docs/archive/` — Historical completed specs, tasks, and reviews (v2/v3 upgrades, test coverage, compliance)
