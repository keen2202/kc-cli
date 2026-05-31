# kc-cli Architecture Optimization Specification

> Based on comparative analysis of PilotDeck (OpenBMB/THUNLP) and pi (earendil-works) projects
> Generated: 2026-05-31 | Version: 1.0

---

## 1. Executive Summary

This specification documents 12 architectural improvements for kc-cli, derived from deep analysis of two leading open-source AI agent projects. Improvements are organized into 3 phases by effort-to-payoff ratio, covering error handling, plugin extensibility, compaction efficiency, token budgeting, tool execution pipeline, module organization, runtime abstraction, conversation branching, and human-in-the-loop capabilities.

**Scope:** Codebase-wide architectural improvements across 24 modules
**Risk Profile:** Phase 1 (Low) / Phase 2 (Medium) / Phase 3 (High)
**Total Estimated Effort:** 2-3 weeks

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| Category | Severity | Current State | Target State |
|----------|----------|---------------|--------------|
| Error Handling | High | Mixed try/catch + boolean isError + string matching | Unified Result<T,E> + typed KCError hierarchy |
| Plugin System | Medium | 3 hook types, tools only | 7 contribution types, marketplace-ready |
| Compaction | Medium | Flat if/else chain of 3 strategies | Tiered engine with priority-based selection |
| Token Budgets | Medium | Passive tracking only | Proactive per-session/turn/tool enforcement |
| Tool Execution | Medium | Monolithic executeSingle() | prepare/execute/finalize pipeline |
| Module Organization | Low | Types scattered across 6+ locations | Protocol-first with per-module contracts |
| Runtime Abstraction | Low | Direct fs/child_process imports | ExecutionEnv interface for swappable backends |
| Conversation Model | Low | Flat ChatMessage[] array | Session tree with branching and compaction |
| Human-in-the-Loop | Low | No mid-execution injection | Dual-queue steer/followUp system |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|----------|------|-------|--------|--------|------|
| P0 | Result<T,E> Pattern | 1 | High | 4h | Low |
| P0 | Typed Error Hierarchy | 1 | High | 6h | Low |
| P1 | Expanded Hook System | 1 | Medium | 4h | Low |
| P1 | Stream Event Expansion | 1 | Medium | 3h | Low |
| P2 | Tiered Compaction | 2 | High | 12h | Medium |
| P2 | Contribution Plugins | 2 | High | 10h | Medium |
| P2 | Budget Enforcement | 2 | High | 8h | Medium |
| P2 | Two-Phase Tool Exec | 2 | Medium | 8h | Medium |
| P3 | Protocol-First Design | 3 | High | 16h | High |
| P3 | ExecutionEnv Abstraction | 3 | Medium | 12h | High |
| P3 | Session Tree | 3 | High | 16h | High |
| P3 | Dual-Queue Steering | 3 | Medium | 8h | Medium |

---

## 3. Detailed Fix Proposals

### 3.1 Phase 1: Quick Wins (1-2 days)

#### 3.1.1 Result<T, E> Pattern

**Problem:** Inconsistent error handling -- some functions throw, some return `{ isError: boolean }`, some return null. Makes error propagation unpredictable.

**Source:** pi project's `Result<TValue, TError>` sum type with `ok()`, `err()`, `getOrThrow()` helpers.

**Solution:**

```typescript
// src/types/result.ts
export type Result<T, E = Error> = Ok<T> | Err<E>;
export interface Ok<T> { readonly ok: true; readonly value: T; }
export interface Err<E> { readonly ok: false; readonly error: E; }

export function ok<T>(value: T): Ok<T> { return { ok: true, value }; }
export function err<E>(error: E): Err<E> { return { ok: false, error }; }
export function isOk<T, E>(r: Result<T, E>): r is Ok<T> { return r.ok; }
export function isErr<T, E>(r: Result<T, E>): r is Err<E> { return !r.ok; }
export function unwrapOr<T, E>(r: Result<T, E>, defaultValue: T): T {
  return isOk(r) ? r.value : defaultValue;
}
export function mapResult<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return isOk(r) ? ok(fn(r.value)) : r;
}
export function flatMap<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
  return isOk(r) ? fn(r.value) : r;
}
```

**Files to modify:**
- NEW: `src/types/result.ts`
- `src/executors/toolExecutor.ts:155-265` -- wrap `executeSingle()` return
- `src/query/QueryEngineCompaction.ts:65-179` -- wrap compaction results
- `src/api/BaseApiClient.ts:46-56` -- add `code` field to ApiError

**Backward Compatibility:** `Result` is additive. Existing `isError` boolean fields remain; `Result` wraps them.

---

#### 3.1.2 Typed Error Hierarchy with Stable Codes

**Problem:** Error classification uses string matching on HTTP status codes and regex patterns. No unified error type with stable codes for programmatic handling.

**Source:** pi project's `AgentHarnessError` with code-based classification (`busy`, `invalid_state`, `session`, etc.).

**Solution:**

```typescript
// src/types/errors.ts (expanded)
export type ErrorCode =
  | 'api_rate_limit' | 'api_auth_failed' | 'api_bad_request' | 'api_server_error' | 'api_timeout'
  | 'tool_not_found' | 'tool_timeout' | 'tool_permission_denied' | 'tool_execution_failed'
  | 'compaction_failed' | 'compaction_timeout'
  | 'state_invalid_transition' | 'state_machine_error'
  | 'sandbox_unavailable' | 'sandbox_denied'
  | 'session_not_found' | 'budget_exceeded'
  | 'unknown';

export class KCError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
  readonly cause?: Error;

  constructor(code: ErrorCode, message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message);
    this.name = 'KCError';
    this.code = code;
    this.context = context;
    this.cause = cause;
  }

  static fromApiError(apiError: ApiError): KCError {
    const code = apiError.statusCode === 429 ? 'api_rate_limit'
      : apiError.statusCode === 401 ? 'api_auth_failed'
      : apiError.statusCode && apiError.statusCode >= 400 && apiError.statusCode < 500 ? 'api_bad_request'
      : 'api_server_error';
    return new KCError(code, apiError.message, { statusCode: apiError.statusCode }, apiError);
  }
}
```

**Files to modify:**
- `src/types/errors.ts` (expand from 57 lines)
- `src/services/error-classifier.ts:60-134` -- return `KCError` instances
- `src/query/QueryEngineError.ts:65-72` -- preserve error code in events
- `src/types/events.ts:82` -- update `agent:error` event type
- NEW: `test/types/errors.test.ts`

**Backward Compatibility:** `KCError extends Error`, so `instanceof Error` checks still work.

---

#### 3.1.3 Expanded Hook System

**Problem:** Only 3 hooks (`preToolUse`, `postToolUse`, `postTurn`). No way to inject prompts before turns or recover from errors programmatically.

**Source:** PilotDeck's 5 hook executor types (command, prompt, HTTP, agent, callback).

**Solution:**

```typescript
// src/plugins/types.ts (expanded)
export interface PluginHooks {
  preTurn?: (messages: ChatMessage[], context: ToolUseContext) => Promise<ChatMessage[] | null>;
  preToolUse?: (toolName: string, input: Record<string, unknown>, context: ToolUseContext) =>
    Promise<Record<string, unknown> | null>;
  postToolUse?: (toolName: string, input: Record<string, unknown>, result: ToolResult, context: ToolUseContext) =>
    Promise<ToolResult | null>;
  postTurn?: (messages: ChatMessage[]) => Promise<void>;
  onError?: (error: KCError, context: ToolUseContext) => Promise<KCError | null>;
}
```

**Files to modify:**
- `src/plugins/types.ts:13-17` -- expand `PluginHooks` interface
- `src/plugins/plugin-manager.ts:89-135` -- add chaining for `preTurn` and `onError`
- `src/query/QueryEngine.ts:155-211` -- add hook invocation points
- `src/executors/toolExecutor.ts:248-255` -- `postToolUse` returns modified result

**Backward Compatibility:** All new hooks are optional. Existing plugins unchanged.

---

#### 3.1.4 Streaming Event Protocol Expansion

**Problem:** `LLMStreamEvent` has 5 types. Missing thinking model support, cache status reporting, and usage tracking during streams.

**Source:** pi project's 12-type `AssistantMessageEvent` union.

**Solution:**

```typescript
// src/api/BaseApiClient.ts (expanded LLMStreamEvent)
export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'stop' | 'error'
    | 'thinking_delta' | 'usage_update' | 'cache_status' | 'model_info';
  text?: string;
  toolCall?: ToolCall;
  error?: Error;
  usage?: TokenUsage;
  thinking?: string;
  cacheHit?: boolean;
  model?: string;
}
```

**Files to modify:**
- `src/api/BaseApiClient.ts:8-14` -- expand event types
- `src/types/events.ts:73-86` -- add `agent:thinking_delta`, `agent:cache_status`
- `src/query/QueryEngine.ts:329-391` -- handle new events in `streamLLMResponse()`
- `src/ui/components/App.ts` -- render thinking content
- `src/api/AnthropicClient.ts` -- emit `thinking_delta` for Claude thinking models
- `src/api/OpenAICompatibleClient.ts` -- emit `thinking_delta` for compatible providers

---

### 3.2 Phase 2: Medium Improvements (3-5 days)

#### 3.2.1 Tiered Compaction Engine

**Problem:** Compaction uses a flat if/else chain (microcompact -> fullcompact -> force_truncate). No caching of compaction results, no targeted content snipping.

**Source:** PilotDeck's `CompactionEngine`, `MicroCompactionEngine`, `CachedMicroCompactionEngine`, `SnipEngine`.

**Solution:**

```typescript
// src/services/compaction/types.ts
export interface CompactionEngine {
  name: string;
  priority: number;
  canHandle(messages: ChatMessage[], context: CompactionContext): boolean;
  compact(messages: ChatMessage[], context: CompactionContext): Promise<CompactionResult>;
}

export interface CompactionContext {
  tokenBudget: number;
  currentTokens: number;
  systemPromptTokens: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  tokensSaved: number;
  method: string;
}
```

**Engine hierarchy (priority order):**
1. `CachedMicroCompactionEngine` (priority: 0) -- hash-based cache of microcompact results
2. `SnipCompactionEngine` (priority: 10) -- targeted removal of large tool outputs (>5000 chars)
3. `FullCompactionEngine` (priority: 20) -- LLM-based summarization (existing)
4. `ForceTruncationEngine` (priority: 30) -- last resort truncation (existing)

**Files to modify:**
- NEW: `src/services/compaction/types.ts`
- NEW: `src/services/compaction/cached-micro.ts`
- NEW: `src/services/compaction/snip.ts`
- MOVE: `src/services/compaction.ts` logic -> `src/services/compaction/full.ts` + `force.ts`
- `src/query/QueryEngineCompaction.ts:65-179` -- iterate engines by priority

---

#### 3.2.2 Contribution-Based Plugin Extension

**Problem:** Plugins can only contribute tools and hooks. No way for plugins to declare permission rules, prompt templates, or MCP server integrations.

**Source:** PilotDeck's 7 contribution types (Command, Hook, Tool, Prompt, MCP, PermissionRule, Router).

**Solution:**

```typescript
// src/plugins/types.ts (expanded Plugin interface)
export interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: PluginHooks;
  permissionRules?: PluginPermissionRule[];
  prompts?: PluginPrompt[];
  mcpServers?: PluginMCPConfig[];
  onInit?(): Promise<void>;
  onShutdown?(): Promise<void>;
}

export interface PluginPermissionRule {
  toolPattern: string;
  contentPattern?: string;
  behavior: 'allow' | 'deny' | 'ask';
  priority: number;
}

export interface PluginPrompt {
  name: string;
  template: string;
  description: string;
  args?: Record<string, { type: string; description: string; required?: boolean }>;
}
```

**Files to modify:**
- `src/plugins/types.ts` -- expand interfaces
- `src/plugins/plugin-manager.ts:75-87` -- add `getPluginPermissionRules()`
- `src/permissions/engine.ts:44-204` -- add Step 1.5 for plugin rules
- `src/plugins/plugin-loader.ts` -- validate new contribution types

---

#### 3.2.3 Budget-Aware Token Management

**Problem:** `totalTokensUsed` is tracked passively in `AgentState` but never enforced. No per-turn or per-tool-result limits.

**Source:** PilotDeck's `TokenBudgetManager`, `ToolResultBudget`, `AutoCompactionPolicy`.

**Solution:**

```typescript
// src/services/budget.ts
export interface BudgetConfig {
  sessionTokenLimit: number;
  turnTokenLimit: number;
  toolResultTokenLimit: number;
  subAgentTokenLimit: number;
  costLimitUsd: number | null;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  remaining: BudgetSnapshot;
}

export class BudgetEnforcer {
  private sessionTokens = 0;
  private turnTokens = 0;
  private config: BudgetConfig;

  checkTurnBudget(estimatedTokens: number): BudgetCheckResult;
  checkToolResultBudget(result: ToolResult): BudgetCheckResult;
  recordUsage(tokens: number, costUsd?: number): void;
  resetTurn(): void;
  getRemaining(): BudgetSnapshot;
}
```

**Files to modify:**
- NEW: `src/services/budget.ts`
- `src/state/types.ts:39-72` -- add `budgetUsed` to `AgentState`
- `src/query/QueryEngine.ts:138-211` -- add budget checks at key points
- `src/orchestrator/agent-orchestrator.ts:52-69` -- enforce sub-agent token budget
- `src/state/store.ts:87-91` -- add `checkBudget()` method

---

#### 3.2.4 Two-Phase Tool Execution

**Problem:** `executeSingle()` in toolExecutor.ts is a monolithic function mixing permission checks, sandbox wrapping, execution, and hook invocation.

**Source:** pi project's prepare/execute/finalize pipeline with `beforeToolCall`/`afterToolCall` hooks.

**Solution:**

```typescript
// src/executors/toolExecutor.ts (refactored)
async executeSingle(toolCall: ToolCall, context: ToolUseContext): Promise<ToolResult> {
  const prepared = await this.prepare(toolCall, context);
  if (prepared.skip) return prepared.result!;
  const result = await this.execute(prepared.tool, prepared.input, prepared.context, timeoutMs);
  return this.finalize(toolCall, prepared.input, result, context);
}

private async prepare(toolCall, context): Promise<PrepareResult> {
  // 1. Resolve tool from registry
  // 2. Run plugin preToolUse hooks (can modify input or block)
  // 3. Check permissions
  // 4. Wrap in sandbox if needed
  return { tool, input, context, skip: false };
}

private async execute(tool, input, context, timeoutMs): Promise<ToolResult> {
  // Actual tool.call() with AbortSignal timeout
}

private async finalize(toolCall, input, result, context): Promise<ToolResult> {
  // 1. Run plugin postToolUse hooks (can modify result)
  // 2. Record metrics
  return result;
}
```

**Files to modify:**
- `src/executors/toolExecutor.ts:155-265` -- refactor into 3 phases
- `src/types/tools.ts:40-70` -- add optional `prepare`/`finalize` to `ToolDefinition`

---

### 3.3 Phase 3: Major Architectural Upgrades (1-2 weeks)

#### 3.3.1 Protocol-First Module Design

**Problem:** Types scattered across `src/types/` (6 files), `src/state/types.ts`, `src/orchestrator/types.ts`, `src/memory/types.ts`, `src/plugins/types.ts`. Circular import workarounds exist.

**Source:** PilotDeck's `protocol/` subdirectories in every module.

**Solution:** Create `protocol.ts` in each module directory containing all public interfaces. Keep `src/types/` as re-export barrel.

**New files:**
- `src/api/protocol.ts` -- LLMStreamEvent, TokenUsage, LLMRequestConfig, LLMResponse
- `src/tools/protocol.ts` -- ToolDefinition, ToolUseContext, ToolResult
- `src/state/protocol.ts` -- AgentState, AgentStateName, AgentEvent
- `src/query/protocol.ts` -- QueryEngineConfig, StreamEvent
- `src/permissions/protocol.ts` -- PermissionResult, PermissionContext
- `src/memory/protocol.ts` -- MemoryEntry, MemoryService
- `src/orchestrator/protocol.ts` -- SubAgentSpawnConfig, SubAgentResult
- `src/plugins/protocol.ts` -- Plugin, PluginHooks, PluginManifest

**Files to modify:**
- `src/types/message.ts` -- convert to re-export barrel
- `src/types/tools.ts` -- convert to re-export barrel
- All 100+ files importing from `src/types/` -- update import paths

---

#### 3.3.2 ExecutionEnv Abstraction

**Problem:** Tools directly import `fs` and `child_process`, making them hard to test and impossible to run against remote/sandboxed environments.

**Source:** pi project's `ExecutionEnv` combining `FileSystem` and `Shell` interfaces.

**Solution:**

```typescript
// src/services/execution-env.ts
export interface FileSystem {
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtime: Date; isFile: boolean; isDirectory: boolean }>;
  glob(pattern: string, cwd: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface Shell {
  exec(command: string, options: { cwd?: string; env?: Record<string, string>; timeout?: number; signal?: AbortSignal }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export interface ExecutionEnv {
  fs: FileSystem;
  shell: Shell;
  cwd: string;
}
```

**Files to modify:**
- NEW: `src/services/execution-env.ts`
- NEW: `src/services/execution-env-local.ts`
- NEW: `src/services/execution-env-mock.ts` (for testing)
- `src/types/tools.ts:14-22` -- add `env?: ExecutionEnv` to `ToolUseContext`
- `src/tools/BashTool/` -- use `context.env.shell` instead of `child_process`
- `src/tools/FileReadTool/` -- use `context.env.fs` instead of `fs`
- `src/tools/FileWriteTool/` -- use `context.env.fs`
- `src/tools/FileEditTool/` -- use `context.env.fs`

---

#### 3.3.3 Session Tree (Non-Linear Conversations)

**Problem:** Flat `ChatMessage[]` array in `ConversationState` -- no branching, no undo, no conversation forking.

**Source:** pi project's `SessionTree` with `branch()`, `checkout()`, `merge()`, branch summaries.

**Solution:**

```typescript
// src/state/session-tree.ts
export interface SessionNode {
  id: string;
  parentId: string | null;
  messages: ChatMessage[];
  branchPoint: number;
  summary?: string;
  label?: string;
  createdAt: number;
}

export class SessionTree {
  private nodes: Map<string, SessionNode> = new Map();
  private activeBranchId: string;

  constructor(rootMessages?: ChatMessage[]);

  branch(fromNodeId?: string): string;
  checkout(nodeId: string): void;
  getActiveMessages(): ChatMessage[];
  getActiveNodeId(): string;
  getBranchSummary(nodeId: string): string | undefined;
  setBranchLabel(nodeId: string, label: string): void;
  prune(nodeId: string): void;
  merge(fromNodeId: string): void;
  getTree(): SessionNode[];
}
```

**Files to modify:**
- NEW: `src/state/session-tree.ts`
- NEW: `test/state/session-tree.test.ts`
- `src/query/QueryEngineState.ts` -- replace flat array with `SessionTree`
- `src/state/store.ts:39-72` -- add `activeBranchId` to `AgentState`
- `src/query/QueryEngineCompaction.ts` -- operate on active branch only
- NEW: `src/commands/branch.ts` -- branch/checkout/history CLI commands

---

#### 3.3.4 Dual-Queue Steering

**Problem:** No mechanism to inject messages during agent execution. User must wait for completion or abort entirely.

**Source:** pi project's `steer()` (mid-run injection) and `followUp()` (post-completion continuation).

**Solution:**

```typescript
// In QueryEngine
private steerQueue: ChatMessage[] = [];
private followUpQueue: ChatMessage[] = [];

steer(message: string): void {
  this.steerQueue.push({
    role: 'user',
    content: message,
    timestamp: Date.now(),
  });
}

followUp(message: string): void {
  this.followUpQueue.push({
    role: 'user',
    content: message,
    timestamp: Date.now(),
  });
}
```

**Files to modify:**
- `src/query/QueryEngine.ts` -- add queues, `steer()`, `followUp()`, drain logic in state machine
- `src/types/events.ts` -- add `agent:steered` event type
- `src/ui/keypress.ts` -- add `Ctrl+I` shortcut for steer input
- `src/ui/components/InputBox.ts` -- support disabled state during execution with steer prompt

---

## 4. Files Impact Matrix

### 4.1 Files Modified Per Phase

**Phase 1 (11 files):**
| File | Changes |
|------|---------|
| `src/types/result.ts` | NEW -- Result<T,E> type |
| `src/types/errors.ts` | EXPAND -- KCError hierarchy |
| `src/api/BaseApiClient.ts` | MODIFY -- add code to ApiError, expand LLMStreamEvent |
| `src/types/events.ts` | MODIFY -- add thinking_delta, cache_status events |
| `src/plugins/types.ts` | MODIFY -- add preTurn, onError hooks |
| `src/plugins/plugin-manager.ts` | MODIFY -- hook chaining |
| `src/query/QueryEngine.ts` | MODIFY -- hook invocation, event handling |
| `src/query/QueryEngineCompaction.ts` | MODIFY -- Result wrapping |
| `src/query/QueryEngineError.ts` | MODIFY -- KCError integration |
| `src/executors/toolExecutor.ts` | MODIFY -- Result wrapping |
| `src/services/error-classifier.ts` | MODIFY -- return KCError |

**Phase 2 (14 files):**
| File | Changes |
|------|---------|
| `src/services/compaction/types.ts` | NEW -- CompactionEngine interface |
| `src/services/compaction/cached-micro.ts` | NEW -- cached micro compaction |
| `src/services/compaction/snip.ts` | NEW -- targeted content snipping |
| `src/services/compaction/full.ts` | MOVE -- LLM compaction |
| `src/services/compaction/force.ts` | MOVE -- force truncation |
| `src/services/budget.ts` | NEW -- BudgetEnforcer |
| `src/plugins/types.ts` | MODIFY -- add contribution types |
| `src/plugins/plugin-manager.ts` | MODIFY -- permission rules, prompts |
| `src/plugins/plugin-loader.ts` | MODIFY -- validate contributions |
| `src/permissions/engine.ts` | MODIFY -- plugin rule step |
| `src/state/types.ts` | MODIFY -- add budgetUsed |
| `src/state/store.ts` | MODIFY -- add checkBudget |
| `src/query/QueryEngineCompaction.ts` | MODIFY -- engine iteration |
| `src/types/tools.ts` | MODIFY -- add prepare/finalize |

**Phase 3 (18+ files):**
| File | Changes |
|------|---------|
| `src/api/protocol.ts` | NEW |
| `src/tools/protocol.ts` | NEW |
| `src/state/protocol.ts` | NEW |
| `src/query/protocol.ts` | NEW |
| `src/permissions/protocol.ts` | NEW |
| `src/memory/protocol.ts` | NEW |
| `src/orchestrator/protocol.ts` | NEW |
| `src/plugins/protocol.ts` | NEW |
| `src/services/execution-env.ts` | NEW |
| `src/services/execution-env-local.ts` | NEW |
| `src/services/execution-env-mock.ts` | NEW |
| `src/state/session-tree.ts` | NEW |
| `src/commands/branch.ts` | NEW |
| `src/types/message.ts` | MODIFY -- re-export barrel |
| `src/types/tools.ts` | MODIFY -- add env, re-export |
| `src/tools/BashTool/` | MODIFY -- use ExecutionEnv |
| `src/tools/FileReadTool/` | MODIFY -- use ExecutionEnv |
| `src/tools/FileWriteTool/` | MODIFY -- use ExecutionEnv |

---

## 5. Progress Tracking

| # | Task | Phase | Status | Date | Notes |
|---|------|-------|--------|------|-------|
| 1.1 | Result<T,E> Pattern | 1 | completed | 2026-05-31 | `src/types/result.ts`, 23 tests |
| 1.2 | Typed Error Hierarchy | 1 | completed | 2026-05-31 | `src/types/errors.ts` expanded with KCError, 18+ tests |
| 1.3 | Expanded Hook System | 1 | completed | 2026-05-31 | preTurn/onError hooks, postToolUse returns ToolResult, 14 tests |
| 1.4 | Stream Event Expansion | 1 | completed | 2026-05-31 | thinking_delta/usage_update/cache_status/model_info, 10 tests |
| 2.1 | Tiered Compaction | 2 | completed | 2026-05-31 | CachedMicro/Snip/Full/Force engines with priority iteration |
| 2.2 | Contribution Plugins | 2 | completed | 2026-05-31 | permissionRules/prompts/mcpServers, Step 1.5 in engine |
| 2.3 | Budget Enforcement | 2 | completed | 2026-05-31 | BudgetEnforcer with per-session/turn/tool limits, 32 tests |
| 2.4 | Two-Phase Tool Exec | 2 | completed | 2026-05-31 | prepare/execute/finalize pipeline, 21 tests |
| 3.1 | Protocol-First Design | 3 | completed | 2026-05-31 | 8 protocol.ts files + 7 re-export barrels |
| 3.2 | ExecutionEnv Abstraction | 3 | completed | 2026-05-31 | FileSystem/Shell interfaces, Local+Mock impls, 4 tools refactored, 32 tests |
| 3.3 | Session Tree | 3 | completed | 2026-05-31 | SessionTree with branch/checkout/merge, CLI commands, 26 tests |
| 3.4 | Dual-Queue Steering | 3 | completed | 2026-05-31 | steer()/followUp(), Ctrl+I shortcut, agent:steered event, 17 tests |

---

## 6. Verification & Testing Plan

### 6.1 Per-Phase Verification

**Phase 1:**
- `npm run typecheck` passes after each change
- `npm test` passes (all 120+ test files)
- `npm run test:coverage` meets thresholds (60% lines/branches/functions/statements)
- New unit tests for Result<T,E>, KCError, expanded hooks
- Manual: start REPL, send message, verify response

**Phase 2:**
- Integration tests for tiered compaction with MockLLMClient
- Plugin integration tests for permission rules and prompts
- Budget enforcement tests with token counting verification
- Two-phase tool execution tests with hook blocking/modification
- Full regression suite passes

**Phase 3:**
- All imports resolve correctly (`npm run typecheck`)
- MockExecutionEnv enables tool tests without fs/child_process
- Session tree: branch/checkout/merge/compaction tests
- Dual-queue: steer injection during streaming tests
- End-to-end: full agent loop with branching and steering

### 6.2 Regression Safety

Each phase completed as separate branch with PR. Key checks:
1. `npm run typecheck` -- zero errors
2. `npm test` -- all tests pass
3. `npm run test:coverage` -- thresholds met
4. `npm run build` -- clean compilation
5. Manual smoke test -- REPL functional

### 6.3 Performance Benchmarks

| Metric | Current Baseline | Target After Optimization |
|--------|-----------------|---------------------------|
| Startup time | Measure | No regression |
| Tool execution latency | Measure | No regression |
| Compaction time | Measure | -20% (cached micro) |
| Memory usage | Measure | No regression |
| Test suite duration | Measure | No regression |

---

## 7. Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking existing plugins | Low | High | All new hooks/contributions optional; existing API unchanged |
| Circular imports from protocol split | Medium | Medium | Use re-export barrels in src/types/; incremental migration |
| Performance regression from abstraction | Low | Medium | Benchmark before/after; ExecutionEnv is optional in ToolUseContext |
| Session tree complexity | Medium | High | Public API unchanged (getMessages/addMessage); tree is internal |
| Test coverage drop | Medium | Low | Add tests alongside each change; coverage gate in CI |
