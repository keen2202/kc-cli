# Query Engine

The core agent loop, implemented as a facade over four specialized sub-modules.

## Location

`src/query/QueryEngine.ts` with sub-modules:
- `QueryEngineState.ts` -- Conversation state management
- `QueryEngineCompaction.ts` -- Auto-compaction logic
- `QueryEngineMemory.ts` -- Memory integration
- `QueryEngineError.ts` -- Error handling and circuit breaker

## State Machine

```
                    ┌──────────┐
                    │   idle   │◄──────────────────────┐
                    └────┬─────┘                       │
                         │ submitMessage()              │
                    ┌────▼──────┐                       │
               ┌───►│compacting │  error                │
               │    └────┬──────┘──────────┐            │
               │         │ compact done    │            │
               │    ┌────▼──────┐          │            │
               │    │ streaming │  error    │            │
               │    └────┬──────┘──────────┤            │
               │         │ stream done     │            │
               │    ┌────▼──────┐          │            │
               │    │ deciding  │  error    │            │
               │    └──┬─────┬─┘──────────┤            │
               │       │     │             │            │
               │  has  │     │ no tools    │            │
               │  tools│     │             │            │
               │  ┌────▼─────▼──┐          │            │
               │  │  executing  │  error    │            │
               │  └──┬───────┬─┘──────────┘            │
               │     │       │                         │
               │     │       │ completed               │
               │     │  ┌────▼──────┐                  │
               └─────┘  │ completed │──────────────────┘
                        └───────────┘
```

Transitions are validated via `VALID_TRANSITIONS` Set with O(1) lookup. Invalid transitions throw `KCError`.

## Facade Delegation

QueryEngine delegates to four sub-modules:

### ConversationState (QueryEngineState.ts)
- Message storage and retrieval
- Token count caching (invalidated on change)
- Message trimming (hard limit: 1000 messages)
- SessionTree branching (branch, checkout, merge, prune)
- Cache prefix computation (stable vs ephemeral system prompt segments)

### CompactionHandler (QueryEngineCompaction.ts)
- Pre-compaction check: triggers when token count exceeds threshold
- Strategy selection via `CompactionHandler` (priority-ordered)
- Circuit breaker integration: disables compaction after repeated failures
- See [[Sandbox#Compaction]] for tier details

### MemoryHandler (QueryEngineMemory.ts)
- Pre-query memory loading into system prompt
- Post-turn memory extraction (when idle threshold met)
- Relevance search for context-appropriate memories
- See [[Memory-System]]

### ErrorHandler (QueryEngineError.ts)
- Error classification via `ErrorClassifier`
- Retry logic with exponential backoff
- Circuit breaker for external services (API calls)
- `KCError.fromApiError()` for automatic error code assignment

## Streaming Model

`submitMessage()` returns `AsyncGenerator<StreamEvent | AgentEvent>`:

```typescript
type StreamEvent =
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

Consumers iterate the generator to process events in real-time. The UI subscribes to these events for rendering.

## Steering System

Two queues for mid-execution message injection:

### steerQueue
- Injected between tool execution phases
- Triggered by `engine.steer("message")` or Ctrl+I in UI
- Message is appended to conversation before next LLM call
- Does not abort current tool execution

### followUpQueue
- Queued for the next turn after current completes
- Triggered by `engine.followUp("message")`
- Automatically submitted as a new turn when current turn ends

```
Turn N executing:
  tool1.run() → steer("check tests too") → tool2.run()
  └─ steer message injected before next LLM call

Turn N completes:
  followUp("now do module B") → queued
  └─ automatically becomes Turn N+1
```

## Cache Prefix Optimization

System prompt is split into:
- **Stable prefix**: Project context, tool descriptions, static instructions
- **Ephemeral suffix**: Memory context, current conversation state

The stable prefix is byte-identical across turns, maximizing LLM prompt cache hits. The cache prefix service computes a hash of the stable portion to detect changes.

## Token Budget

Budget enforcement at multiple granularities:
- **Session limit**: Total tokens across all turns
- **Turn limit**: Tokens per single turn (LLM call + tool results)
- **Tool result limit**: Individual tool output size cap
- **Sub-agent limit**: Per-sub-agent token allocation

Budget exceeded → `KCError` with `budget_exceeded` code, turn terminates gracefully.
