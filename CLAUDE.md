# KC-CLI

AI-powered intelligent CLI agent system for software development. v3.1.0, TypeScript, ESM.

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
- **Core loop**: `src/query/QueryEngine.ts` — idle→compact→stream→decide→execute state machine
- **Tools**: `src/tools/` — 21 built-in tools using `buildTool()` factory with Zod schemas
- **API clients**: `src/api/` — Anthropic, OpenAI-compatible, Ollama; extend `BaseApiClient`
- **Permissions**: `src/permissions/` — 6-step deny-first with bypass-immune protected paths
- **Sandbox**: `src/services/sandbox*.ts` — Docker/Bubblewrap/seccomp backends with fallback chain
- **Orchestrator**: `src/orchestrator/` — Multi-agent with `AsyncLocalStorage` isolation
- **Memory**: `src/memory/` — File-based persistent memory (user/feedback/project/reference types)
- **UI**: `src/ui/` — Terminal UI with theme system, mouse support, multi-panel layout
- **LSP**: `src/lsp/` — Language server integration (TS, Go, Python, Rust, Java, C++, Ruby)
- **MCP**: `src/mcp/` — Model Context Protocol client with stdio/HTTP transports
- **State**: `src/state/` — Observable state store with state machine validation

## Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Path alias: `@/*` → `src/*`
- Tool inputs use Zod schemas for validation
- Tests in `src/` co-located as `*.test.ts` files
- Coverage thresholds: lines 92.9%, branches 84.8%, functions 93.6%, statements 92.3%
- Config priority: defaults < user (`~/.kc-cli/settings.json`) < project (`.kc-cli/settings.json`) < env (`KC_*`) < CLI args

## Key Types

- `ToolDefinition` — Tool interface (name, description, input schema, execute)
- `AgentEvent` — Discriminated union for state machine events
- `ChatMessage` / `ToolCall` — Message types for LLM conversation
- `PermissionResult` — Permission decision (allow/deny/ask)
- `MemoryEntry` — Persistent memory with YAML frontmatter

## Testing

- Framework: vitest
- Mock LLM: `MockLLMClient` for preset responses and error injection
- Sandbox tests: `sandbox-e2e.test.ts` for isolation verification
- Multi-agent tests: `multi-agent.test.ts` for orchestrator coverage
