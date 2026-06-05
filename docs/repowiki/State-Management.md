# State Management

Observable state store with immutable updates, state machine validation, and session tree branching.

## ObservableStateStore

`src/state/store.ts`:

### Design Principles
- **Immutable updates**: State changes via spread operator, never mutation
- **Listener pattern**: Subscribe/unsubscribe for state change notifications
- **Automatic cleanup**: Tool executions tracked with max 500 limit and 5-minute age

### API

```typescript
class ObservableStateStore {
  getState(): AgentState;
  setState(partial: Partial<AgentState>): void;
  subscribe(listener: (state: AgentState) => void): Unsubscribe;

  // Convenience methods
  incrementTurn(): void;
  addTokenUsage(tokens: TokenUsage): void;
  updateToolExecution(toolId: string, update: Partial<ToolExecutionState>): void;
  resetToIdle(): void;
}
```

## AgentState

`src/state/protocol.ts`:

```typescript
interface AgentState {
  // Core
  cwd: string;
  sessionId: string;
  verbose: boolean;
  printMode: boolean;
  bareMode: boolean;

  // API
  model: string;
  provider: string;
  maxTokens: number;

  // Permissions
  permissionMode: PermissionMode;

  // Execution
  currentState: AgentStateName;
  turnCount: number;
  maxTurns: number;
  maxBudgetUsd: number;
  totalTokensUsed: number;

  // Budget tracking
  sessionBudget: BudgetState;
  currentTurnBudget: BudgetState;
  toolResultsBudget: BudgetState;

  // Compaction
  compactFailureCount: number;
  lastCompactedAt?: number;

  // Tool execution
  activeToolExecutions: Map<string, ToolExecutionState>;

  // Branching
  activeBranchId: string;

  // Timestamps
  createdAt: number;
  lastActivityAt: number;
}
```

## State Machine

`src/state/machine.ts` -- `AgentStateMachine`:

### States

```
idle → compacting → streaming → deciding → executing → completed → idle
  ↑         │           │          │           │           │
  └─────────┴───────────┴──────────┴───────────┴───────────┘
                    (error transitions)
```

### Validated Transitions

```typescript
const VALID_TRANSITIONS = new Set([
  'idle→compacting',
  'compacting→streaming',
  'compacting→error',
  'streaming→deciding',
  'streaming→error',
  'deciding→executing',
  'deciding→completed',
  'deciding→error',
  'executing→streaming',
  'executing→completed',
  'executing→error',
  'completed→idle',
  'error→idle',
]);
```

Invalid transitions throw `KCError` with `invalid_state_transition` code.

### AgentEvent Discriminated Union

```typescript
type AgentEvent =
  | { type: 'state_change'; from: AgentStateName; to: AgentStateName }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage_update'; tokens: TokenUsage }
  | { type: 'cache_status'; hit: boolean }
  | { type: 'steered'; message: string }
  | { type: 'error'; error: KCError }
  | { type: 'turn_complete'; messages: ChatMessage[] }
  | { type: 'done' }
```

## SessionTree

`src/state/session-tree.ts`:

Non-linear conversation branching with full tree operations.

### Data Structure

```
Root
├── Node A (messages 1-5)
│   ├── Node B (messages 6-10)  ← branch "feature-x"
│   └── Node C (messages 6-8)   ← branch "experiment"
└── Node D (messages 1-3)       ← branch "alternative"
    └── Node E (messages 4-7)
```

Each node stores:
- `id`: Unique node identifier
- `parentId`: Parent node ID
- `messages`: Messages from branch point to this node
- `branchName`: Optional human-readable name
- `createdAt`: Timestamp

### Operations

```typescript
class SessionTree {
  branch(name?: string): string;           // Fork at current point, returns node ID
  checkout(nodeId: string): ChatMessage[];  // Switch branch, returns full message list
  merge(nodeId: string): void;              // Merge branch into current
  prune(nodeId: string): void;              // Delete branch and descendants
  getTree(): TreeStructure;                 // Get full tree for visualization
  getMessages(nodeId: string): ChatMessage[]; // Reconstruct messages root-to-node
  toJSON(): SerializedTree;                 // Serialize for persistence
  static fromJSON(data: SerializedTree): SessionTree; // Deserialize
}
```

### Message Reconstruction

Walking from root to a leaf node reconstructs the full conversation for that branch:

```
Root → A → B: [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8, msg9, msg10]
Root → A → C: [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8]
Root → D → E: [msg1, msg2, msg3, msg4, msg5, msg6, msg7]
```

### REPL Commands

```bash
/branch              # List all branches with current marked
/branch feature-x    # Create new branch named "feature-x"
/checkout <id>       # Switch to branch (prefix matching)
/history             # ASCII tree visualization
```

## Tool Execution Tracking

Active tool executions tracked in `AgentState.activeToolExecutions`:

```typescript
interface ToolExecutionState {
  toolName: string;
  startTime: number;
  status: 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
}
```

Automatic cleanup:
- Max 500 tracked executions
- 5-minute age limit
- Eviction on state update if limits exceeded
