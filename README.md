# KC-CLI: Intelligent CLI Agent System

An AI-powered intelligent CLI assistant for software development, inspired by Claude Code's architecture.

## Features

- **Modular Tools**: 21 built-in tools — Bash, file I/O, search, Git, SQL, Docker, deployment, task management, and sub-agent spawning
- **Multi-LLM Support**: Anthropic Claude, OpenAI GPT, Qwen (DashScope), GLM (Zhipu AI), Google Gemini, and Ollama (local)
- **Permission System**: Three-layer security (allow/deny/ask) with bypass-immune safety checks, protected paths, and auto-classifier
- **Multi-Agent Orchestration**: Spawn sub-agents with isolated QueryEngine instances, permission cascading, and event bus coordination
- **Memory System**: File-based persistent memory with YAML frontmatter, relevance search, and 4 discrete types (user/feedback/project/reference)
- **Auto-Compaction**: Micro-compact (clear old tool results) and full-compact (LLM summarization) to manage context windows
- **Session Management**: Session persistence, archival, pruning, and recovery with configurable retention
- **Interactive REPL**: Readline-based terminal UI with slash commands
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
# Anthropic (default)
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
- `/exit` — Exit

## Architecture

```
src/
├── main.ts                         # Entry point, REPL, command handling
├── Tool.ts                         # Tool factory (buildTool) and result helpers
├── tools.ts                        # Tool registry, assembly, deny-rule filtering
│
├── bootstrap/                      # Initialization
│   ├── state.ts                    # GlobalState (session, cwd, permission mode)
│   ├── config.ts                   # 4-layer config loading (defaults < user < project < env)
│   └── profiler.ts                 # Startup performance tracking
│
├── state/                          # Query loop state machine
│   ├── types.ts                    # AgentStateName, AgentEvent discriminated union, transitions
│   ├── store.ts                    # ObservableStateStore (immutable updates + listeners)
│   └── machine.ts                  # AgentStateMachine with transition validation
│
├── query/                          # Core agent loop
│   └── QueryEngine.ts              # idle→compact→stream→decide→execute loop + memory integration
│
├── api/                            # LLM API clients
│   ├── BaseApiClient.ts            # Abstract base (streamChat, chat, formatMessages, formatTools)
│   ├── AnthropicClient.ts          # Anthropic SSE streaming with stateful content block parser
│   ├── OpenAICompatibleClient.ts   # OpenAI-compatible (used for OpenAI, Qwen, GLM)
│   ├── OllamaClient.ts             # Local Ollama client
│   └── index.ts                    # Factory function + provider config defaults
│
├── permissions/                    # Security system
│   ├── engine.ts                   # 6-step deny-first decision flow
│   ├── rules.ts                    # Rule parsing/matching with wildcard support
│   ├── classifier.ts               # Rule-based auto classifier (quick path + heuristics)
│   ├── readonlyCommands.ts         # Shared read-only command patterns (bash + git)
│   ├── protectedPaths.ts           # Bypass-immune protected path definitions
│   └── interaction.ts              # Interactive user permission handler
│
├── executors/                      # Tool execution
│   └── toolExecutor.ts             # Single/parallel execution with timeout + permission checks
│
├── tools/                          # 21 built-in tool implementations
│   ├── BashTool/                   # Shell execution with dangerous-command detection
│   ├── FileReadTool/               # File reading with size limits
│   ├── FileWriteTool/              # File writing with path validation
│   ├── FileEditTool/               # Exact string replacement in files
│   ├── GrepTool/                   # Content search in files
│   ├── GlobTool/                   # File pattern matching
│   ├── WebSearchTool/              # Web search via configurable providers
│   ├── WebFetchTool/               # URL content fetching
│   ├── GitTool/                    # Git operations
│   ├── RunTool/                    # Program compilation and execution
│   ├── SqlTool/                    # Database queries
│   ├── DockerTool/                 # Docker operations
│   ├── MonitorTool/                # System monitoring
│   ├── ConfigTool/                 # Configuration management
│   ├── TodoWriteTool/              # Task list management
│   ├── TaskCreateTool/             # Task creation
│   ├── TaskGetTool/                # Task retrieval
│   ├── AskUserTool/                # Interactive user prompts
│   ├── AgentTool/                  # Sub-agent spawning
│   ├── DeployTool/                 # Application deployment
│   └── TaskStore.ts                # Shared task state storage
│
├── orchestrator/                   # Multi-agent coordination
│   ├── types.ts                    # SubAgentIdentity, SpawnConfig, Runtime, Error types
│   ├── agent-orchestrator.ts       # Central coordinator (spawn, batch, wait, cancel, shutdown)
│   ├── event-bus.ts               # In-memory pub/sub with async iterators and Agent scoping
│   ├── permission-cascader.ts      # Child permission derivation (child ≤ parent)
│   ├── result-aggregator.ts        # Multi-agent result collection and summary generation
│   ├── agent-definitions.ts        # Pre-defined agent types
│   └── backends/
│       ├── types.ts               # SubAgentBackend interface
│       └── in-process.ts          # AsyncLocalStorage-based process isolation
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
│   ├── telemetry.ts               # Memory usage tracking
│   └── MEMORY.md                  # Memory index file
│
├── services/                       # System services
│   ├── compaction.ts               # Micro-compact + full-compact (LLM summarization)
│   ├── sessionManager.ts           # Session lifecycle (save, load, archive, prune, stats)
│   ├── idleDetection.ts            # Idle detection for consolidation triggering
│   ├── consolidationScheduler.ts   # Scheduled memory consolidation
│   ├── memoryConsolidation.ts      # Consolidation execution logic
│   ├── memoryExtraction.ts         # Memory extraction from conversations
│   ├── extractionPrompts.ts        # LLM prompts for memory extraction
│   └── consolidationPrompts.ts     # LLM prompts for consolidation
│
├── hooks/                          # Post-turn hook system
│   └── postTurnHooks.ts           # Fire-and-forget hooks executed after each turn
│
├── types/                          # Shared type definitions
│   ├── tools.ts                    # ToolDefinition, ToolUseContext, ToolRegistry, ToolName
│   ├── message.ts                  # ChatMessage, ToolCall, StreamEvent types
│   ├── permissions.ts              # PermissionResult, PermissionMode, PermissionContext
│   └── orchestrator.ts             # SubAgentResult, MultiAgentEvent (shared types)
│
└── utils/                          # Shared utilities
    ├── tokenEstimation.ts          # Character-based token estimation (characters/4 * 4/3)
    ├── format.ts                   # Date/time formatting (getAgeText)
    └── path.ts                     # Path validation helpers
```

### Placeholder Directories

The following directories are reserved for future development and currently contain only `.gitkeep` files:

- `src/server/` — HTTP/WebSocket server for remote access
- `src/terminal/` — Advanced terminal UI (ink-based)
- `src/services/skills/` — Skill system for specialized workflows
- `src/services/tools/` — Service-level tool implementations

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
2. **Tool-specific**: Each tool can implement custom permission checks via `checkPermissions()`
3. **Security-critical**: Protected paths (`/etc/passwd`, `.ssh`, `.gnupg`, etc.) always require explicit approval — even in bypass mode
4. **Dangerous commands**: Patterns like `rm -rf /`, `mkfs`, `dd to /dev/` are hard-denied
5. **Read-only commands**: Safe commands (`ls`, `cat`, `grep`, `find`, `git status`, etc.) are auto-allowed
6. **Permission cascading**: Sub-agents inherit permission modes that never exceed the parent's level

## Multi-Agent Orchestration

Sub-agents run with isolated QueryEngine instances using Node.js `AsyncLocalStorage` for context isolation:

- **Permission inheritance**: Child agents cannot exceed parent's permission level
- **Tool filtering**: Allow/deny lists control which tools sub-agents can access
- **Event bus**: In-memory pub/sub routes events between agents with namespace partitioning
- **Lifecycle management**: Spawn, monitor, wait for completion, cancel, or shutdown sub-agents
- **Result aggregation**: Collects and formats results from multiple sub-agents into a summary

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

- **Micro-compact**: Clears old tool results (cheap, no LLM) — replaces large outputs with placeholder text
- **Full-compact**: LLM-based conversation summarization preserving key decisions and context
- **Token estimation**: Character-based heuristic (`length/4 * 4/3`) for cross-platform compatibility
- **Message trimming**: Hard limit of 1000 messages prevents unbounded memory growth
- **Cached estimates**: Token counts are cached and invalidated on change to avoid redundant calculations

## Development

```bash
npm run dev        # Run in development mode
npm run typecheck  # Type check with tsc --noEmit
npm run build      # Build TypeScript
npm test           # Run tests
```

## License

MIT
