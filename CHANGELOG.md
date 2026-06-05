# Changelog

All notable changes to KC-CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-06-05

### 🧬 Autogenesis Protocol (AGP)

- **Self-evolving multi-agent system**: Full AGP implementation with SEPL pipeline (reflect → select → improve → evaluate → commit)
- **Adapters**: Agent, environment, memory, prompt, and tool adapters for evolution integration
- **Strategies**: Prompt evolution and solution evolution strategies
- **Version management**: Version tracking with rollback capability
- **Audit logging**: Complete execution trace and audit trail
- **Context management**: Dynamic context handling for evolution cycles

### 🔧 Engineering — Types Migration

- **Removed `src/types/`**: Eliminated intermediate re-export barrel layer (7 files)
  - `errors.ts` → `src/utils/errors.ts` (14 consumers updated)
  - `result.ts` → `src/utils/result.ts` (5 consumers updated)
  - `events.ts` → `src/state/events.ts` (2+ consumers updated)
  - Deleted re-export barrels: `message.ts`, `tools.ts`, `permissions.ts`, `orchestrator.ts` (78 consumers migrated to direct `protocol.ts` imports)
- **Protocol-first enforced**: All modules now import types directly from their canonical `protocol.ts` source

### 📝 Documentation Reorganization

- **Deleted `docs/core/`**: 3 outdated files superseded by repowiki
- **Created `docs/archive/`**: 13 historical documents moved (completed specs, tasks, reviews)
- **Cleaned guides**: Removed outdated `ui-guide.md` (v2), kept 7 active guides
- **Updated repowiki**: Added AGP module to Architecture and Home pages
- **Updated specs**: Fixed `src/types/` references in architecture-optimization-spec and NEXT_OPTIMIZATION_SPEC

### 📦 Dependencies

- No new dependencies

## [3.1.0] - 2026-05-22

### 🧠 Self-Evolving Agent System (TASK-050 through TASK-068)

- **Phase 1 - Self-Healing Core**:
  - Enhanced error classifier with HTTP status code inspection and retry-after support
  - Circuit breaker service for external service resilience
  - State validator for consistency checks
  - Timeout handling improvements
  - Anchor protection for critical paths

- **Phase 2 - Memory System**:
  - Wired up memory stubs for extraction and consolidation
  - Enhanced memory extraction with confidence scoring and deduplication
  - Adaptive relevance scoring with feedback tracking
  - Memory quality pipeline with validation and pruning

- **Phase 3 - Observability**:
  - Health check service with circuit breaker integration
  - Auto-reconnect service with exponential backoff
  - Session metrics collector for behavioral adaptation
  - Retry expansion with loop-based approach

- **Phase 4 - Behavioral Adaptation**:
  - User profile service for behavioral adaptation
  - Behavioral adapter for system prompt and tool hints
  - Parameter auto-tuning service with conservative adjustments

- **Phase 5 - Out-of-the-Box Experience**:
  - First-run experience with guided tour
  - Auto-configuration with project type detection
  - Tool hints and prompt adaptation

### 🧪 Test Coverage

- **3131 tests passing** across 152 test files (up from 1074)
- **Coverage improvements**: Lines 92.9%, Statements 92.3%, Functions 93.6%, Branches 84.8%

### 🔧 Engineering

- **Behavioral adapter integration**: Wired into QueryEngine and main.ts
- **TypeScript fixes**: Resolved type errors in cache system and Zod schema converter
- **Test reliability**: Fixed test isolation issues in orchestrator backend

## [3.0.0] - 2026-05-17

### 🛡️ Sandbox Deepening

- **Sandbox escape detection**: New `SandboxProbe` with 4 verification tests (filesystem isolation, network isolation, process isolation, privilege escalation)
- **Runtime resource monitoring**: `SandboxMonitor` tracks Docker container stats (CPU, memory, network, I/O) and host `/proc` metrics
- **Docker image management**: `ImageManager` for pulling, listing, pruning, and inspecting sandbox images
- **Windows sandbox**: Native Windows sandbox support via job objects (`WindowsSandbox`)

### 🎨 UI Maturity

- **Theme system**: `Theme` module with 5 built-in themes (default, monokai, solarized, dracula, nord)
- **Mouse support**: `MouseHandler` with SGR-encoded mouse event parsing for click, scroll, and drag
- **Multi-panel layout**: `LayoutManager` with 4 layout modes (chat, split, sidebar, focus)

### 🔌 Language Expansion

- **Ruby**: Added Ruby language server support (solargraph)
- **Language registry**: Centralized `LanguageRegistry` for managing language server configurations

### 🧠 Self-Evolving Capabilities

- **Behavioral adaptation**: `BehavioralAdapter` learns from usage patterns to adjust tool parameters
- **Memory quality assessment**: `MemoryQuality` service scores and filters extracted memories
- **First-run experience**: Guided tour for new users with project type detection
- **Auto-configuration**: Automatic project type detection and initial config generation
- **Parameter auto-tuning**: `ParamTuner` dynamically adjusts `max_tokens`, `temperature`, `top_p` per model
- **Session metrics**: `SessionMetrics` collects per-session performance and usage data
- **Health check**: `HealthCheck` service monitors system health and connectivity

### 🧪 Test Coverage

- **3131 tests passing** across 152 test files (up from 874)
- **API client tests**: Full coverage for AnthropicClient, OpenAICompatibleClient, OllamaClient
- **UI integration tests**: Component rendering and interaction tests
- **Coverage thresholds met**: Lines 92.9%, Statements 92.3%, Functions 93.6%, Branches 84.8%
- **Reduced `as any`**: 53 → 23 (↓57%)

### 🔧 Engineering

- **Structured logging**: `Logger` service with configurable levels and output formats
- **Auto-reconnect**: Automatic reconnection for LSP and MCP connections
- **Circuit breaker**: `CircuitBreaker` for external service calls with configurable thresholds
- **Error classification**: `ErrorClassifier` for intelligent retry decisions
- **Cache system**: Multi-tier cache (`TieredCache`) with compression and consistency checks

### 📦 Dependencies

- No new dependencies

### 📝 Documentation

- New: `docs/self-evolving-tasks.md` — Self-evolving agent task breakdown (TASK-050 through TASK-068)
- Updated: `docs/v3-improvement-spec.md` — v3 improvement specification
- Updated: `docs/v3-tasks.md` — v3 task tracking

## [2.0.0] - 2026-05-14

### 🔒 Security — Sandbox System Integration (Phase 1)

- **ToolExecutor sandbox integration**: All Bash/Run commands now pass through `SandboxManager.wrapCommand()` before execution
- **Docker sandbox backend**: New `DockerSandbox` backend with `--network none`, `--read-only`, `--memory`, `--cpus` isolation
- **seccomp profile**: Syscall whitelist (`seccomp-profile.json`) for Bubblewrap and Docker backends — blocks `ptrace`, `mount`, `umount`, `reboot`, `swapon`
- **Sandbox policy system**: Per-tool sandbox policies (`sandbox-policy.ts`) with pattern-based rules
- **Backend fallback chain**: Docker → Bubblewrap → Seccomp → Noop with graceful degradation
- **Resource limits**: Memory (512MB default), CPU time (60s default), network isolation
- **Sandbox metadata**: Tool results now include `sandboxed` and `sandboxBackend` fields

### 🎨 UI — TUI Rewrite (Phase 2)

- **Sidebar layout**: New `Sidebar` component with Tools/Files/Tasks/Memory four-module panel
- **FileTree**: Recursive file tree with LSP diagnostic markers (red ⚠ for errors)
- **DiffPreview**: Multi-file diff viewer with color-coded additions/deletions, `/accept` `/reject` commands
- **CommandPalette**: Fuzzy-search command palette (`/palette`) with keyboard navigation
- **ModelSelector**: Interactive model switcher (`/model`) with 7 providers (DeepSeek/Anthropic/OpenAI/Qwen/GLM/OAI-compat/Ollama)
- **Virtual scrolling**: Long conversations (>100 messages) paginate for performance
- **Streaming throttle**: 16ms/frame output throttling for smooth rendering
- **Diff worker**: Diff computation offloaded to `worker_threads`

### 🔌 LSP Integration Enhancement (Phase 2.5)

- **DocumentManager**: Reliable document lifecycle (`openDocument`/`updateDocument`/`closeDocument`) with version tracking
- **CompletionProvider**: LSP `textDocument/completion` with snippet expansion and `sortText` ordering
- **NavigationProvider**: `textDocument/definition`, `textDocument/references`, `textDocument/rename`
- **CodeActionProvider**: `textDocument/codeAction` for quick fixes (missing imports, spelling corrections)
- **LSPTool**: Unified tool exposing `getCompletions`, `getDiagnostics`, `getDefinition`, `getReferences`, `rename`
- **Diagnostics reliability**: Replaced `setTimeout(500)` with `publishDiagnostics` notification listener
- **Extended language support**: Java (jdtls), C++ (clangd) added to TypeScript/JavaScript/Go/Python/Rust

### 🧠 Model Adaptation (Phase 3)

- **Provider-specific prompts**: Customized system prompts for Anthropic (`<thinking>` tags), OpenAI (`parallel_tool_calls`), Qwen/GLM (Chinese-optimized)
- **Task-specific prompts**: Different prompt templates for code generation, debugging, refactoring, documentation
- **ProviderCapabilities**: Automatic capability detection per provider
- **Token estimation**: Replaced character-based heuristic with `js-tiktoken` (cl100k_base, o200k_base, anthropic encodings)
- **Dynamic parameter tuning**: `max_tokens`, `temperature`, `top_p` auto-adjusted per model

### 🧪 Test Coverage (Phase 3.5)

- **874 tests passing** across 54 test files (up from ~450)
- **Permission system**: Full 6-step decision flow, wildcard matching, interaction tests
- **QueryEngine**: State machine coverage from 9.34% to 70%+
- **ToolExecutor**: Permission checks, timeout handling, parallel execution, sandbox integration
- **MockLLMClient**: Test utility for preset responses, error injection, streaming simulation
- **Path security**: Directory traversal, symlink resolution, Unicode normalization tests

### 🔗 Integration Tests (Phase 4)

- **Sandbox E2E** (`sandbox-e2e.test.ts`): Filesystem isolation, network isolation, resource limits, command injection prevention, backend fallback chain
- **LSP E2E** (`lsp-e2e.test.ts`): Language detection, LSP connection, diagnostics, hover, go-to-definition, DocumentManager, CompletionProvider
- **Multi-agent** (`multi-agent.test.ts`): Permission cascading, EventBus coordination, ResultAggregator, tool filtering, agent definitions
- **Full workflow** (`full-workflow.test.ts`): Tool execution pipeline, MockLLM integration, memory system, sandbox coordination, error recovery

### 📦 Dependencies

- Added: `js-tiktoken ^1.0.21`
- Added: `@vitest/coverage-v8 ^4.1.5` (dev)

### 📝 Documentation

- New: `CHANGELOG.md` — this file
- New: `docs/migration-guide.md` — v1 → v2 migration guide
- New: `docs/lsp-integration.md` — LSP integration documentation
- New: `docs/ui-guide.md` — UI usage guide
- Updated: `docs/architecture.md` — v2 architecture diagram
- Updated: `docs/sandbox-security.md` — Docker backend, seccomp profiles, policy system

## [0.1.0] - 2026-05-01

### Added

- Initial release
- 21 built-in tools
- Multi-LLM support (Anthropic, OpenAI, Qwen, GLM, Ollama)
- Permission system (6-step deny-first)
- Multi-agent orchestration
- File-based memory system
- Auto-compaction (micro + full)
- MCP integration
- Plugin system
- Interactive REPL with slash commands
