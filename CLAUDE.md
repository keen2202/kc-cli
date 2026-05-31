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
- **Core loop**: `src/query/QueryEngine.ts` — idle→compact→stream→decide→execute state machine with steering support
- **Tools**: `src/tools/` — 21 built-in tools using `buildTool()` factory with Zod schemas, two-phase execution (prepare/execute/finalize)
- **API clients**: `src/api/` — Anthropic, OpenAI-compatible, Ollama; extend `BaseApiClient`; protocol types in `api/protocol.ts`
- **Permissions**: `src/permissions/` — 6-step deny-first with bypass-immune protected paths + plugin-contributed rules (Step 1.5)
- **Sandbox**: `src/services/sandbox*.ts` — Docker/Bubblewrap/seccomp backends with fallback chain
- **Orchestrator**: `src/orchestrator/` — Multi-agent with `AsyncLocalStorage` isolation; protocol types in `orchestrator/protocol.ts`
- **Memory**: `src/memory/` — File-based persistent memory (user/feedback/project/reference types)
- **UI**: `src/ui/` — Terminal UI with theme system, mouse support, multi-panel layout, steer mode (Ctrl+I)
- **LSP**: `src/lsp/` — Language server integration (TS, Go, Python, Rust, Java, C++, Ruby)
- **MCP**: `src/mcp/` — Model Context Protocol client with stdio/HTTP transports
- **State**: `src/state/` — Observable state store, state machine validation, session tree for branching conversations
- **Plugins**: `src/plugins/` — Contribution-based plugin system (tools, hooks, permissionRules, prompts, mcpServers)
- **Budget**: `src/services/budget.ts` — Proactive token budget enforcement per session/turn/tool-result
- **Compaction**: `src/services/compaction/` — Tiered engine (CachedMicro→Snip→Full→Force) with priority-based selection
- **ExecutionEnv**: `src/services/execution-env.ts` — Swappable FileSystem/Shell abstraction for tools

## Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Path alias: `@/*` → `src/*`
- Tool inputs use Zod schemas for validation
- Tests in `src/` co-located as `*.test.ts` files
- Coverage thresholds: lines 60%, branches 50%, functions 60%, statements 60%
- Config priority: defaults < user (`~/.kc-cli/settings.json`) < project (`.kc-cli/settings.json`) < env (`KC_*`) < CLI args
- Protocol-first: each module defines public types in `protocol.ts`, legacy `types/` files are re-export barrels

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
