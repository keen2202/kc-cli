# KC-CLI

AI-powered intelligent CLI agent system for software development. v3.2.0, TypeScript, ESM.

> This file is the single source of truth for agent instructions. `CLAUDE.md` references this file — edit here, never duplicate content there.

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
- **Core loop**: `src/query/QueryEngine.ts` — Facade over 13 sub-modules (State, Compaction, Memory, Error, Events, Execution, Planning, Importance, RuntimeControl, Decision, TurnControl, Streaming, Verification); idle→compact→stream→decide→execute state machine with steering support; protocol types in `query/protocol.ts`
- **Tools**: `src/tools/` — 23 registered tools (21 under `src/tools/` + TeamCreate + LSP in `TOOL_MANIFEST`) using `buildTool()` factory with Zod schemas, single-phase execution (`call` + permission check + plugin preToolUse/postToolUse hooks)
- **API clients**: `src/api/` — 11 provider endpoints served by 3 client classes (`AnthropicClient`, `OpenAICompatibleClient`, `OllamaClient`); the other 8 providers (OpenAI, DeepSeek, Qwen, GLM, Mimo, Kimi, Step, Gemini) are OpenAI-compatible configuration endpoints; extend `BaseApiClient`; protocol types in `api/protocol.ts`
- **Permissions**: `src/permissions/` — 6-step deny-first with bypass-immune protected paths + plugin-contributed rules (Step 3.5)
- **Sandbox**: `src/services/sandbox*.ts` — Docker/Bubblewrap/seccomp backends with fallback chain
- **Orchestrator**: `src/orchestrator/` — Multi-agent with `AsyncLocalStorage` isolation; protocol types in `orchestrator/protocol.ts`
- **Memory**: `src/memory/` — File-based persistent memory with YAML frontmatter, 4 types (user/feedback/project/reference), relevance search, LLM auto-extraction (consolidation parked — see `docs/specs/memory-consolidation-pending.md`)
- **UI**: `src/ui/` — ink/React terminal UI with theme system, focus-stack dialogs, multi-panel layout, steer mode (Ctrl+I)
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
- **Executors**: `src/executors/` — Tool execution orchestration (`toolExecutor.ts`)
- **Hooks**: `src/hooks/` — Post-turn hook processing (`postTurnHooks.ts`)
- **Utils**: `src/utils/` — Shared utilities (error handling, path security, semaphore, token estimation, format)
- **ACP**: `src/acp/` — Agent Communication Protocol server and handlers
- **AGP**: `src/agp/` — Evolution infrastructure (reserved): global registry, trace manager, prompt adapter, and evidence-bundle types (SEPL self-evolution loop removed in audit round3 T09 — dormant code, zero callers)

## Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Path alias: `@/*` → `src/*`
- Tool inputs use Zod schemas for validation
- Tests live primarily in the `test/` tree mirroring `src/` structure (`test/**/*.test.{ts,tsx}`); a smaller set of co-located `src/**/*.test.ts` files also runs (see `include` in `vitest.config.ts`)
- Coverage thresholds: lines 60%, branches 50%, functions 60%, statements 60%
- Config priority: defaults < user (`~/.kc-cli/settings.json`) < project (`.kc-cli/settings.json`) < env (`KC_*`) < CLI args
- Protocol-first: each module defines public types in `protocol.ts`
- **File naming decision table** (audit round3 T26/L3 — applies to NEW code only; no bulk renames):
  | File content | Name | Examples |
  |---|---|---|
  | Default class export / framework-style module | PascalCase matching the export | `QueryEngineDecision.ts` |
  | Pure functions / helpers / factories | camelCase or kebab-case, ONE style per directory | `query/` is all-PascalCase → stay there; `utils/`, `services/` are camel/kebab |
  | Public type contracts of a module | always `protocol.ts` | `state/protocol.ts`, `api/protocol.ts` |
  - `src/Tool.ts` adjudication (T26): **name kept** despite mixed conventions — `buildTool` is imported by 20+ tool files; renaming costs more than the inconsistency. Do not add sibling factories under conflicting names.
  - Manager/Service/Handler suffixes overlap historically; for new classes pick the suffix matching the dominant verb of its API (`XxxStore`, `XxxTracker`, `XxxGate`) rather than defaulting to Manager.

## Risk Boundaries

What the permission system (`src/permissions/`) actually enforces on agent behavior:

- **Protected paths are bypass-immune** (`protectedPaths.ts`): credential/secret files (`.env`, `.credentials`, `.secrets`, `.ssh/`, `.gnupg/`, `.aws/credentials`, `.kube/config`, `.docker/config.json`), system files (`/etc/passwd|shadow|ssh`, `/proc/`, `/sys/`), shell profiles, `.git/objects|refs`, and Windows equivalents (SAM hives, `drivers/etc/hosts`). Access always escalates to `ask` — even in bypass mode. Symlinks are resolved before matching; compound commands (`&&`, `;`, `|`) are split and each part checked.
- **System write directories are denied** for write-capable tools (FileWrite/FileEdit/Bash/Run/NotebookEdit): `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `C:\Windows\`, `C:\Program Files*\`, `C:\ProgramData\`.
- **Destructive command categories are auto-denied** (`classifier.ts` `DESTRUCTIVE_PATTERNS`): recursive/force delete (`rm -rf`), filesystem format (`mkfs`), raw disk write (`dd of=`), partitioning (`fdisk`/`parted`), recursive `chmod`/`chown`, firewall (`iptables`), service control (`systemctl stop|disable|mask`), bootloader changes, LVM creation, shutdown/reboot.
- **Engine order** (`engine.ts`, deny-first): deny rules → tool check → security-critical (bypass-immune) → plugin rules (Step 3.5, can tighten but never loosen) → bypass → allow rules → ask rules → mode default. Bypass mode requires explicit `KC_ALLOW_BYPASS=1` and never overrides security-critical checks. `WebFetch` to internal/private network URLs is denied (SSRF guard).

## Key Types

- `ToolDefinition` — Tool interface (`call` + optional `checkPermissions`; no per-tool prepare/finalize hooks)
- `AgentEvent` — Discriminated union for state machine events (includes thinking_delta, cache_status, steered)
- `ChatMessage` / `ToolCall` — Message types for LLM conversation
- `PermissionResult` — Permission decision (allow/deny/ask)
- `MemoryEntry` — Persistent memory with YAML frontmatter
- `KCError` — Typed error with stable ErrorCode (20 codes: api_rate_limit, tool_timeout, budget_exceeded, etc.)
- `ExecutionEnv` — Swappable FileSystem + Shell abstraction for tool backends
- `SessionTree` — Non-linear conversation tree with branching, checkout, merge

## Testing

- Framework: vitest
- Test locations: `test/**/*.test.{ts,tsx}` (main body, mirrors `src/`) plus co-located `src/**/*.test.ts`
- Mock LLM: `MockLLMClient` for preset responses and error injection
- Mock ExecutionEnv: `MockFileSystem` + `MockShell` for tool testing without real I/O
- Sandbox tests: `sandbox-e2e.test.ts` for isolation verification
- Multi-agent tests: `multi-agent.test.ts` for orchestrator coverage
- Reproduce a single failing test: `npx vitest run <file-path>` (add `-t "<test name>"` to narrow to one case)
- **Soft-skip ban** (audit round3 T03): environment-dependent tests must skip via `it.skipIf`/`describe.skipIf` so they appear in the reporter's skipped count — silent early-`return` inside a test body, or runtime-conditional `try { await import() }` + `describe.skip` downgrades, are forbidden; a green CI run with hidden skips is treated as unverified. CI runs a dedicated `sandbox-e2e` job (ubuntu + bubblewrap) where the backend exists and skips indicate regressions.
- **Mock ban for security-critical modules** (audit round3 C4): do not `vi.mock` permissions/sandbox/protectedPaths and then assert call counts on the mocks — such mock-asserts-mock cases are invalid coverage; drive the real implementation with `MockFileSystem`/`MockShell` instead.

### UI red lines (ui-structural-hardening, non-negotiable)

- **Any UI behavior change MUST ship with a behavior-level test** in `test/ui/behavior/**` (real AppRoot rendered via the harness). Arithmetic-only test edits (tweaking layout math assertions) do NOT count as coverage.
- **ESC semantics**: the focus stack (`src/ui/focus-stack.ts`) is the single arbiter — never add a second `useInput` for keys, never bind `escape` in the keybinding schema; changes to ESC behavior must update `esc-matrix.test.tsx`.
- **Layout truth**: Yoga (ink flexbox) owns all measurement; `src/ui/layout.ts` is policy-only — never reintroduce reserved-height constants or parent-computed child heights (guarded by `layout.test.ts` and `layout-anchor.test.tsx`).
- **Data contracts** live in `src/ui/view-protocol.ts` only; never import contracts from component files (enforced by `dead-path-guard.test.ts` — its deny/exemption lists are the reviewed source of truth).

## AI Debugging

- **Structured logger**: `src/services/logger.ts` — JSON lines written to **stderr** (`console.error`) by default; fields: `timestamp`, `level`, `module`, `message`, optional `correlationId` and `data`. Pre-built module loggers (`logger.api`, `logger.permissions`, `logger.query`, …) stamp the `module` field for per-subsystem filtering; `devFormatter` gives human-readable output.
- **Log level**: default `info`; override via env `LOG_LEVEL=debug|info|warn|error` (read at startup in `src/bootstrap/init-sequence.ts`).
- **correlationId**: opt-in — set via `setCorrelationId(id)` or `configureLogger({ correlationId })`; once set, every entry carries it, so one session's logs can be isolated by filtering stderr for that id (`Select-String <id>` / `grep <id>`).

## Documentation

- **Reference**: `docs/repowiki/` — 15 deep-dive documents covering all subsystems (Home, Architecture, Query-Engine, Tools-System, API-Clients, Permission-System, Sandbox, Orchestrator, Memory-System, Plugin-System, UI-System, State-Management, Configuration, Testing, Development-Guide)
- **Guides**: `docs/guides/` — Tool development, API clients, MCP, LSP, plugins, migration, SWE-bench
- **Specs**: `docs/specs/` — Hardening/optimization specs and task breakdowns (architecture, UI structural, intent-context, memory LLM extraction, safety verification)
