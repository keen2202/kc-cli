# KC-CLI: Intelligent CLI Agent System

An AI-powered intelligent CLI assistant for software development, inspired by Claude Code's architecture. Architecture patterns derived from comparative analysis of PilotDeck (OpenBMB) and pi (earendil-works) projects.

## v3.2 Highlights

- 🧬 **Evolution Infrastructure (AGP, reserved)**: global agent/solution registry, execution trace manager (evidence bundles for failure-bridging memory), and prompt adapter — the dormant SEPL self-evolution loop was removed in audit round3 T09
- 🔒 **Sandbox Security**: Shell commands run in isolated sandboxes (Docker/Bubblewrap/seccomp) with network isolation, resource limits, and escape detection. **Hard-fails by default** if no sandbox backend is available — set `KC_SANDBOX_FAIL_IF_NO_SANDBOX=false` to opt out (NOT recommended for production). macOS requires Docker Desktop; Linux needs only `apt install bubblewrap`.
- 🎨 **Redesigned UI**: ink/React terminal UI with sidebar (Tools/Files/Tasks/Memory), diff preview, command palette, focus-stack dialogs, theme system, multi-panel layout
- 🔌 **LSP Integration**: Code completions, diagnostics, go-to-definition, find references, rename, quick fixes for 7 languages
- 🧠 **Smart Model Adaptation**: Provider-specific prompts, dynamic parameter tuning, tiktoken-based token estimation
- 🧪 **4700+ Tests**: Comprehensive test suite across 260 files
- 🛡️ **Runtime Monitoring**: Sandbox resource monitoring (Docker stats, /proc), image management, and probe-based isolation verification
- 🪟 **Windows Sandbox**: Native isolation via Windows Sandbox (WSB)
- 🌳 **Session Tree**: Non-linear conversations with branching, checkout, merge, and branch summaries
- 🎯 **Budget Enforcement**: Proactive token budget limits per session, turn, tool result, and sub-agent
- ⚡ **Tiered Compaction**: Four-engine compaction system (CachedMicro, Snip, Full, Force) with priority-based selection
- 🔀 **Steering System**: Inject messages mid-execution via `steer()` or after completion via `followUp()` (Ctrl+I)
- 🔌 **Contribution Plugins**: Plugin system with 5 contribution types (tools, hooks, permissionRules, prompts, mcpServers)
- 📐 **Protocol-First Design**: Per-module protocol.ts files for clean interface boundaries
- 🧩 **ExecutionEnv Abstraction**: Swappable FileSystem/Shell backends for testable, isolatable tools
- ❌ **Typed Error Handling**: KCError with 20 stable error codes and unified tool error-handling wrappers

## Features

- **Modular Tools**: 23 built-in tools with single-phase execution (`call` + permission check + plugin preToolUse/postToolUse hooks) — Bash, file I/O, file restore, search, Git, SQL, Docker, deployment, task management, sub-agent spawning, team orchestration, and LSP code intelligence
- **Multi-LLM Support**: Anthropic Claude, OpenAI GPT, DeepSeek, Qwen (DashScope), GLM (Zhipu AI), Mimo, Kimi, Step, Google Gemini, OpenAI-compatible, and Ollama (local); 9 stream event types including thinking_delta
- **Permission System**: 6-step deny-first security with bypass-immune safety checks, protected paths, auto-classifier, and plugin-contributed rules (Step 3.5)
- **Sandbox Isolation**: Docker/Bubblewrap/seccomp backends with per-tool policies, seccomp profiles, and resource limits
- **LSP Code Intelligence**: Language server integration for TypeScript, Go, Python, Rust, Java, C++, Ruby
- **Multi-Agent Orchestration**: Spawn sub-agents with isolated QueryEngine instances, permission cascading, event bus coordination, and budget enforcement
- **Memory System**: File-based persistent memory with YAML frontmatter, relevance search, and 4 discrete types (user/feedback/project/reference)
- **Tiered Compaction**: Four-engine system (CachedMicro → Snip → Full → Force) with priority-based selection and result caching
- **Session Tree**: Non-linear conversations with branching (`/branch`), checkout (`/checkout`), merge, and tree visualization (`/history`)
- **Steering**: Inject messages mid-execution via `steer()` or after completion via `followUp()`; Ctrl+I toggle in UI
- **Budget Enforcement**: Proactive token limits per session/turn/tool-result/sub-agent with opt-in BudgetConfig
- **Plugin Contributions**: Plugins can contribute tools, hooks, permission rules, prompt templates, and MCP server configs
- **Typed Errors**: `KCError` with 20 stable codes (api_rate_limit, tool_timeout, budget_exceeded, etc.); never swallow errors silently
- **ExecutionEnv**: Swappable FileSystem/Shell abstraction; MockExecutionEnv for testing without real I/O
- **Session Management**: Session persistence, archival, pruning, and recovery with configurable retention
- **Interactive REPL**: Terminal UI with sidebar, diff preview, command palette, model selector, and steer mode
- **Node.js Compatible**: Requires Node.js 22+ (no Bun required)

## Quick Start

### Prerequisites

- Node.js 22 or higher (required by ink 7; Node 20 reached end-of-life)
- npm or yarn
- API key for your chosen LLM provider
- **Sandbox backend** (default: hard-fail without one):
  - **Linux**: `sudo apt install bubblewrap`
  - **macOS**: Docker Desktop (`brew install --cask docker`)
  - **Windows**: Docker Desktop (`winget install Docker.DockerDesktop`)
  - Or opt out with `KC_SANDBOX_FAIL_IF_NO_SANDBOX=false` (NOT for production)

### Installation

**Prerequisites:** See [Prerequisites](#prerequisites) above — you need Node.js 22+, a sandbox backend, and at least one LLM provider's API key.

```bash
# 1. Clone the repository
git clone <repo-url>
cd kc-cli

# 2. Install dependencies
npm install

# 3. Configure environment (copy the template, then set KC_API_KEY and KC_PROVIDER)
cp .env.example .env

# 4. (Optional) Build TypeScript to dist/ — not required for development
npm run build

# 5. Verify the install
npm run typecheck   # Should finish with no type errors
```

> **Note:** KC-CLI has no global `bin` entry. You always run it from the project
> directory — either through the npm scripts (`npm run kc`) or directly with
> `node dist/main.js` after a build.

**Run it:**

```bash
npm run kc                               # Interactive REPL
npm run kc -- "List all files here"      # Single-prompt mode
# After `npm run build`:
node dist/main.js -- "List all files here"
```

### Configuration

```bash
# DeepSeek (default)
export KC_API_KEY=sk-xxx

# Anthropic
export KC_API_KEY=sk-ant-xxx
export KC_PROVIDER=anthropic

# OpenAI
export KC_API_KEY=sk-xxx
export KC_PROVIDER=openai
export KC_API_BASE_URL=https://api.openai.com/v1

# Qwen (DashScope)
export KC_API_KEY=sk-xxx
export KC_PROVIDER=qwen

# GLM (Zhipu AI)
export KC_API_KEY=xxx
export KC_PROVIDER=glm

# Ollama (local)
export KC_PROVIDER=ollama
export KC_API_BASE_URL=http://localhost:11434

# Sandbox (required by default)
export KC_SANDBOX_BACKEND=bubblewrap   # Linux: bubblewrap | macOS: docker
export KC_SANDBOX_FAIL_IF_NO_SANDBOX=true  # Set false to skip sandbox (dev only)
```

See `.env.example` for all available environment variables.

## Usage

### Interactive Mode

```bash
npm run kc
```

### Single Prompt Mode

```bash
npm run kc -- "Find all TypeScript files"
npm run kc -- "Create a simple HTTP server"
npm run kc -- "Search for 'TODO' in the codebase"
```

### Commands

```bash
npm run kc -- config   # Show configuration
npm run kc -- tools    # List available tools
```

### Options

```
Options:
  -c, --cwd <directory>       Working directory
  -m, --mode <mode>           Permission mode (default/bypassPermissions/auto)
  --model <model>             LLM model to use
  --provider <provider>       LLM provider (anthropic/openai/deepseek/qwen/glm/mimo/kimi/step/gemini/openai-compatible/ollama)
  --max-turns <number>        Maximum number of agent turns
  --max-budget <amount>       Maximum budget in USD
  -v, --verbose               Enable verbose output
  --print                     Print response and exit
  --bare                      Minimal mode
  --bypass-permissions        Bypass all permission
  --profile                   Show startup profile
```

### REPL Slash Commands

- `/help` — Show available commands
- `/clear` — Clear conversation
- `/mode <mode>` — Set permission mode
- `/tools` — List available tools
- `/status` — Show current status
- `/palette` — Command palette with fuzzy search
- `/model` — Interactive model/provider switcher
- `/sidebar [module]` — Toggle sidebar (tools/files/tasks/memory)
- `/diff` — View pending file diffs
- `/accept` / `/reject` — Accept/reject file changes
- `/permission [mode]` — View/switch permission mode
- `/branch` — List or create conversation branches
- `/checkout <id>` — Switch to a different branch
- `/history` — Show conversation tree visualization
- `/exit` — Exit

### Usage Examples

**Explore and understand a codebase**

```bash
npm run kc -- "Explain what the QueryEngine state machine does and list its state transitions"
npm run kc -- "Find everywhere the permission engine is invoked and summarize the decision flow"
```

**Generate and refine code (LSP-aware edits + tests)**

```bash
npm run kc -- "Add a Zod-validated 'retry' option to the BashTool input schema, wire it through, and add a test"
npm run kc -- "Refactor src/services/cache to use TieredCache and update all callers; run typecheck afterward"
```

**Git workflows**

```bash
npm run kc -- "Show the uncommitted changes, then commit them with a conventional-commit message"
```

**Interactive REPL with mid-task steering**

```bash
npm run kc
# Inside the REPL:
> "Set up a vitest test for the memory relevance search"
> /status              # check model, permission mode, and token budget
> Ctrl+I               # toggle steer mode, then type: also cover the recency boost
```

**Multi-agent / team orchestration**

```bash
npm run kc -- "Spawn two sub-agents: one audits the permission engine, one audits the sandbox backend. Merge their findings into a single report."
```

**Non-interactive / CI-friendly**

```bash
npm run kc -- --print "Summarize the open TODOs in src/tools"
npm run kc -- --mode plan "Propose a refactor of the compaction engines"   # read-only plan mode
```

## Architecture

```
src/
├── main.ts                         # Entry point, REPL, command handling
├── Tool.ts                         # Tool factory (buildTool) and result helpers
├── tools.ts                        # Tool registry, assembly, deny-rule filtering
│
├── acp/                            # Agent Communication Protocol
│   ├── handlers.ts                 # ACP request handlers
│   ├── server.ts                   # ACP server implementation
│   ├── types.ts                    # ACP type definitions
│   └── index.ts                    # ACP module entry
│
├── api/                            # LLM API clients
│   ├── BaseApiClient.ts            # Abstract base (streamChat, chat, formatMessages, formatTools)
│   ├── AnthropicClient.ts          # Anthropic SSE streaming with stateful content block parser
│   ├── OpenAICompatibleClient.ts   # OpenAI-compatible (OpenAI, Qwen, GLM, DeepSeek, Mimo, Kimi, Step, Gemini)
│   ├── OllamaClient.ts             # Local Ollama client
│   ├── ThinkingTagParser.ts        # Inline <think> tag stream parser
│   ├── capabilities.ts             # Provider capability detection
│   ├── protocol.ts                 # API module public types
│   ├── index.ts                    # Factory function + provider config defaults
│   └── prompts/
│       ├── prompt-builder.ts       # System prompt construction
│       ├── provider-prompts.ts     # Provider-specific prompt templates
│       ├── task-prompts.ts         # Task-specific prompt templates
│       └── types.ts                # Prompt type definitions
│
├── bootstrap/                      # Initialization
│   ├── Bootstrap.ts                # Bootstrap orchestration
│   ├── app.ts                      # Application wiring
│   ├── init-sequence.ts            # Startup init sequence (log level, services)
│   ├── state.ts                    # GlobalState (session, cwd, permission mode)
│   ├── config.ts                   # 5-layer config loading (defaults < user < project < env < CLI)
│   ├── cli-config.ts               # CLI argument parsing into config
│   ├── autoConfig.ts               # Auto-configuration with project type detection
│   └── profiler.ts                 # Startup performance tracking
│
├── commands/                       # CLI command handlers
│   └── branch.ts                   # /branch, /checkout, /history commands
│
├── executors/                      # Tool execution
│   └── toolExecutor.ts             # Single/parallel execution with timeout + permission checks
│
├── hooks/                          # Post-turn hook system
│   └── postTurnHooks.ts           # Fire-and-forget hooks executed after each turn
│
├── im/                             # IM bridge (instant messaging integration)
│   ├── im-bridge.ts                # IM ↔ agent bridge
│   ├── protocol.ts                 # IM protocol types
│   └── adapters/
│       └── feishu.ts               # Feishu (Lark) adapter
│
├── lsp/                            # Language Server Protocol integration
│   ├── client.ts                   # LSP client manager
│   ├── code-actions.ts             # Code action provider (quick fixes)
│   ├── completion.ts               # Completion provider with snippet expansion
│   ├── diagnostics.ts              # Diagnostic collection and publishing
│   ├── document-manager.ts         # Document lifecycle management
│   ├── language-registry.ts        # Language server registry (TS, Go, Python, Rust, Java, C++, Ruby)
│   ├── navigation.ts               # Go-to-definition, references, rename
│   ├── tool.ts                     # LSP tool exposing completions/diagnostics/definitions
│   ├── types.ts                    # LSP type definitions
│   └── index.ts                    # LSP module entry
│
├── mcp/                            # Model Context Protocol
│   ├── client-manager.ts           # MCP client lifecycle management
│   ├── config-loader.ts            # MCP server configuration loading
│   ├── tool-bridge.ts              # MCP tool bridging to internal tool system
│   ├── types.ts                    # MCP type definitions
│   ├── index.ts                    # MCP module entry
│   └── transports/
│       ├── http.ts                 # HTTP/SSE transport
│       └── stdio.ts                # stdio transport
│
├── memory/                         # Persistent memory system
│   ├── types.ts                    # MemoryEntry, MemoryHeader, SessionSnapshot, MemoryConfig
│   ├── FileMemoryService.ts        # File-based CRUD with atomic writes and security validation
│   ├── integration.ts              # Pre-query memory loading into system prompt
│   ├── relevanceSearch.ts          # Keyword-scoring relevance search with recency boost
│   ├── frontmatter.ts             # YAML frontmatter parser and composer
│   ├── paths.ts                   # Safe file paths with directory traversal prevention
│   ├── scanner.ts                 # Directory scanning for memory files
│   ├── promptBuilder.ts           # Memory context formatting for system prompt
│   ├── protocol.ts                # Memory module public types
│   └── telemetry.ts               # Memory usage tracking
│
├── metrics/                        # Metrics collection
│   └── kvCacheMetrics.ts           # KV-cache hit/miss tracking
│
├── orchestrator/                   # Multi-agent coordination
│   ├── types.ts                    # SubAgentIdentity, SpawnConfig, Runtime, Error types
│   ├── agent-orchestrator.ts       # Central coordinator (spawn, batch, wait, cancel, shutdown)
│   ├── agent-definitions.ts        # Pre-defined agent types
│   ├── event-bus.ts               # In-memory pub/sub with async iterators and Agent scoping
│   ├── permission-cascader.ts      # Child permission derivation (child ≤ parent)
│   ├── result-aggregator.ts        # Multi-agent result collection and summary generation
│   ├── team-create-tool.ts         # Team creation tool
│   └── backends/
│       ├── types.ts               # SubAgentBackend interface
│       └── in-process.ts          # AsyncLocalStorage-based process isolation
│
├── permissions/                    # Security system
│   ├── engine.ts                   # 6-step deny-first decision flow (plugin rules at Step 3.5)
│   ├── rules.ts                    # Rule parsing/matching with wildcard support
│   ├── ruleParser.ts               # Permission rule string parser
│   ├── classifier.ts               # Rule-based auto classifier (quick path + heuristics)
│   ├── commandNormalizer.ts        # Shell command normalization before rule matching
│   ├── readonlyCommands.ts         # Shared read-only command patterns (bash + git)
│   ├── protectedPaths.ts           # Bypass-immune protected path definitions
│   ├── protocol.ts                 # Permission module public types
│   └── interaction.ts              # Interactive user permission handler
│
├── plugins/                        # Plugin system
│   ├── plugin-loader.ts            # Plugin discovery and loading
│   ├── plugin-manager.ts           # Plugin lifecycle management
│   ├── protocol.ts                 # Plugin interface and contribution types
│   ├── types.ts                    # Plugin type definitions (re-export)
│   └── index.ts                    # Plugin module entry
│
├── server/                         # Server components (ACP mode)
│
├── query/                          # Core agent loop
│   ├── QueryEngine.ts              # Facade: idle→compact→stream→decide→execute state machine
│   ├── QueryEngineState.ts         # Conversation state, message storage, SessionTree branching
│   ├── QueryEngineCompaction.ts    # Auto-compaction handler (tiered engine selection)
│   ├── QueryEngineMemory.ts        # Memory integration (pre-query loading, post-turn extraction)
│   ├── QueryEngineError.ts         # Error handling, circuit breaker, retry logic
│   ├── QueryEnginePlanning.ts      # Planning phase handler
│   ├── QueryEngineImportance.ts    # Message importance tagging
│   ├── QueryEngineRuntimeControl.ts # Runtime control (pause/steer/limits)
│   ├── completion-report.ts        # Turn completion reporting
│   └── protocol.ts                 # QueryEngine public types (QueryEngineLike interface)
│
├── services/                       # System services
│   ├── budget.ts                   # Proactive token/cost budget enforcement
│   ├── compaction/                 # Tiered compaction engines
│   │   ├── cached-micro.ts         # Priority 0: hash-cached tool result stripping
│   │   ├── snip.ts                 # Priority 10: remove middle messages
│   │   ├── full.ts                 # Priority 20: LLM-based summarization
│   │   ├── force.ts                # Priority 30: hard truncation
│   │   ├── index.ts                # CompactionHandler with priority selection
│   │   └── types.ts                # CompactionEngine interface
│   ├── cache/                      # Tiered caching system
│   │   ├── CacheManager.ts         # Cache creation and management
│   │   ├── TieredCache.ts          # Multi-tier cache (memory + disk) with LRU eviction
│   │   ├── compression.ts          # Cache value compression
│   │   ├── consistency.ts          # Cache consistency verification
│   │   └── index.ts                # Cache module entry
│   ├── execution-env.ts            # ExecutionEnv interface (FileSystem + Shell)
│   ├── execution-env-local.ts      # Local filesystem + shell implementation
│   ├── execution-env-mock.ts       # Mock implementation for testing
│   ├── cachePrefix.ts              # Stable/ephemeral prompt prefix for cache hits
│   ├── promptCacheMetrics.ts       # Prompt cache hit/miss tracking
│   ├── sessionManager.ts           # Session lifecycle (save, load, archive, prune, stats)
│   ├── replSession.ts              # Non-UI REPL session persistence
│   ├── idleDetection.ts            # Idle detection for post-turn triggers
│   ├── memoryConsolidation.ts      # Consolidation execution logic
│   ├── memoryExtraction.ts         # Memory extraction from conversations
│   ├── memory-extraction-guard.ts  # Guardrails for LLM memory extraction
│   ├── memoryQuality.ts            # Memory quality assessment
│   ├── extractionPrompts.ts        # LLM prompts for memory extraction
│   ├── operation-audit-log.ts      # High-risk operation audit logging
│   ├── error-classifier.ts         # Error classification for retry decisions
│   ├── behavioralAdapter.ts        # Behavioral adaptation based on patterns
│   ├── sessionMetrics.ts           # Session metrics collection
│   ├── stateValidator.ts           # State validation service
│   ├── userProfile.ts              # User profile management
│   ├── firstRun.ts                 # First-run experience with guided tour
│   ├── healthCheck.ts              # System health monitoring
│   ├── logger.ts                   # Structured logging
│   ├── autoReconnect.ts            # Auto-reconnect for LSP/MCP connections
│   ├── circuitBreaker.ts           # Circuit breaker for external services
│   ├── sandbox.ts                  # Sandbox manager (backend selection + fallback chain)
│   ├── sandbox-docker.ts           # Docker sandbox backend
│   ├── sandbox-probe.ts            # Sandbox escape detection probes
│   ├── sandbox-monitor.ts          # Runtime resource monitoring (Docker stats, /proc)
│   ├── sandbox-images.ts           # Docker image management
│   ├── sandbox-windows.ts          # Windows sandbox backend (Windows Sandbox / WSB)
│   ├── sandbox-policy.ts           # Per-tool sandbox policies
│   └── sandbox-profiles.ts         # Seccomp profiles and shell escaping
│
├── state/                          # Observable state management
│   ├── protocol.ts                 # AgentState, AgentStateName, AgentEvent, transitions
│   ├── store.ts                    # ObservableStateStore (immutable updates + listeners)
│   ├── machine.ts                  # AgentStateMachine with transition validation
│   ├── session-tree.ts             # Non-linear conversation tree (branch, checkout, merge)
│   ├── events.ts                   # AgentEvent, MultiAgentEvent, TokenUsage types
│   └── types.ts                    # Re-export barrel
│
├── agp/                            # Evolution infrastructure (reserved; SEPL loop removed in audit round3 T09)
│   ├── protocol.ts                 # AGP public types
│   ├── registry.ts                 # Agent/solution registry
│   ├── context-manager.ts          # Context management for evolution
│   ├── version-manager.ts          # Version tracking and rollback
│   ├── dynamic-manager.ts          # Dynamic agent management
│   ├── trace-manager.ts            # Execution tracing + evidence bundles
│   ├── server-interface.ts         # Server interface
│   ├── sepl/
│   │   └── protocol.ts             # Evidence-bundle type contract (used by trace manager & memory bridging)
│   └── adapters/
│       └── prompt-adapter.ts       # Prompt adapter
│
├── tools/                          # 21 built-in tool implementations + registry
│   ├── AgentTool/                  # Sub-agent spawning
│   ├── AskUserTool/                # Interactive user prompts
│   ├── BashTool/                   # Shell execution with dangerous-command detection
│   ├── ConfigTool/                 # Configuration management
│   ├── DeployTool/                 # Application deployment
│   ├── DockerTool/                 # Docker operations
│   ├── FileEditTool/               # Exact string replacement in files
│   ├── FileReadTool/               # File reading with size limits
│   ├── FileRestoreTool/            # Undo session file writes/edits (snapshot rollback)
│   ├── FileWriteTool/              # File writing with path validation
│   ├── GitTool/                    # Git operations
│   ├── GlobTool/                   # File pattern matching
│   ├── GrepTool/                   # Content search in files
│   ├── MonitorTool/                # System monitoring
│   ├── RunTool/                    # Program compilation and execution
│   ├── SqlTool/                    # Database queries
│   ├── TaskCreateTool/             # Task creation
│   ├── TaskGetTool/                # Task retrieval
│   ├── TodoWriteTool/              # Task list management
│   ├── WebFetchTool/               # URL content fetching
│   ├── WebSearchTool/              # Web search via configurable providers
│   ├── TaskStore.ts                # Shared task state storage
│   ├── registry.ts                 # TOOL_MANIFEST (23 tools incl. TeamCreate + LSP) with lazy loading
│   └── protocol.ts                 # Tool module public types
│
├── terminal/                       # Terminal utilities
│
├── ui/                             # Terminal UI (ink/React)
│   ├── components/
│   │   ├── AppRoot.tsx             # Root application component
│   │   ├── ChatPanel.tsx           # Chat panel composition
│   │   ├── ChatMessagesView.tsx    # Chat message list rendering
│   │   ├── CommandPalette.tsx      # Fuzzy-search command palette
│   │   ├── DiffPreview.tsx         # Pending file diff preview
│   │   ├── Editor.tsx              # Input editor
│   │   ├── HeaderBar.tsx           # Header bar
│   │   ├── Layout.tsx              # Yoga (flexbox) layout composition
│   │   ├── PermissionDialog.tsx    # Interactive permission prompts
│   │   ├── SidebarPanel.tsx        # Sidebar with Tools/Files/Tasks/Memory panels
│   │   ├── StatusBarView.tsx       # Status bar rendering
│   │   ├── ToolCallCard.ts         # Tool call display card
│   │   └── slash-commands.ts       # Slash command registry
│   ├── dialogs/
│   │   └── FilePicker.tsx          # File picker dialog
│   ├── hooks/                      # React hooks (keybindings, focus layer, virtual scroll, …)
│   ├── focus-stack.ts              # Single arbiter for ESC/focus semantics
│   ├── keybinding-manager.ts       # Keybinding schema and dispatch
│   ├── keypress.ts                 # Raw keypress decoding
│   ├── event-bus.ts                # UI event bus
│   ├── event-normalizer.ts         # Agent event → view event normalization
│   ├── view-protocol.ts            # UI data contracts (single source of truth)
│   ├── bridge-protocol.ts          # UI ↔ engine bridge types
│   ├── session-mapper.ts           # Session state → view model mapping
│   ├── diff-viewer.ts              # Multi-file diff viewer
│   ├── formatter.ts                # Text formatting utilities
│   ├── layout.ts                   # Layout policy (Yoga owns all measurement)
│   ├── renderer.tsx                # ink renderer entry
│   ├── spinner.ts                  # Loading spinner
│   ├── statusline.ts               # Status line display
│   ├── theme.ts                    # Theme system (8 built-in themes)
│   └── index.ts                    # UI module entry
│
└── utils/                          # Shared utilities
    ├── errors.ts                   # KCError, ErrorCode (20 codes), ExecError, error helpers
    ├── errorHandling.ts            # Unified error handling wrappers for tools
    ├── api-key.ts                  # API key resolution helpers
    ├── async-helpers.ts            # Async utilities
    ├── fs-walk.ts                  # Filesystem walking helpers
    ├── git.ts                      # Git helpers
    ├── project-detect.ts           # Project type detection
    ├── ssrf.ts                     # SSRF guard (private network URL deny for WebFetch)
    ├── tokenEstimation.ts          # tiktoken-based token estimation
    ├── tokenize.ts                 # Tokenizer helpers
    ├── toolResultBoundary.ts       # Tool result boundary marking
    ├── format.ts                   # Date/time formatting (getAgeText)
    ├── path.ts                     # Path validation helpers
    ├── semaphore.ts                # Async semaphore for concurrency control
    ├── timeout.ts                  # Timeout utilities
    └── zodToJsonSchema.ts          # Zod schema to JSON Schema converter
```

## Available Tools

| Tool | Description | Read-Only |
|------|-------------|-----------|
| Agent | Spawn sub-agents for parallel task execution | ✗ |
| AskUser | Interactive user prompts for decisions | ✓ |
| Bash | Execute shell commands with security checks | ✗ |
| Config | Configuration management | ✓ |
| Deploy | Application deployment | ✗ |
| Docker | Docker container and image operations | ✗ |
| FileEdit | Exact string replacement in files | ✗ |
| FileRead | Read files with size limits | ✓ |
| FileRestore | Undo session file writes/edits (snapshot rollback) | ✗ |
| FileWrite | Write files with path validation | ✗ |
| Git | Git operations (status, log, diff, commit, etc.) | ✗ |
| Glob | File pattern matching | ✓ |
| Grep | Content search in files | ✓ |
| Monitor | System resource monitoring | ✓ |
| Run | Compile, test, and run programs | ✗ |
| LSP | Code intelligence (completions, diagnostics, definitions) | ✓ |
| Sql | Database queries | ✗ |
| TaskCreate | Create tasks for progress tracking | ✓ |
| TaskGet | Retrieve task details | ✓ |
| TeamCreate | Create and orchestrate multi-agent teams | ✗ |
| TodoWrite | Manage task lists | ✗ |
| WebFetch | Fetch content from URLs | ✓ |
| WebSearch | Web search via configurable providers | ✓ |

## Permission Modes

- `default` — Standard interactive mode, asks for unknown operations
- `bypassPermissions` — Skip all permission checks (security-critical paths still protected)
- `auto` — Use classifier for automatic decisions
- `plan` — Plan mode, read-only operations only
- `acceptEdits` — Accept all edits, ask for others
- `dontAsk` — Convert asks to denies

## Security

**Bypass gating**: `--bypass-permissions` requires explicit opt-in via `KC_ALLOW_BYPASS=1` environment variable. Without it, bypass requests are denied with a warning — even when `--bypass-permissions` is passed on the CLI.

The permission system implements defense-in-depth:

1. **Deny-first**: Deny rules are checked first and cannot be bypassed
2. **Tool-specific**: Each tool can implement custom permission checks via `checkPermissions()`
3. **Security-critical**: Protected paths (`/etc/passwd`, `.ssh`, `.gnupg`, etc.) always require explicit approval — even in bypass mode
4. **Plugin rules** (Step 3.5): Plugins can contribute permission rules with priority-based evaluation — they can tighten but never loosen bypass-immune decisions
5. **Dangerous commands**: Patterns like `rm -rf /`, `mkfs`, `dd to /dev/` are hard-denied
6. **Read-only commands**: Safe commands (`ls`, `cat`, `grep`, `find`, `git status`, etc.) are auto-allowed
7. **Permission cascading**: Sub-agents inherit permission modes that never exceed the parent's level

## Multi-Agent Orchestration

Sub-agents run with isolated QueryEngine instances using Node.js `AsyncLocalStorage` for context isolation:

- **Permission inheritance**: Child agents cannot exceed parent's permission level
- **Tool filtering**: Allow/deny lists control which tools sub-agents can access
- **Event bus**: In-memory pub/sub routes events between agents with namespace partitioning
- **Lifecycle management**: Spawn, monitor, wait for completion, cancel, or shutdown sub-agents
- **Result aggregation**: Collects and formats results from multiple sub-agents into a summary
- **Budget enforcement**: Per-sub-agent token budgets with KCError on exceeded limits

## Session Tree (Branching Conversations)

Non-linear conversation model with full branching support:

```bash
/branch              # List all branches
/branch feature-x    # Create a new branch
/checkout <id>       # Switch to a branch (prefix matching supported)
/history             # Show ASCII tree visualization
```

API:
```typescript
engine.branch();                    // Fork at current point
engine.checkout(nodeId);            // Switch branch
engine.getTree();                   // Get full tree structure
```

## Steering (Mid-Execution Injection)

Inject messages during agent execution without aborting:

```typescript
engine.steer("Wait, also check the tests");      // Inject between tool phases
engine.followUp("Now do the same for module B");  // Queue after turn completes
```

UI: Press `Ctrl+I` to toggle steer mode. The input prompt changes to `steer>` and messages are injected into the running agent.

## Memory System

Persistent file-based memory stored in `~/.kc-cli/memory/<project-hash>/`:

- **4 discrete types**: `user`, `feedback`, `project`, `reference`
- **YAML frontmatter**: Each memory file has structured metadata (name, description, type, timestamps)
- **Relevance search**: Keyword-scored retrieval with recency boost, loaded into system prompt pre-query
- **Atomic writes**: Temp-file + rename pattern prevents corruption
- **Path security**: Directory traversal prevention, symlink validation, Unicode normalization
- **Auto-extraction** (planned): LLM-based memory extraction from conversation turns
- **Consolidation**: Scheduled merging of related memories after idle periods

## Context Window Management

Four-tier compaction engine with priority-based selection:

- **CachedMicrocompact** (priority 0): Hash-cached microcompact results, no LLM required
- **Snip** (priority 10): Targeted removal of large tool outputs (>5000 chars) without touching conversation flow
- **Full-compact** (priority 20): LLM-based conversation summarization with retry logic
- **Force truncate** (priority 30): Last-resort absolute token limit

Engines are tried in priority order; chaining occurs when an engine reduces tokens but not enough.

Additional mechanisms:
- **Token estimation**: tiktoken-based (`js-tiktoken`, cl100k_base / o200k_base / anthropic encodings)
- **Message trimming**: Hard limit of 1000 messages prevents unbounded memory growth
- **Cached estimates**: Token counts are cached and invalidated on change to avoid redundant calculations
- **Budget enforcement**: Optional proactive limits per session/turn/tool-result/sub-agent

## Development

```bash
npm run dev        # Run in development mode
npm run typecheck  # Type check with tsc --noEmit
npm run build      # Build TypeScript
npm test           # Run tests (vitest)
npm run test:watch # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

## Documentation

### RepoWiki (Deep Dive)

- [Home](docs/repowiki/Home.md) — Overview, architecture diagram, quick start
- [Architecture](docs/repowiki/Architecture.md) — Layer diagram, init sequence, data flow
- [Query Engine](docs/repowiki/Query-Engine.md) — State machine, streaming, steering
- [Tools System](docs/repowiki/Tools-System.md) — 23 tools, registry, plugin hooks
- [API Clients](docs/repowiki/API-Clients.md) — 11 provider endpoints / 3 client classes, prompt system
- [Permission System](docs/repowiki/Permission-System.md) — 6-step deny-first, rule system
- [Sandbox](docs/repowiki/Sandbox.md) — Isolation backends, HMAC signing, compaction
- [Orchestrator](docs/repowiki/Orchestrator.md) — Multi-agent lifecycle, EventBus
- [Memory System](docs/repowiki/Memory-System.md) — File-based memory, relevance search, auto-extraction
- [Plugin System](docs/repowiki/Plugin-System.md) — 5 contribution types, hooks
- [UI System](docs/repowiki/UI-System.md) — Layout, themes, focus-stack dialogs, event pipeline
- [State Management](docs/repowiki/State-Management.md) — Observable store, SessionTree
- [Configuration](docs/repowiki/Configuration.md) — 5-layer config, env vars
- [Testing](docs/repowiki/Testing.md) — Vitest patterns, mocks, coverage
- [Development Guide](docs/repowiki/Development-Guide.md) — Setup, conventions, debugging

### Guides & Specs

- [Tool Development](docs/guides/tool-development.md) — Guide to building custom tools
- [API Clients](docs/guides/api-clients.md) — LLM provider integration
- [MCP Integration](docs/guides/mcp-integration.md) — Model Context Protocol setup
- [LSP Integration](docs/guides/lsp-integration.md) — Language server integration
- [Plugin Development](docs/guides/plugin-development.md) — Plugin authoring guide
- [SWE-bench Guide](docs/guides/swe-bench-guide.md) — SWE-bench evaluation guide
- [Migration Guide](docs/guides/migration-guide.md) — v1 to v2 migration
- [Architecture Optimization Spec](docs/specs/architecture-optimization-spec.md) — v3.2 design decisions and implementation details
- [Optimization Tasks](docs/specs/optimization-tasks.md) — Task breakdown with dependency tracking
- [Architecture Hardening](docs/specs/architecture-hardening-spec.md) — Architecture consistency and robustness hardening
- [UI Structural Hardening](docs/specs/ui-structural-hardening-spec.md) — UI structural red lines and hardening tasks

## Contributing

Contributions are welcome! KC-CLI is a TypeScript / ESM project built around a
protocol-first, tool-based architecture. This section covers setup and what we
expect from a pull request. For an in-depth walkthrough, see
[docs/repowiki/Development-Guide.md](docs/repowiki/Development-Guide.md).

### Getting started

```bash
git clone <repo-url>
cd kc-cli
npm install
cp .env.example .env        # add at least one provider's KC_API_KEY
npm run typecheck && npm test
```

### Development workflow

1. **Branch** off `main` with a descriptive name (`feat/...`, `fix/...`, `docs/...`).
2. **Make your change** following the [conventions](#coding-conventions) below.
3. **Verify locally**:
   ```bash
   npm run typecheck        # tsc --noEmit must pass
   npm test                 # the vitest suite must pass
   npm run test:coverage    # must meet the thresholds below
   ```
4. **Keep docs in sync** — if you add or change a tool, provider, or config option,
   update `README.md` and the relevant `docs/repowiki/*` page.
5. **Open a PR** with a clear description: what changed, why, and how to test it.

### Coding conventions

- **TypeScript strict mode**, target ES2022, ESNext modules.
- **No `any`** in new code; prefer precise types. Prefer editing existing files over creating new ones.
- **Protocol-first**: every module exposes its public types in `protocol.ts`
  (types only — never implementation — to avoid circular imports).
- **Comments sparingly**: only when the *why* is non-obvious. No multi-line docstrings.
- **Error handling**: use `KCError` with a stable `ErrorCode` and the unified
  error-handling wrappers in `src/utils/errorHandling.ts`. Never swallow errors silently.
- **Tools** use the `ExecutionEnv` abstraction (never direct FS/Shell access) and must
  go through `ToolExecutor` so sandbox and permission checks apply.
- **Path alias**: import internal modules with `@/...` (e.g. `import { buildTool } from '@/Tool'`).

### Testing requirements

- Co-locate unit tests as `*.test.ts` next to source; integration tests live in `test/`.
- Use `MockLLMClient` for LLM-dependent tests and `MockExecutionEnv` for tool tests.
- **Coverage thresholds** (v8 provider, enforced in CI):

  | Scope | Statements | Branches | Functions | Lines |
  |-------|-----------|----------|-----------|-------|
  | Global | 60% | 50% | 60% | 60% |
  | `src/permissions/**` | 75% | 65% | 75% | 75% |
  | `src/services/sandbox*.ts` | 65% | 55% | 65% | 65% |

### Extending KC-CLI

- **Add a tool** — `src/tools/<Name>/index.ts`, then register in `src/tools.ts`; see
  [Tool Development](docs/guides/tool-development.md).
- **Add an LLM provider** — extend `BaseApiClient` in `src/api/`; see
  [API Clients](docs/guides/api-clients.md).
- **Add a plugin** — contribute tools / hooks / permissionRules / prompts / mcpServers; see
  [Plugin Development](docs/guides/plugin-development.md).
- **Wire MCP / LSP** — see [MCP Integration](docs/guides/mcp-integration.md) and
  [LSP Integration](docs/guides/lsp-integration.md).

### Questions?

Open an issue or start a discussion. Most "how do I…" answers live in
[docs/repowiki/](docs/repowiki/) and the guides under [docs/guides/](docs/guides/).

## License

MIT
