# Changelog

All notable changes to KC-CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
