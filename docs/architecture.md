# KC-CLI Architecture

## Overview

KC-CLI is an intelligent CLI agent system built with TypeScript/Node.js. It provides an AI-powered development assistant that can read/write files, execute commands, search code, manage git, query databases, and more.

## Core Components

### State Machine (src/state/)
The agent lifecycle follows: `idle -> compacting -> streaming -> deciding -> executing -> (loop or complete)`

- **AgentStateMachine** -- Manages state transitions
- **ObservableStateStore** -- Reactive state with subscribers

### Query Engine (src/query/QueryEngine.ts)
Central coordinator for each user query. Manages:
- Message history and context window
- LLM API calls with streaming
- Tool execution (single or parallel)
- Auto-compaction when context exceeds window
- Memory integration (pre-query relevance loading)

### Tool System (src/tools.ts, src/tools/)
21 built-in tools organized by category:
- **File**: FileRead, FileWrite, FileEdit, Glob, Grep
- **Execution**: Bash, Run, Docker
- **Search**: WebSearch, WebFetch
- **VCS**: Git
- **Database**: Sql
- **Agent**: Agent, TeamCreate
- **System**: Config, Monitor, Deploy
- **Task**: TaskCreate, TaskGet, TodoWrite, AskUser
- **LSP**: LSPTool (completions, diagnostics, navigation, code actions)

Each tool implements `ToolDefinition` with: `call()`, `checkPermissions()`, `isReadOnly()`, `isConcurrencySafe()`, `isDestructive()`.

### Permission Engine (src/permissions/)
6-step deny-first evaluation:
1. Check bypass mode
2. Check always-deny rules
3. Check protected paths
4. Check always-allow rules
5. Check read-only classification
6. Default: ask user

### API Clients (src/api/)
Provider abstraction via `BaseApiClient`:
- **AnthropicClient** -- Claude API with prompt caching
- **OpenAICompatibleClient** -- OpenAI, DeepSeek, Qwen, GLM
- **OllamaClient** -- Local models

v2 additions:
- **ProviderCapabilities** -- Auto-detection of provider features
- **Provider-specific prompts** -- Customized system prompts per provider
- **Task-specific prompts** -- Prompt templates for code/debug/refactor/docs
- **Dynamic parameter tuning** -- `max_tokens`, `temperature`, `top_p` auto-adjusted

### Orchestrator (src/orchestrator/)
Multi-agent system with:
- **AgentOrchestrator** -- Spawns and manages sub-agents
- **InProcessBackend** -- AsyncLocalStorage isolation
- **PermissionCascader** -- Child permission derivation (child ≤ parent)
- **ResultAggregator** -- Collects sub-agent results
- **EventBus** -- In-memory pub/sub with async iterators and agent scoping

### MCP Integration (src/mcp/)
Model Context Protocol client for external tool servers:
- **MCPClientManager** -- Connection lifecycle
- **StdioTransport / HttpTransport** -- JSON-RPC transports
- **ToolBridge** -- Converts MCP tools to KC-CLI ToolDefinitions
- Config: `.mcp.json` (project) or `~/.kc-cli/mcp.json` (user)

### Plugin System (src/plugins/)
Local plugin loading:
- Discovers plugins from `~/.kc-cli/plugins/` and `.kc-cli/plugins/`
- Plugin interface: `name`, `version`, `tools[]`, `hooks{}`, `onInit()`, `onShutdown()`
- Error isolation: one plugin failure doesn't crash others

### Sandbox (src/services/)
Command isolation for BashTool and RunTool:

v2 sandbox system with 4 backends and policy engine:
- **DockerSandbox** -- Container-based isolation (`--network none`, `--read-only`, resource limits)
- **BubblewrapSandbox** -- Linux namespace isolation (default)
- **SeccompSandbox** -- Fallback with ulimit/timeout + seccomp profile
- **NoopSandbox** -- Pass-through with warning
- **SandboxPolicy** -- Per-tool policies with pattern-based rules
- **seccomp-profile.json** -- Syscall whitelist (blocks ptrace, mount, etc.)

### LSP Integration (src/lsp/)
Language Server Protocol client for code intelligence:
- **LSPClientManager** -- Connection lifecycle, JSON-RPC over stdio
- **DocumentManager** -- Document version sync, diagnostic cache
- **CompletionProvider** -- `textDocument/completion` with snippet expansion
- **NavigationProvider** -- Definition, references, rename
- **CodeActionProvider** -- Quick fixes
- **DiagnosticCollector** -- Real-time error/warning display

### UI Components (src/ui/)
Ink-based terminal UI:
- **App** -- Main layout with Sidebar + Main split
- **Sidebar** -- Tools/Files/Tasks/Memory modules
- **FileTree** -- Recursive file tree with LSP markers
- **DiffPreview** -- Multi-file diff viewer with accept/reject
- **CommandPalette** -- Fuzzy-search command overlay
- **ModelSelector** -- Interactive provider/model switcher
- **ChatView** -- Conversation display with virtual scrolling
- **StatusBar** -- Current status indicator
- **InputBox** -- User input handler

### Services
- **Compaction** (src/services/compaction.ts) -- Microcompact + LLM-based full compact
- **Error Classifier** (src/services/error-classifier.ts) -- Transient/Permanent/Degraded classification
- **Session Manager** (src/services/sessionManager.ts) -- Session persistence
- **Memory Consolidation** -- Scheduled memory merging after idle periods
- **Memory Extraction** -- LLM-based memory extraction from conversations

### Memory (src/memory/)
File-based persistent memory:
- **FileMemoryService** -- CRUD with atomic writes and security validation
- **RelevanceSearch** -- Keyword-scored retrieval with recency boost
- **Frontmatter** -- YAML frontmatter parser
- 4 types: `user`, `feedback`, `project`, `reference`

## Data Flow

```
User Input
  -> QueryEngine.submitMessage()
    -> loadRelevantMemories() -- pre-query memory loading
    -> compactingPhase() -- auto-compact if context too large
    -> streamingPhase() -- call LLM API with tools
      -> Provider-specific prompt selection
      -> Dynamic parameter tuning
    -> decidingPhase() -- check for tool calls
    -> executingPhase() -- run tools (sandboxed)
      -> SandboxManager.wrapCommand() -- wrap in sandbox
      -> PermissionEngine.check() -- permission verification
      -> ToolExecutor.execute() -- run with timeout
    -> loop back to streamingPhase
  -> AgentEvents emitted to UI
  -> extractMemoriesFromConversation() -- post-query memory save
```

## Configuration

4-layer config with ascending priority:
1. Defaults (Zod schema)
2. User config (~/.kc-cli/settings.json)
3. Project config (.kc-cli/settings.json)
4. Environment variables (KC_*)

## Project Structure

```
src/
├── main.ts                         # Entry point, REPL, command handling
├── Tool.ts                         # Tool factory (buildTool) and result helpers
├── tools.ts                        # Tool registry, assembly, deny-rule filtering
│
├── bootstrap/                      # Initialization
│   ├── state.ts                    # GlobalState (session, cwd, permission mode)
│   ├── config.ts                   # 4-layer config loading
│   └── profiler.ts                 # Startup performance tracking
│
├── state/                          # Query loop state machine
│   ├── types.ts                    # AgentStateName, AgentEvent discriminated union
│   ├── store.ts                    # ObservableStateStore
│   └── machine.ts                  # AgentStateMachine
│
├── query/                          # Core agent loop
│   └── QueryEngine.ts              # idle→compact→stream→decide→execute loop
│
├── api/                            # LLM API clients
│   ├── BaseApiClient.ts            # Abstract base
│   ├── AnthropicClient.ts          # Anthropic SSE streaming
│   ├── OpenAICompatibleClient.ts   # OpenAI-compatible
│   ├── OllamaClient.ts             # Local Ollama
│   ├── capabilities.ts             # ProviderCapabilities detection
│   ├── param-tuner.ts              # Dynamic parameter tuning
│   └── prompts/                    # Prompt templates
│       ├── provider-prompts.ts     # Per-provider prompts
│       ├── task-prompts.ts         # Per-task prompts
│       └── prompt-builder.ts       # Prompt assembly
│
├── permissions/                    # Security system
│   ├── engine.ts                   # 6-step deny-first decision flow
│   ├── rules.ts                    # Rule parsing/matching
│   ├── classifier.ts               # Auto classifier
│   └── interaction.ts              # Interactive user handler
│
├── executors/                      # Tool execution
│   └── toolExecutor.ts             # Single/parallel execution + sandbox
│
├── tools/                          # 21 built-in tools
│   ├── BashTool/                   # Shell execution (sandboxed)
│   ├── FileReadTool/               # File reading
│   ├── FileWriteTool/              # File writing
│   ├── FileEditTool/               # String replacement
│   ├── GrepTool/                   # Content search
│   ├── GlobTool/                   # Pattern matching
│   ├── WebSearchTool/              # Web search
│   ├── WebFetchTool/               # URL fetching
│   ├── GitTool/                    # Git operations
│   ├── RunTool/                    # Program execution (sandboxed)
│   ├── SqlTool/                    # Database queries
│   ├── DockerTool/                 # Docker operations
│   ├── MonitorTool/                # System monitoring
│   ├── ConfigTool/                 # Configuration
│   ├── TodoWriteTool/              # Task management
│   ├── TaskCreateTool/             # Task creation
│   ├── TaskGetTool/                # Task retrieval
│   ├── AskUserTool/                # User prompts
│   ├── AgentTool/                  # Sub-agent spawning
│   └── DeployTool/                 # Deployment
│
├── orchestrator/                   # Multi-agent coordination
│   ├── agent-orchestrator.ts       # Central coordinator
│   ├── event-bus.ts                # Pub/sub with async iterators
│   ├── permission-cascader.ts      # Child permission derivation
│   ├── result-aggregator.ts        # Result collection
│   ├── agent-definitions.ts        # Pre-defined agent types
│   └── backends/
│       └── in-process.ts           # AsyncLocalStorage isolation
│
├── lsp/                            # LSP integration
│   ├── client.ts                   # LSPClientManager
│   ├── document-manager.ts         # Document lifecycle
│   ├── completion.ts               # Completion provider
│   ├── navigation.ts               # Definition/references/rename
│   ├── code-actions.ts             # Quick fixes
│   ├── diagnostics.ts              # Diagnostic collector
│   ├── tool.ts                     # LSPTool definition
│   └── types.ts                    # LSP type definitions
│
├── memory/                         # Persistent memory
│   ├── FileMemoryService.ts        # File-based CRUD
│   ├── integration.ts              # QueryEngine integration
│   ├── relevanceSearch.ts          # Keyword scoring
│   └── frontmatter.ts              # YAML parser
│
├── services/                       # System services
│   ├── sandbox.ts                  # SandboxManager
│   ├── sandbox-docker.ts           # Docker backend
│   ├── sandbox-policy.ts           # Per-tool policies
│   ├── sandbox-profiles.ts         # Backend implementations
│   ├── seccomp-profile.json        # Syscall whitelist
│   ├── compaction.ts               # Context compaction
│   ├── sessionManager.ts           # Session persistence
│   ├── idleDetection.ts            # Idle detection
│   ├── consolidationScheduler.ts   # Memory consolidation
│   ├── memoryConsolidation.ts      # Consolidation logic
│   ├── memoryExtraction.ts         # Memory extraction
│   └── error-classifier.ts         # Error classification
│
├── ui/                             # Terminal UI (Ink)
│   └── components/
│       ├── App.ts                  # Main layout
│       ├── Sidebar.ts              # Sidebar with modules
│       ├── DiffPreview.ts          # Diff viewer
│       ├── CommandPalette.ts       # Command palette
│       ├── ModelSelector.ts        # Model switcher
│       ├── ChatView.ts             # Conversation display
│       ├── StatusBar.ts            # Status indicator
│       └── InputBox.ts             # Input handler
│
├── hooks/                          # Post-turn hooks
│   └── postTurnHooks.ts
│
├── types/                          # Shared types
│   ├── tools.ts                    # ToolDefinition, ToolUseContext
│   ├── message.ts                  # ChatMessage, StreamEvent
│   ├── permissions.ts              # PermissionMode, PermissionContext
│   └── orchestrator.ts             # SubAgentResult, MultiAgentEvent
│
└── utils/                          # Utilities
    ├── tokenEstimation.ts          # tiktoken-based estimation
    ├── format.ts                   # Date/time formatting
    └── path.ts                     # Path validation
```
