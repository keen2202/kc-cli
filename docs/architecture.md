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

### Orchestrator (src/orchestrator/)
Multi-agent system with:
- **AgentOrchestrator** -- Spawns and manages sub-agents
- **InProcessBackend** -- AsyncLocalStorage isolation
- **PermissionCascader** -- Child permission derivation
- **ResultAggregator** -- Collects sub-agent results

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

### Sandbox (src/services/sandbox.ts)
Command isolation for BashTool and RunTool:
- **BubblewrapSandbox** -- Linux namespace isolation (default)
- **SeccompSandbox** -- Fallback with ulimit/timeout
- **NoopSandbox** -- Pass-through with warning

### Services
- **Compaction** (src/services/compaction.ts) -- Microcompact + LLM-based full compact
- **Error Classifier** (src/services/error-classifier.ts) -- Transient/Permanent/Degraded classification
- **Session Manager** (src/services/sessionManager.ts) -- Session persistence

## Data Flow

```
User Input
  -> QueryEngine.submitMessage()
    -> compactingPhase() -- auto-compact if context too large
    -> streamingPhase() -- call LLM API with tools
    -> decidingPhase() -- check for tool calls
    -> executingPhase() -- run tools (sandboxed)
    -> loop back to streamingPhase
  -> AgentEvents emitted to UI
```

## Configuration

4-layer config with ascending priority:
1. Defaults (Zod schema)
2. User config (~/.kc-cli/settings.json)
3. Project config (.kc-cli/settings.json)
4. Environment variables (KC_*)
