# KC-CLI: Intelligent CLI Agent System

An AI-powered intelligent CLI assistant for software development, inspired by Claude Code's architecture. Architecture patterns derived from comparative analysis of PilotDeck (OpenBMB) and pi (earendil-works) projects.

## v3.2 Highlights

- 🔒 **Sandbox Security**: All shell commands run in isolated sandboxes (Docker/Bubblewrap/seccomp) with network isolation, resource limits, and escape detection
- 🎨 **Redesigned UI**: Sidebar with file tree (LSP markers), diff preview, command palette, model selector, theme system, mouse support, multi-panel layout
- 🔌 **LSP Integration**: Code completions, diagnostics, go-to-definition, find references, rename, quick fixes for 9 languages
- 🧠 **Smart Model Adaptation**: Provider-specific prompts, dynamic parameter tuning, tiktoken-based token estimation
- 🧪 **3899 Tests**: Comprehensive test suite across 178 files
- 🛡️ **Runtime Monitoring**: Sandbox resource monitoring (Docker stats, /proc), image management, and probe-based isolation verification
- 🪟 **Windows Sandbox**: Native Windows sandbox support via job objects
- 🌳 **Session Tree**: Non-linear conversations with branching, checkout, merge, and branch summaries
- 🎯 **Budget Enforcement**: Proactive token budget limits per session, turn, tool result, and sub-agent
- ⚡ **Tiered Compaction**: Four-engine compaction system (CachedMicro, Snip, Full, Force) with priority-based selection
- 🔀 **Steering System**: Inject messages mid-execution via `steer()` or after completion via `followUp()` (Ctrl+I)
- 🔌 **Contribution Plugins**: Plugin system with 5 contribution types (tools, hooks, permissionRules, prompts, mcpServers)
- 📐 **Protocol-First Design**: Per-module protocol.ts files for clean interface boundaries
- 🧩 **ExecutionEnv Abstraction**: Swappable FileSystem/Shell backends for testable, isolatable tools
- ❌ **Typed Error Handling**: Result<T,E> sum type and KCError with 18 stable error codes

## Features

- **Modular Tools**: 21 built-in tools with two-phase execution (prepare/execute/finalize) — Bash, file I/O, search, Git, SQL, Docker, deployment, task management, and sub-agent spawning
- **Multi-LLM Support**: Anthropic Claude, OpenAI GPT, Qwen (DashScope), GLM (Zhipu AI), Google Gemini, DeepSeek, and Ollama (local); 9 stream event types including thinking_delta
- **Permission System**: 6-step deny-first security with bypass-immune safety checks, protected paths, auto-classifier, and plugin-contributed rules (Step 1.5)
- **Sandbox Isolation**: Docker/Bubblewrap/seccomp backends with per-tool policies, seccomp profiles, and resource limits
- **LSP Code Intelligence**: Language server integration for TypeScript, Go, Python, Rust, Java, C++, Ruby
- **Multi-Agent Orchestration**: Spawn sub-agents with isolated QueryEngine instances, permission cascading, event bus coordination, and budget enforcement
- **Memory System**: File-based persistent memory with YAML frontmatter, relevance search, and 4 discrete types (user/feedback/project/reference)
- **Tiered Compaction**: Four-engine system (CachedMicro → Snip → Full → Force) with priority-based selection and result caching
- **Session Tree**: Non-linear conversations with branching (`/branch`), checkout (`/checkout`), merge, and tree visualization (`/history`)
- **Steering**: Inject messages mid-execution via `steer()` or after completion via `followUp()`; Ctrl+I toggle in UI
- **Budget Enforcement**: Proactive token limits per session/turn/tool-result/sub-agent with opt-in BudgetConfig
- **Plugin Contributions**: Plugins can contribute tools, hooks, permission rules, prompt templates, and MCP server configs
- **Typed Errors**: `Result<T,E>` for explicit error handling; `KCError` with 18 stable codes (api_rate_limit, tool_timeout, budget_exceeded, etc.)
- **ExecutionEnv**: Swappable FileSystem/Shell abstraction; MockExecutionEnv for testing without real I/O
- **Session Management**: Session persistence, archival, pruning, and recovery with configurable retention
- **Interactive REPL**: Terminal UI with sidebar, diff preview, command palette, model selector, and steer mode
- **Node.js Compatible**: Works with Node.js 16+ (no Bun required)

## Quick Start

### Prerequisites

- Node.js 16.20.2 or higher
- npm or yarn
- API key for your chosen LLM provider

### Installation

```bash
cd kc-cli
npm install
npm run kc -- "List all files in the current directory"
npm run kc  # Interactive mode
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
  --provider <provider>       LLM provider (anthropic/openai/qwen/glm/ollama)
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
│   ├── OpenAICompatibleClient.ts   # OpenAI-compatible (used for OpenAI, Qwen, GLM, DeepSeek)
│   ├── OllamaClient.ts             # Local Ollama client
│   ├── capabilities.ts             # Provider capability detection
│   ├── param-tuner.ts              # Dynamic parameter tuning per model
│   ├── index.ts                    # Factory function + provider config defaults
│   └── prompts/
│       ├── prompt-builder.ts       # System prompt construction
│       ├── provider-prompts.ts     # Provider-specific prompt templates
│       ├── task-prompts.ts         # Task-specific prompt templates
│       └── types.ts                # Prompt type definitions
│
├── bootstrap/                      # Initialization
│   ├── state.ts                    # GlobalState (session, cwd, permission mode)
│   ├── config.ts                   # 4-layer config loading (defaults < user < project < env)
│   ├── autoConfig.ts               # Auto-configuration with project type detection
│   └── profiler.ts                 # Startup performance tracking
│
├── executors/                      # Tool execution
│   └── toolExecutor.ts             # Single/parallel execution with timeout + permission checks
│
├── hooks/                          # Post-turn hook system
│   └── postTurnHooks.ts           # Fire-and-forget hooks executed after each turn
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
│   └── telemetry.ts               # Memory usage tracking
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
│   ├── engine.ts                   # 6-step deny-first decision flow
│   ├── rules.ts                    # Rule parsing/matching with wildcard support
│   ├── classifier.ts               # Rule-based auto classifier (quick path + heuristics)
│   ├── readonlyCommands.ts         # Shared read-only command patterns (bash + git)
│   ├── protectedPaths.ts           # Bypass-immune protected path definitions
│   └── interaction.ts              # Interactive user permission handler
│
├── plugins/                        # Plugin system
│   ├── plugin-loader.ts            # Plugin discovery and loading
│   ├── plugin-manager.ts           # Plugin lifecycle management
│   ├── types.ts                    # Plugin type definitions
│   └── index.ts                    # Plugin module entry
│
├── query/                          # Core agent loop
│   └── QueryEngine.ts              # idle→compact→stream→decide→execute loop + memory integration
│
├── services/                       # System services
│   ├── compaction.ts               # Micro-compact + full-compact (LLM summarization)
│   ├── sessionManager.ts           # Session lifecycle (save, load, archive, prune, stats)
│   ├── idleDetection.ts            # Idle detection for consolidation triggering
│   ├── consolidationScheduler.ts   # Scheduled memory consolidation
│   ├── memoryConsolidation.ts      # Consolidation execution logic
│   ├── memoryExtraction.ts         # Memory extraction from conversations
│   ├── memoryQuality.ts            # Memory quality assessment
│   ├── extractionPrompts.ts        # LLM prompts for memory extraction
│   ├── consolidationPrompts.ts     # LLM prompts for consolidation
│   ├── error-classifier.ts         # Error classification for retry decisions
│   ├── paramTuner.ts               # Parameter auto-tuning service
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
│   ├── sandbox-windows.ts          # Windows sandbox backend (job objects)
│   ├── sandbox-policy.ts           # Per-tool sandbox policies
│   ├── sandbox-profiles.ts         # Seccomp profiles and shell escaping
│   └── cache/
│       ├── CacheManager.ts         # Cache management
│       ├── TieredCache.ts          # Multi-tier cache (memory + disk)
│       ├── compression.ts          # Cache compression
│       ├── consistency.ts          # Cache consistency checks
│       └── index.ts                # Cache module entry
│
├── state/                          # Query loop state machine
│   ├── types.ts                    # AgentStateName, AgentEvent discriminated union, transitions
│   ├── store.ts                    # ObservableStateStore (immutable updates + listeners)
│   └── machine.ts                  # AgentStateMachine with transition validation
│
├── tools/                          # 21 built-in tool implementations
│   ├── AgentTool/                  # Sub-agent spawning
│   ├── AskUserTool/                # Interactive user prompts
│   ├── BashTool/                   # Shell execution with dangerous-command detection
│   ├── ConfigTool/                 # Configuration management
│   ├── DeployTool/                 # Application deployment
│   ├── DockerTool/                 # Docker operations
│   ├── FileEditTool/               # Exact string replacement in files
│   ├── FileReadTool/               # File reading with size limits
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
│   └── TaskStore.ts                # Shared task state storage
│
├── types/                          # Shared type definitions
│   ├── tools.ts                    # ToolDefinition, ToolUseContext, ToolRegistry, ToolName
│   ├── message.ts                  # ChatMessage, ToolCall, StreamEvent types
│   ├── permissions.ts              # PermissionResult, PermissionMode, PermissionContext
│   └── orchestrator.ts             # SubAgentResult, MultiAgentEvent (shared types)
│
├── ui/                             # Terminal UI components
│   ├── components/
│   │   ├── App.ts                  # Main application component
│   │   ├── ChatView.ts             # Chat message display
│   │   ├── CommandPalette.ts       # Fuzzy-search command palette
│   │   ├── InputBox.ts             # User input component
│   │   ├── ModelSelector.ts        # Interactive model/provider switcher
│   │   ├── Sidebar.ts              # Sidebar with Tools/Files/Tasks/Memory panels
│   │   ├── StatusBar.ts            # Status bar component
│   │   └── ToolCallCard.ts         # Tool call display card
│   ├── diff-viewer.ts              # Multi-file diff viewer
│   ├── formatter.ts                # Text formatting utilities
│   ├── layout.ts                   # Multi-panel layout manager (4 modes)
│   ├── mouse.ts                    # Mouse event handler (SGR parsing)
│   ├── renderer.ts                 # Terminal renderer
│   ├── spinner.ts                  # Loading spinner
│   ├── statusline.ts               # Status line display
│   ├── theme.ts                    # Theme system (5 built-in themes)
│   ├── virtual-scroll.ts           # Virtual scrolling for long conversations
│   └── index.ts                    # UI module entry
│
└── utils/                          # Shared utilities
    ├── tokenEstimation.ts          # tiktoken-based token estimation
    ├── format.ts                   # Date/time formatting (getAgeText)
    ├── path.ts                     # Path validation helpers
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
| FileWrite | Write files with path validation | ✗ |
| Git | Git operations (status, log, diff, commit, etc.) | ✗ |
| Glob | File pattern matching | ✓ |
| Grep | Content search in files | ✓ |
| Monitor | System resource monitoring | ✓ |
| Run | Compile, test, and run programs | ✗ |
| Sql | Database queries | ✗ |
| TaskCreate | Create tasks for progress tracking | ✓ |
| TaskGet | Retrieve task details | ✓ |
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

The permission system implements defense-in-depth:

1. **Deny-first**: Deny rules are checked first and cannot be bypassed
2. **Plugin rules** (Step 1.5): Plugins can contribute permission rules with priority-based evaluation
3. **Tool-specific**: Each tool can implement custom permission checks via `checkPermissions()`
4. **Security-critical**: Protected paths (`/etc/passwd`, `.ssh`, `.gnupg`, etc.) always require explicit approval — even in bypass mode
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
- **Token estimation**: Character-based heuristic (`length/4 * 4/3`) for cross-platform compatibility
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

- [Architecture](docs/ARCHITECTURE.md) — System architecture and design patterns
- [Tool Development](docs/tool-development.md) — Guide to building custom tools
- [Configuration](docs/configuration.md) — Configuration system and settings
- [API Clients](docs/api-clients.md) — LLM provider integration
- [MCP Integration](docs/mcp-integration.md) — Model Context Protocol setup
- [Sandbox Security](docs/sandbox-security.md) — Sandboxing and security model
- [LSP Integration](docs/lsp-integration.md) — Language server integration
- [UI Guide](docs/ui-guide.md) — Terminal UI usage guide
- [Plugin Development](docs/plugin-development.md) — Plugin authoring guide
- [Architecture Optimization Spec](docs/specs/architecture-optimization-spec.md) — v3.2 design decisions and implementation details
- [Optimization Tasks](docs/specs/optimization-tasks.md) — Task breakdown with dependency tracking

## License

MIT
