# Orchestrator

Multi-agent coordination with isolated QueryEngine instances, permission cascading, and event-driven communication.

## Architecture

```
┌─────────────────────────────────────┐
│         AgentOrchestrator           │
│  (central coordinator)              │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────┐  ┌─────────┐          │
│  │ Agent A │  │ Agent B │  ...     │
│  │ (child) │  │ (child) │          │
│  └────┬────┘  └────┬────┘          │
│       │            │               │
│  ┌────▼────────────▼────┐          │
│  │     EventBus         │          │
│  │  (pub/sub routing)   │          │
│  └──────────────────────┘          │
│                                     │
│  ┌──────────────────────┐          │
│  │ ResultAggregator     │          │
│  │ (collect + summarize)│          │
│  └──────────────────────┘          │
└─────────────────────────────────────┘
```

## Core Components

### AgentOrchestrator

`src/orchestrator/agent-orchestrator.ts` -- Central coordinator:

```typescript
class AgentOrchestrator {
  spawn(config: SubAgentSpawnConfig): SubAgentIdentity;
  batchSpawn(configs: SubAgentSpawnConfig[]): SubAgentIdentity[];
  wait(agentId: string, timeout?: number): Promise<AggregatedResult>;
  cancel(agentId: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

**Sub-agent lifecycle**: `spawning → running → idle | completed | failed | timed_out | cancelled`

### EventBus

`src/orchestrator/event-bus.ts` -- In-memory pub/sub with agent scoping:

```typescript
class EventBus {
  subscribe(agentId: string, handler: (event) => void): Unsubscribe;
  publish(agentId: string, event: OrchestratorEvent): void;
  subscribeAll(handler: (event) => void): Unsubscribe;
}
```

Events are namespace-partitioned by `agentId`, preventing cross-agent event leakage.

### ResultAggregator

`src/orchestrator/result-aggregator.ts`:

```typescript
interface AggregatedResult {
  results: SubAgentResult[];
  totalDuration: number;
  totalTokensUsed: number;
  totalToolUses: number;
  summary: string; // LLM-generated summary of all results
}
```

### Permission Cascader

`src/orchestrator/permission-cascader.ts`:

Derives child permissions from parent:
- Child permission mode ≤ parent's permissiveness
- `bypassPermissions` parent → children can be any mode
- `plan` parent → children can only be `plan` or `dontAsk`
- Protected paths remain bypass-immune

### InProcessBackend

`src/orchestrator/backends/in-process.ts`:

Runs sub-agents in the same process using `AsyncLocalStorage` for context isolation:
- Each sub-agent gets its own `AsyncLocalStorage` context
- No process spawning overhead
- Shared memory space (careful with mutable state)
- `QueryEngineLike` interface avoids circular imports

## Sub-Agent Configuration

```typescript
interface SubAgentSpawnConfig {
  name: string;
  prompt: string;
  systemPrompt?: string;
  tools?: string[];        // Whitelist (only these tools)
  deniedTools?: string[];  // Blacklist (all except these)
  maxTurns?: number;
  timeout?: number;        // ms
  tokenBudget?: number;
  model?: string;
  permissions?: PermissionMode;
  cwd?: string;
}
```

### Agent Identity

```typescript
interface SubAgentIdentity {
  agentId: string;    // Format: "name@teamName"
  name: string;
  team: string;
  parentId?: string;  // Parent agent ID for nesting
}
```

## Pre-Defined Agent Types

`src/orchestrator/agent-definitions.ts`:

| Agent | Purpose | Default Tools |
|-------|---------|---------------|
| `researcher` | Code exploration and analysis | FileRead, Grep, Glob, WebSearch |
| `coder` | Code implementation | FileRead, FileWrite, FileEdit, Bash, Run |
| `reviewer` | Code review | FileRead, Grep, Glob |
| `tester` | Test execution | Bash, Run, FileRead |

## TeamCreate Tool

`src/orchestrator/team-create-tool.ts`:

Allows the main agent to spawn teams of sub-agents:

```typescript
// Tool input
{
  teamName: "code-review",
  agents: [
    { name: "reviewer-1", prompt: "Review auth module", tools: ["FileRead", "Grep"] },
    { name: "reviewer-2", prompt: "Review API module", tools: ["FileRead", "Grep"] }
  ]
}
```

## Error Types

```typescript
type SubAgentError =
  | { type: 'timeout'; timeout: number }
  | { type: 'llm_error'; error: ApiError }
  | { type: 'tool_error'; tool: string; error: string }
  | { type: 'permission_denied'; tool: string }
  | { type: 'max_turns_exceeded'; turns: number }
  | { type: 'cancelled' }
  | { type: 'unexpected'; error: string }
```

## Budget Enforcement

Per-sub-agent token budgets with `KCError` on exceeded limits:
- Configurable via `SubAgentSpawnConfig.tokenBudget`
- Checked after each tool execution
- Shared pool with parent agent's budget (configurable)
