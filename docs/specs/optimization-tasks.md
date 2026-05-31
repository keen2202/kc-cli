# kc-cli Optimization Task Breakdown

> Generated: 2026-05-31 | Based on architecture-optimization-spec.md v1.0
> Total Tasks: 12 | Phases: 3

---

## Task Dependency Graph

```
Phase 1 (Quick Wins):
  T1.1 Result<T,E> ─────┬──> T2.1 Tiered Compaction
  T1.2 Typed Errors ────┼──> T2.3 Budget Enforcement ──> T3.1 Protocol-First
  T1.3 Expanded Hooks ──┼──> T2.2 Contribution Plugins
  T1.4 Stream Events    └──> T2.4 Two-Phase Tools ──────> T3.2 ExecutionEnv

Phase 2 (Medium):
  T2.1 ──> T3.3 Session Tree ──> T3.4 Dual-Queue Steering

Phase 3 (Major):
  T3.1 Protocol-First (blocked by T1.1, T1.2)
  T3.2 ExecutionEnv   (blocked by T2.4)
  T3.3 Session Tree   (blocked by T2.1)
  T3.4 Dual-Queue     (blocked by T3.3)
```

---

## Phase 1: Quick Wins

### Task 1.1: Implement Result<T, E> Type Pattern

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Implement Result<T, E> sum type for unified error handling
- **Subject (continuous):** Implementing Result<T, E> sum type for unified error handling
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.1.1
- **Dependencies:**
  - blockedBy: none
  - blocks: T2.1, T2.4, T3.1
- **Checklist:**
  - [ ] Create `src/types/result.ts` with `Result<T,E>`, `Ok<T>`, `Err<E>` types
  - [ ] Implement helper functions: `ok()`, `err()`, `isOk()`, `isErr()`, `mapResult()`, `flatMap()`, `unwrapOr()`
  - [ ] Add `code` field to `ApiError` in `src/api/BaseApiClient.ts`
  - [ ] Wrap compaction return types in `src/query/QueryEngineCompaction.ts` with Result
  - [ ] Wrap tool executor return in `src/executors/toolExecutor.ts` with Result
  - [ ] Create `test/types/result.test.ts` with full coverage
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - NEW: `src/types/result.ts`
  - MODIFY: `src/api/BaseApiClient.ts` (lines 46-56)
  - MODIFY: `src/query/QueryEngineCompaction.ts` (lines 65-179)
  - MODIFY: `src/executors/toolExecutor.ts` (lines 155-265)
  - NEW: `test/types/result.test.ts`

---

### Task 1.2: Build Typed Error Hierarchy with Stable Codes

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Build KCError class hierarchy with stable ErrorCode union type
- **Subject (continuous):** Building KCError class hierarchy with stable ErrorCode union type
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.1.2
- **Dependencies:**
  - blockedBy: none
  - blocks: T2.3, T3.1
- **Checklist:**
  - [ ] Define `ErrorCode` union type in `src/types/errors.ts` (18 error codes)
  - [ ] Create `KCError` class extending `Error` with `code`, `context`, `cause` fields
  - [ ] Implement `KCError.fromApiError()` static factory
  - [ ] Refactor `src/services/error-classifier.ts` to return `KCError` instances
  - [ ] Update `src/query/QueryEngineError.ts` to preserve error codes in events
  - [ ] Update `agent:error` event type in `src/types/events.ts`
  - [ ] Create `test/types/errors.test.ts` with all error code coverage
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/types/errors.ts` (expand from 57 lines)
  - MODIFY: `src/services/error-classifier.ts` (lines 60-134)
  - MODIFY: `src/query/QueryEngineError.ts` (lines 65-72)
  - MODIFY: `src/types/events.ts` (line 82)
  - NEW: `test/types/errors.test.ts`

---

### Task 1.3: Expand Plugin Hook System

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Add preTurn and onError hooks to the plugin system
- **Subject (continuous):** Adding preTurn and onError hooks to the plugin system
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.1.3
- **Dependencies:**
  - blockedBy: none
  - blocks: T2.2, T2.4
- **Checklist:**
  - [ ] Add `preTurn` hook signature to `PluginHooks` in `src/plugins/types.ts`
  - [ ] Add `onError` hook signature to `PluginHooks` in `src/plugins/types.ts`
  - [ ] Modify `postToolUse` to accept return value that can modify results
  - [ ] Add chaining logic for `preTurn` in `src/plugins/plugin-manager.ts`
  - [ ] Add chaining logic for `onError` in `src/plugins/plugin-manager.ts`
  - [ ] Add `preTurn` invocation before compaction phase in `src/query/QueryEngine.ts`
  - [ ] Add `onError` invocation in error catch block in `src/query/QueryEngine.ts`
  - [ ] Create `test/plugins/hooks.test.ts` for new hook types
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/plugins/types.ts` (lines 13-17)
  - MODIFY: `src/plugins/plugin-manager.ts` (lines 89-135)
  - MODIFY: `src/query/QueryEngine.ts` (lines 155-211)
  - MODIFY: `src/executors/toolExecutor.ts` (lines 248-255)
  - NEW: `test/plugins/hooks.test.ts`

---

### Task 1.4: Expand Streaming Event Protocol

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Expand LLMStreamEvent with thinking_delta, usage_update, cache_status types
- **Subject (continuous):** Expanding LLMStreamEvent with thinking_delta, usage_update, cache_status types
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.1.4
- **Dependencies:**
  - blockedBy: none
  - blocks: T2.4
- **Checklist:**
  - [ ] Add `thinking_delta`, `usage_update`, `cache_status`, `model_info` to `LLMStreamEvent` in `src/api/BaseApiClient.ts`
  - [ ] Add `agent:thinking_delta` and `agent:cache_status` to `AgentEvent` in `src/types/events.ts`
  - [ ] Handle new event types in `streamLLMResponse()` in `src/query/QueryEngine.ts`
  - [ ] Emit `thinking_delta` from `src/api/AnthropicClient.ts` for thinking models
  - [ ] Update `src/ui/components/App.ts` to render thinking content
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/api/BaseApiClient.ts` (lines 8-14)
  - MODIFY: `src/types/events.ts` (lines 73-86)
  - MODIFY: `src/query/QueryEngine.ts` (lines 329-391)
  - MODIFY: `src/api/AnthropicClient.ts`
  - MODIFY: `src/ui/components/App.ts`

---

## Phase 2: Medium Improvements

### Task 2.1: Implement Tiered Compaction Engine

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Implement tiered compaction engine with priority-based strategy selection
- **Subject (continuous):** Implementing tiered compaction engine with priority-based strategy selection
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.2.1
- **Dependencies:**
  - blockedBy: T1.1
  - blocks: T3.3
- **Checklist:**
  - [ ] Create `src/services/compaction/types.ts` with `CompactionEngine` interface
  - [ ] Implement `CachedMicroCompactionEngine` in `src/services/compaction/cached-micro.ts`
  - [ ] Implement `SnipCompactionEngine` in `src/services/compaction/snip.ts`
  - [ ] Move existing LLM compaction to `src/services/compaction/full.ts`
  - [ ] Move existing force truncation to `src/services/compaction/force.ts`
  - [ ] Refactor `QueryEngineCompaction.ts` to iterate engines by priority
  - [ ] Create `test/services/compaction.test.ts` for all engines
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
  - [ ] Verify compaction time improvement with cached micro engine
- **Files:**
  - NEW: `src/services/compaction/types.ts`
  - NEW: `src/services/compaction/cached-micro.ts`
  - NEW: `src/services/compaction/snip.ts`
  - NEW: `src/services/compaction/full.ts`
  - NEW: `src/services/compaction/force.ts`
  - MODIFY: `src/query/QueryEngineCompaction.ts` (lines 65-179)
  - NEW: `test/services/compaction.test.ts`

---

### Task 2.2: Implement Contribution-Based Plugin Extension

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Add permissionRules, prompts, and mcpServers contribution types to plugin system
- **Subject (continuous):** Adding permissionRules, prompts, and mcpServers contribution types to plugin system
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.2.2
- **Dependencies:**
  - blockedBy: T1.3
  - blocks: none
- **Checklist:**
  - [ ] Add `PluginPermissionRule` and `PluginPrompt` interfaces to `src/plugins/types.ts`
  - [ ] Add `permissionRules`, `prompts`, `mcpServers` fields to `Plugin` interface
  - [ ] Implement `getPluginPermissionRules()` in `src/plugins/plugin-manager.ts`
  - [ ] Add Step 1.5 in `src/permissions/engine.ts` for plugin-contributed rules
  - [ ] Add validation for new contribution types in `src/plugins/plugin-loader.ts`
  - [ ] Create `test/plugins/contributions.test.ts`
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/plugins/types.ts`
  - MODIFY: `src/plugins/plugin-manager.ts` (lines 75-87)
  - MODIFY: `src/permissions/engine.ts` (lines 44-204)
  - MODIFY: `src/plugins/plugin-loader.ts`
  - NEW: `test/plugins/contributions.test.ts`

---

### Task 2.3: Implement Budget-Aware Token Management

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Implement proactive token budget enforcement per session, turn, and tool result
- **Subject (continuous):** Implementing proactive token budget enforcement per session, turn, and tool result
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.2.3
- **Dependencies:**
  - blockedBy: T1.2
  - blocks: T3.1
- **Checklist:**
  - [ ] Create `src/services/budget.ts` with `BudgetEnforcer` class and `BudgetConfig` interface
  - [ ] Add `budgetUsed` field to `AgentState` in `src/state/types.ts`
  - [ ] Add `checkBudget()` method to `src/state/store.ts`
  - [ ] Wire budget checks into `src/query/QueryEngine.ts` at streaming, executing, and spawn points
  - [ ] Enforce `tokenBudget` from `SubAgentSpawnConfig` in `src/orchestrator/agent-orchestrator.ts`
  - [ ] Create `test/services/budget.test.ts`
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - NEW: `src/services/budget.ts`
  - MODIFY: `src/state/types.ts` (lines 39-72)
  - MODIFY: `src/state/store.ts` (lines 87-91)
  - MODIFY: `src/query/QueryEngine.ts` (lines 138-211)
  - MODIFY: `src/orchestrator/agent-orchestrator.ts` (lines 52-69)
  - NEW: `test/services/budget.test.ts`

---

### Task 2.4: Implement Two-Phase Tool Execution Pipeline

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Refactor tool execution into prepare/execute/finalize pipeline
- **Subject (continuous):** Refactoring tool execution into prepare/execute/finalize pipeline
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.2.4
- **Dependencies:**
  - blockedBy: T1.1, T1.3
  - blocks: T3.2
- **Checklist:**
  - [ ] Refactor `executeSingle()` into `prepare()`, `execute()`, `finalize()` in `src/executors/toolExecutor.ts`
  - [ ] Add optional `prepare` and `finalize` methods to `ToolDefinition` in `src/types/tools.ts`
  - [ ] Move permission checks and sandbox wrapping into `prepare()` phase
  - [ ] Move plugin `postToolUse` hooks into `finalize()` phase
  - [ ] Create `test/executors/two-phase.test.ts` for hook blocking/modification
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/executors/toolExecutor.ts` (lines 155-265)
  - MODIFY: `src/types/tools.ts` (lines 40-70)
  - NEW: `test/executors/two-phase.test.ts`

---

## Phase 3: Major Architectural Upgrades

### Task 3.1: Restructure to Protocol-First Module Design

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Create per-module protocol.ts files and migrate type definitions
- **Subject (continuous):** Creating per-module protocol.ts files and migrating type definitions
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.3.1
- **Dependencies:**
  - blockedBy: T1.1, T1.2
  - blocks: none
- **Checklist:**
  - [ ] Create `src/api/protocol.ts` with LLMStreamEvent, TokenUsage, LLMRequestConfig, LLMResponse
  - [ ] Create `src/tools/protocol.ts` with ToolDefinition, ToolUseContext, ToolResult
  - [ ] Create `src/state/protocol.ts` with AgentState, AgentStateName, AgentEvent
  - [ ] Create `src/query/protocol.ts` with QueryEngineConfig, StreamEvent
  - [ ] Create `src/permissions/protocol.ts` with PermissionResult, PermissionContext
  - [ ] Create `src/memory/protocol.ts` with MemoryEntry, MemoryService
  - [ ] Create `src/orchestrator/protocol.ts` with SubAgentSpawnConfig, SubAgentResult
  - [ ] Create `src/plugins/protocol.ts` with Plugin, PluginHooks, PluginManifest
  - [ ] Convert `src/types/message.ts` to re-export barrel
  - [ ] Convert `src/types/tools.ts` to re-export barrel
  - [ ] Update all imports across codebase (100+ files)
  - [ ] Verify no circular imports remain
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - NEW: `src/api/protocol.ts`
  - NEW: `src/tools/protocol.ts`
  - NEW: `src/state/protocol.ts`
  - NEW: `src/query/protocol.ts`
  - NEW: `src/permissions/protocol.ts`
  - NEW: `src/memory/protocol.ts`
  - NEW: `src/orchestrator/protocol.ts`
  - NEW: `src/plugins/protocol.ts`
  - MODIFY: `src/types/message.ts` (convert to re-export)
  - MODIFY: `src/types/tools.ts` (convert to re-export)
  - MODIFY: 100+ files (import path updates)

---

### Task 3.2: Implement ExecutionEnv Abstraction

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Create ExecutionEnv interface and refactor tools to use swappable backends
- **Subject (continuous):** Creating ExecutionEnv interface and refactoring tools to use swappable backends
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.3.2
- **Dependencies:**
  - blockedBy: T2.4
  - blocks: none
- **Checklist:**
  - [ ] Create `src/services/execution-env.ts` with FileSystem, Shell, ExecutionEnv interfaces
  - [ ] Create `src/services/execution-env-local.ts` with LocalExecutionEnv
  - [ ] Create `src/services/execution-env-mock.ts` for testing
  - [ ] Add `env?: ExecutionEnv` to ToolUseContext in `src/types/tools.ts`
  - [ ] Refactor BashTool to use `context.env.shell`
  - [ ] Refactor FileReadTool to use `context.env.fs`
  - [ ] Refactor FileWriteTool to use `context.env.fs`
  - [ ] Refactor FileEditTool to use `context.env.fs`
  - [ ] Wire ExecutionEnv into toolExecutor context creation
  - [ ] Create `test/services/execution-env.test.ts`
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - NEW: `src/services/execution-env.ts`
  - NEW: `src/services/execution-env-local.ts`
  - NEW: `src/services/execution-env-mock.ts`
  - MODIFY: `src/types/tools.ts` (lines 14-22)
  - MODIFY: `src/tools/BashTool/`
  - MODIFY: `src/tools/FileReadTool/`
  - MODIFY: `src/tools/FileWriteTool/`
  - MODIFY: `src/tools/FileEditTool/`
  - MODIFY: `src/executors/toolExecutor.ts`
  - NEW: `test/services/execution-env.test.ts`

---

### Task 3.3: Implement Session Tree for Non-Linear Conversations

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Implement session tree data structure with branching and compaction support
- **Subject (continuous):** Implementing session tree data structure with branching and compaction support
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.3.3
- **Dependencies:**
  - blockedBy: T2.1
  - blocks: T3.4
- **Checklist:**
  - [ ] Create `src/state/session-tree.ts` with SessionNode and SessionTree classes
  - [ ] Implement `branch()`, `checkout()`, `getActiveMessages()`, `getBranchSummary()`, `prune()`, `merge()`
  - [ ] Replace flat array in ConversationState with SessionTree
  - [ ] Add `activeBranchId` to AgentState in `src/state/store.ts`
  - [ ] Update compaction to operate on active branch only
  - [ ] Create branch/checkout/history CLI commands in `src/commands/`
  - [ ] Create `test/state/session-tree.test.ts` with full coverage
  - [ ] Verify public API unchanged (getMessages/addMessage still work)
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - NEW: `src/state/session-tree.ts`
  - NEW: `src/commands/branch.ts`
  - MODIFY: `src/query/QueryEngineState.ts`
  - MODIFY: `src/state/store.ts` (lines 39-72)
  - MODIFY: `src/query/QueryEngineCompaction.ts`
  - NEW: `test/state/session-tree.test.ts`

---

### Task 3.4: Implement Dual-Queue Steering System

- **Status:** `completed` (2026-05-31)
- **Subject (imperative):** Implement steer() and followUp() message injection during agent execution
- **Subject (continuous):** Implementing steer() and followUp() message injection during agent execution
- **Spec:** `docs/specs/architecture-optimization-spec.md` Section 3.3.4
- **Dependencies:**
  - blockedBy: T3.3
  - blocks: none
- **Checklist:**
  - [ ] Add `steerQueue` and `followUpQueue` to QueryEngine
  - [ ] Implement `steer(message)` public method
  - [ ] Implement `followUp(message)` public method
  - [ ] Modify state machine loop to drain steerQueue between phases
  - [ ] Drain followUpQueue after turn completion
  - [ ] Add `agent:steered` event type to `src/types/events.ts`
  - [ ] Add `Ctrl+I` keyboard shortcut in `src/ui/keypress.ts`
  - [ ] Create `test/query/steering.test.ts`
  - [ ] `npm run typecheck` passes
  - [ ] `npm test` passes
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts` (lines 157-210)
  - MODIFY: `src/types/events.ts`
  - MODIFY: `src/ui/keypress.ts`
  - MODIFY: `src/ui/components/InputBox.ts`
  - NEW: `test/query/steering.test.ts`

---

## Summary Table

| ID | Task | Phase | Status | blockedBy | blocks | Est. Hours |
|----|------|-------|--------|-----------|--------|------------|
| T1.1 | Result<T,E> Pattern | 1 | completed | -- | T2.1, T2.4, T3.1 | 4h |
| T1.2 | Typed Error Hierarchy | 1 | completed | -- | T2.3, T3.1 | 6h |
| T1.3 | Expanded Hook System | 1 | completed | -- | T2.2, T2.4 | 4h |
| T1.4 | Stream Event Expansion | 1 | completed | -- | T2.4 | 3h |
| T2.1 | Tiered Compaction | 2 | completed | T1.1 | T3.3 | 12h |
| T2.2 | Contribution Plugins | 2 | completed | T1.3 | -- | 10h |
| T2.3 | Budget Enforcement | 2 | completed | T1.2 | T3.1 | 8h |
| T2.4 | Two-Phase Tool Exec | 2 | completed | T1.1, T1.3 | T3.2 | 8h |
| T3.1 | Protocol-First Design | 3 | completed | T1.1, T1.2 | -- | 16h |
| T3.2 | ExecutionEnv Abstraction | 3 | completed | T2.4 | -- | 12h |
| T3.3 | Session Tree | 3 | completed | T2.1 | T3.4 | 16h |
| T3.4 | Dual-Queue Steering | 3 | completed | T3.3 | -- | 8h |
| | | | | | **Total** | **107h** |
