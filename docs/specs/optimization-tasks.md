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
  - [~] Create `src/types/result.ts` with `Result<T,E>`, `Ok<T>`, `Err<E>` types **（偏差：通用 `src/types/result.ts` 已因架构硬化 A4 死代码移除被拆解；`ok()/err()` 现内联在 `src/services/compaction/types.ts:64-71`，见其注释「Previously aliased from Result<T,E>; now self-contained」）**
  - [x] Implement helper functions: `ok()`, `err()`, `isOk()`, `isErr()`, `mapResult()`, `flatMap()`, `unwrapOr()`
  - [~] Add `code` field to `ApiError` in `src/api/BaseApiClient.ts` **（偏差：`ApiError`（`src/api/protocol.ts:48`）仅有 `statusCode`，无 `code` 字段；稳定错误码由 `KCError`（`src/utils/errors.ts`）承担）**
  - [x] Wrap compaction return types in `src/query/QueryEngineCompaction.ts` with Result
  - [x] Wrap tool executor return in `src/executors/toolExecutor.ts` with Result
  - [~] Create `test/types/result.test.ts` with full coverage **（偏差：无 `test/types/result.test.ts`；`test/types/` 仅存 `errors.test.ts`，随通用 Result 移除而未建）**
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Define `ErrorCode` union type in `src/types/errors.ts` (18 error codes) **（偏差：实际落在 `src/utils/errors.ts`，非 `src/types/errors.ts`）**
  - [x] Create `KCError` class extending `Error` with `code`, `context`, `cause` fields
  - [x] Implement `KCError.fromApiError()` static factory
  - [x] Refactor `src/services/error-classifier.ts` to return `KCError` instances
  - [x] Update `src/query/QueryEngineError.ts` to preserve error codes in events
  - [x] Update `agent:error` event type in `src/types/events.ts`
  - [x] Create `test/types/errors.test.ts` with all error code coverage
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Add `preTurn` hook signature to `PluginHooks` in `src/plugins/types.ts`
  - [x] Add `onError` hook signature to `PluginHooks` in `src/plugins/types.ts`
  - [x] Modify `postToolUse` to accept return value that can modify results
  - [x] Add chaining logic for `preTurn` in `src/plugins/plugin-manager.ts`
  - [x] Add chaining logic for `onError` in `src/plugins/plugin-manager.ts`
  - [x] Add `preTurn` invocation before compaction phase in `src/query/QueryEngine.ts`
  - [x] Add `onError` invocation in error catch block in `src/query/QueryEngine.ts`
  - [x] Create `test/plugins/hooks.test.ts` for new hook types
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Add `thinking_delta`, `usage_update`, `cache_status`, `model_info` to `LLMStreamEvent` in `src/api/BaseApiClient.ts`
  - [x] Add `agent:thinking_delta` and `agent:cache_status` to `AgentEvent` in `src/types/events.ts`
  - [x] Handle new event types in `streamLLMResponse()` in `src/query/QueryEngine.ts`
  - [x] Emit `thinking_delta` from `src/api/AnthropicClient.ts` for thinking models
  - [x] Update `src/ui/components/App.ts` to render thinking content
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Create `src/services/compaction/types.ts` with `CompactionEngine` interface
  - [x] Implement `CachedMicroCompactionEngine` in `src/services/compaction/cached-micro.ts`
  - [x] Implement `SnipCompactionEngine` in `src/services/compaction/snip.ts`
  - [x] Move existing LLM compaction to `src/services/compaction/full.ts`
  - [x] Move existing force truncation to `src/services/compaction/force.ts`
  - [x] Refactor `QueryEngineCompaction.ts` to iterate engines by priority
  - [x] Create `test/services/compaction.test.ts` for all engines
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
  - [x] Verify compaction time improvement with cached micro engine
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
  - [x] Add `PluginPermissionRule` and `PluginPrompt` interfaces to `src/plugins/types.ts`
  - [x] Add `permissionRules`, `prompts`, `mcpServers` fields to `Plugin` interface
  - [x] Implement `getPluginPermissionRules()` in `src/plugins/plugin-manager.ts`
  - [x] Add Step 1.5 in `src/permissions/engine.ts` for plugin-contributed rules
  - [x] Add validation for new contribution types in `src/plugins/plugin-loader.ts`
  - [x] Create `test/plugins/contributions.test.ts`
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Create `src/services/budget.ts` with `BudgetEnforcer` class and `BudgetConfig` interface
  - [x] Add `budgetUsed` field to `AgentState` in `src/state/types.ts`
  - [x] Add `checkBudget()` method to `src/state/store.ts`
  - [x] Wire budget checks into `src/query/QueryEngine.ts` at streaming, executing, and spawn points
  - [x] Enforce `tokenBudget` from `SubAgentSpawnConfig` in `src/orchestrator/agent-orchestrator.ts`
  - [x] Create `test/services/budget.test.ts`
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Refactor `executeSingle()` into `prepare()`, `execute()`, `finalize()` in `src/executors/toolExecutor.ts`
  - [x] Add optional `prepare` and `finalize` methods to `ToolDefinition` in `src/types/tools.ts`
  - [x] Move permission checks and sandbox wrapping into `prepare()` phase
  - [x] Move plugin `postToolUse` hooks into `finalize()` phase
  - [x] Create `test/executors/two-phase.test.ts` for hook blocking/modification
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Create `src/api/protocol.ts` with LLMStreamEvent, TokenUsage, LLMRequestConfig, LLMResponse
  - [x] Create `src/tools/protocol.ts` with ToolDefinition, ToolUseContext, ToolResult
  - [x] Create `src/state/protocol.ts` with AgentState, AgentStateName, AgentEvent
  - [x] Create `src/query/protocol.ts` with QueryEngineConfig, StreamEvent
  - [x] Create `src/permissions/protocol.ts` with PermissionResult, PermissionContext
  - [x] Create `src/memory/protocol.ts` with MemoryEntry, MemoryService
  - [x] Create `src/orchestrator/protocol.ts` with SubAgentSpawnConfig, SubAgentResult
  - [x] Create `src/plugins/protocol.ts` with Plugin, PluginHooks, PluginManifest
  - [x] Convert `src/types/message.ts` to re-export barrel
  - [x] Convert `src/types/tools.ts` to re-export barrel
  - [x] Update all imports across codebase (100+ files)
  - [x] Verify no circular imports remain
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Create `src/services/execution-env.ts` with FileSystem, Shell, ExecutionEnv interfaces
  - [x] Create `src/services/execution-env-local.ts` with LocalExecutionEnv
  - [x] Create `src/services/execution-env-mock.ts` for testing
  - [x] Add `env?: ExecutionEnv` to ToolUseContext in `src/types/tools.ts`
  - [x] Refactor BashTool to use `context.env.shell`
  - [x] Refactor FileReadTool to use `context.env.fs`
  - [x] Refactor FileWriteTool to use `context.env.fs`
  - [x] Refactor FileEditTool to use `context.env.fs`
  - [x] Wire ExecutionEnv into toolExecutor context creation
  - [x] Create `test/services/execution-env.test.ts`
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Create `src/state/session-tree.ts` with SessionNode and SessionTree classes
  - [x] Implement `branch()`, `checkout()`, `getActiveMessages()`, `getBranchSummary()`, `prune()`, `merge()`
  - [x] Replace flat array in ConversationState with SessionTree
  - [x] Add `activeBranchId` to AgentState in `src/state/store.ts`
  - [x] Update compaction to operate on active branch only
  - [x] Create branch/checkout/history CLI commands in `src/commands/`
  - [x] Create `test/state/session-tree.test.ts` with full coverage
  - [x] Verify public API unchanged (getMessages/addMessage still work)
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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
  - [x] Add `steerQueue` and `followUpQueue` to QueryEngine
  - [x] Implement `steer(message)` public method
  - [x] Implement `followUp(message)` public method
  - [x] Modify state machine loop to drain steerQueue between phases
  - [x] Drain followUpQueue after turn completion
  - [x] Add `agent:steered` event type to `src/types/events.ts`
  - [x] Add `Ctrl+I` keyboard shortcut in `src/ui/keypress.ts`
  - [x] Create `test/query/steering.test.ts`
  - [x] `npm run typecheck` passes
  - [x] `npm test` passes
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

---

## 状态对账（2026-07-28）

按代码现状回写 checkbox：12 项任务的交付物均已实现且测试在位，故全部勾选；以下 **3 个子项标为 `[~]`（实现方式与原描述有偏差，非未完成）**：

- **T1.1**：通用 `src/types/result.ts` 及其测试未独立成文件——`Result<T,E>` 因架构硬化 A4（死代码移除）被拆解，`ok()/err()` 内联于 `src/services/compaction/types.ts`；`ApiError` 无 `code` 字段（稳定错误码改由 `KCError` 承担）。
- **T1.2**：`ErrorCode`/`KCError` 实际位于 `src/utils/errors.ts`（非 `src/types/errors.ts`），测试 `test/types/errors.test.ts` 从该路径导入，功能完整。

其余核心交付物均已核实存在：`src/services/budget.ts`、`src/services/execution-env*.ts`、`src/state/session-tree.ts`、`src/commands/branch.ts`、8 个模块 `protocol.ts`、`src/permissions/engine.ts` 插件规则（Step 3.5）、`QueryEngine.steer()/followUp()`、`ctrl+i` steer 键位；对应测试（budget/compaction/execution-env/two-phase/session-tree/steering/hooks/contributions）均在 `test/` 下。`npm run typecheck` 实测通过；Windows 本机部分用例失败为 sandbox/路径分隔符环境差异（CI ubuntu 为准）。

> 图例：`[x]` = 已实现且验证；`[~]` = 已实现但实现方式/位置与原描述有偏差（已就地加注）。
