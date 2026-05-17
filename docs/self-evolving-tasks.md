# KC-CLI Self-Evolving Agent Task Breakdown

> **项目**: KC-CLI Self-Evolving Agent System
> **版本**: 1.0
> **创建日期**: 2026-05-17
> **关联 Spec**: [docs/superpowers/specs/2026-05-17-self-evolving-cli-design.md](superpowers/specs/2026-05-17-self-evolving-cli-design.md)
> **前置依赖**: v3.0.0（已发布）
> **目标**: 实现自愈（Self-Healing）、自进化（Self-Evolution）、开箱即用（Out-of-the-Box）三大能力层

---

## 任务依赖图

```
Phase 1 (Self-Healing Core):
  TASK-050 (Error Classifier) ──┬──→ TASK-051 (Circuit Breaker)
                                │         │
  TASK-052 (State Validator) ───┤         │
  TASK-053 (Timeout Fix) ───────┤         │
  TASK-054 (Anchor Protection)──┘         │
                                          ↓
Phase 2 (Memory System):           TASK-060 (Retry Expansion)
  TASK-055 (Wire Up Stubs) ──────────────→ TASK-056 (Enhanced Extraction)
  TASK-057 (Relevance Scoring)            TASK-058 (Quality Pipeline)

Phase 3 (Observability):
  TASK-061 (Health Check) ←── TASK-051
  TASK-062 (Session Metrics)
  TASK-063 (Auto-Reconnect) ←── TASK-061

Phase 4 (Behavioral Adaptation):
  TASK-064 (User Profile) ←── TASK-062
  TASK-065 (Behavioral Adapter) ←── TASK-064
  TASK-066 (Param Tuning) ←── TASK-062

Phase 5 (Out-of-the-Box):
  TASK-067 (First-Run) ←── TASK-064
  TASK-068 (Auto-Config)
  TASK-069 (Tool Hints + Prompt Adapt) ←── TASK-064, TASK-065
```

---

## Phase 1: Self-Healing Core (Foundation)

### TASK-050: Enhanced Error Classifier

**Status**: completed
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Enhance error classifier with HTTP status code inspection and retry-after support
- Present Continuous: Enhancing error classifier with HTTP status code inspection and retry-after support

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-051, TASK-060]

**Checklist**:
- [x] Modify `src/services/error-classifier.ts` to inspect HTTP status codes:
  - 429 → `transient`
  - 500-509 → `transient`
  - 400-499 → `permanent`
- [x] Update API clients (`AnthropicClient`, `OpenAICompatibleClient`, `OllamaClient`) to expose `statusCode` and `responseHeaders` on thrown errors
- [x] Parse structured error responses (JSON error bodies with error codes)
- [x] Extract `retryAfterMs` from `Retry-After` headers (passed through from API client errors)
- [x] Keep string matching as fallback for unstructured errors
- [x] Fix `RetryState`: reset counter on successful retry
- [x] Consume `degraded` error class in QueryEngine (log warning, continue execution)
- [x] Write `test/services/error-classifier-enhanced.test.ts` covering:
  - HTTP 429 → transient classification
  - HTTP 500 → transient classification
  - HTTP 403 → permanent classification
  - `Retry-After` header extraction
  - `RetryState` reset on success
  - Fallback to string matching
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§3a Error Recovery Resilience - Enhanced Error Classifier](superpowers/specs/2026-05-17-self-evolving-cli-design.md#3a-error-recovery-resilience)

---

### TASK-051: Circuit Breaker Service

**Status**: completed
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Implement circuit breaker service for external service resilience
- Present Continuous: Implementing circuit breaker service for external service resilience

**Dependencies**:
- `blockedBy`: [TASK-050]
- `blocks`: [TASK-060, TASK-061]

**Checklist**:
- [x] Create `src/services/circuitBreaker.ts` with:
  - `CircuitBreakerConfig` interface (failureThreshold: 5, resetTimeoutMs: 30000, halfOpenTestCount: 1)
  - `CircuitState` type: `closed` | `open` | `half-open`
  - `CircuitBreaker` class with `canExecute()`, `recordSuccess()`, `recordFailure()`, `getState()`
- [x] Implement per-service tracking: API client, LSP, MCP each get their own breaker
- [x] Integrate with `QueryEngine`: when circuit opens, yield degraded event instead of retrying
- [x] Add `/circuit-breaker` REPL command to view/reset circuit states
- [x] Write `test/services/circuitBreaker.test.ts` covering:
  - Closed → open transition after N failures
  - Open → half-open after reset timeout
  - Half-open → closed on success
  - Half-open → open on failure
  - `canExecute()` returns false when open
  - Per-service isolation
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§3a Error Recovery Resilience - Circuit Breaker](superpowers/specs/2026-05-17-self-evolving-cli-design.md#circuit-breaker)

---

### TASK-052: State Validator

**Status**: completed
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Implement conversation state validator for corruption detection and repair
- Present Continuous: Implementing conversation state validator for corruption detection and repair

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-060]

**Checklist**:
- [x] Create `src/services/stateValidator.ts` with:
  - `ValidationResult` interface (valid, issues, repaired)
  - `ValidationIssue` interface (type, messageIndex, severity)
  - `StateValidator` class with `validate()` and `repair()` methods
- [x] Implement validation checks:
  - Orphaned tool results (result without matching tool call)
  - Missing tool calls (call without result, except in-flight)
  - Stale token estimates (force recalculate after tool execution)
  - Invalid tool result structure (non-empty toolCallId, valid JSON)
- [x] Run validation checkpoint before each compaction phase in `QueryEngine`
- [x] Log all repairs for audit trail
- [x] Write `test/services/stateValidator.test.ts` covering:
  - Orphaned tool result detection and removal
  - Missing tool call detection
  - Stale token estimate recalculation
  - Invalid tool result structure detection
  - Repair preserves message integrity
  - Clean conversation passes validation
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§3b State Corruption Recovery - Conversation State Validator](superpowers/specs/2026-05-17-self-evolving-cli-design.md#conversation-state-validator)

---

### TASK-053: Timeout Result Fix

**Status**: completed
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 1d

**任务描述**:
- Imperative: Fix timeout result propagation and race condition in tool executor
- Present Continuous: Fixing timeout result propagation and race condition in tool executor

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-060]

**Checklist**:
- [x] Modify `src/executors/toolExecutor.ts`:
  - `executeWithTimeout` must propagate the original `toolCall.id` to the timeout result
  - Add `timedOut: true` flag to timeout result so LLM knows the tool didn't complete
  - Fix race condition where successful tool result is discarded at timeout boundary
- [x] Use `AbortController` to cancel the actual tool execution on timeout (not just ignore result)
- [x] Write `test/executors/toolExecutor-timeout.test.ts` covering:
  - Timeout result includes correct `toolCallId`
  - `timedOut: true` flag present in timeout result
  - Successful result within timeout is returned correctly
  - Race condition at boundary: result arriving exactly at timeout
  - Slow tool is actually aborted (not just result discarded)
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§3b State Corruption Recovery - Timeout Result Fix](superpowers/specs/2026-05-17-self-evolving-cli-design.md#timeout-result-fix)

---

### TASK-054: Context Anchor Protection

**Status**: completed
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 1d

**任务描述**:
- Imperative: Add context anchor protection to prevent critical message trimming
- Present Continuous: Adding context anchor protection to prevent critical message trimming

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-060]

**Checklist**:
- [x] Modify `src/query/QueryEngine.ts`:
  - Mark system prompt and original user task description as "anchor" messages
  - Add `isAnchor` flag to `ChatMessage` type or track anchor indices separately
  - `trimMessages()` skips anchor messages, removing the next-oldest non-anchor instead
- [x] Preserve at least 2 anchor messages (system prompt + first user message)
- [x] Write `test/query/anchor-protection.test.ts` covering:
  - System prompt is never trimmed
  - Original user task is never trimmed
  - Non-anchor messages are trimmed in correct order
  - Trim with all anchors at start still works
  - Trim with mixed anchor positions
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§3b State Corruption Recovery - Context Anchor Protection](superpowers/specs/2026-05-17-self-evolving-cli-design.md#context-anchor-protection)

---

## Phase 2: Memory System (Self-Evolution Core)

### TASK-055: Wire Up Memory Stubs

**Status**: completed
**Priority**: P0
**Phase**: Phase 2
**预估工时**: 1.5d

**任务描述**:
- Imperative: Wire up existing memory system stubs to enable actual memory extraction and consolidation
- Present Continuous: Wiring up existing memory system stubs to enable actual memory extraction and consolidation

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-056]

**Checklist**:
- [x] Modify `src/memory/integration.ts`:
  - Replace no-op memory extraction with call to `memoryExtraction.extractMemoriesFromMessages()`
  - Wire up deduplication check before writing new memories
  - Fix the TODO at line 103 (LLM-based memory extraction placeholder)
- [x] Modify `src/services/memoryConsolidation.ts`:
  - Implement `mergeRelatedMemories()` — merge memories with overlapping content
  - Implement `stage_integrate()` — integrate staged memories into active set
- [x] Modify `src/services/consolidationScheduler.ts`:
  - Implement `checkSessionGate()` — determine if consolidation should run based on session activity
- [x] Write `test/services/consolidationScheduler.test.ts` covering:
  - Messages are extracted into memories after conversation
  - Duplicate memories are detected and skipped
  - Consolidation merges related memories
  - Scheduler gates consolidation correctly
- [x] Run `tsc --noEmit` + full test suite (1206/1207 pass, 1 pre-existing flaky test)

**Spec Documentation**: [§4c Memory System Evolution - Wire Up Existing Stubs](superpowers/specs/2026-05-17-self-evolving-cli-design.md#wire-up-existing-stubs)

---

### TASK-056: Enhanced Memory Extraction

**Status**: completed
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Enhance memory extraction with LLM-assisted mode, confidence scoring, and deduplication
- Present Continuous: Enhancing memory extraction with LLM-assisted mode, confidence scoring, and deduplication

**Dependencies**:
- `blockedBy`: [TASK-055]
- `blocks`: [TASK-058]

**Checklist**:
- [x] Modify `src/services/memoryExtraction.ts`:
  - Add confidence scoring: regex matches → low confidence, LLM extraction → high confidence
  - Add deduplication: check existing memories before writing new ones (content hash comparison)
  - Fix the overwrite bug: use unique filenames with timestamps + random suffix
  - Add quality checks: minimum length (20 chars), no code-only content (>50% code blocks), no exact duplicates
- [x] Modify `src/memory/types.ts`: Add `confidence?: 'low' | 'high'` to MemoryHeader
- [x] Modify `src/memory/frontmatter.ts`: Parse and generate confidence field
- [x] Write `test/services/memoryExtraction-enhanced.test.ts` covering (15 tests):
  - Regex extraction produces low-confidence results
  - Deduplication prevents exact duplicates (case-insensitive)
  - Unique filenames prevent overwrites (timestamp + random)
  - Quality checks reject too-short or code-only content
  - Extraction patterns for user preferences, project decisions, feedback
- [x] Run `tsc --noEmit` + full test suite (74/74 files, 1222/1222 tests pass)

**Spec Documentation**: [§4c Memory System Evolution - Enhanced Memory Extraction](superpowers/specs/2026-05-17-self-evolving-cli-design.md#enhanced-memory-extraction)

---

### TASK-057: Adaptive Relevance Scoring

**Status**: completed
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1.5d

**任务描述**:
- Imperative: Improve memory relevance scoring with feedback tracking and stale threshold fix
- Present Continuous: Improving memory relevance scoring with feedback tracking and stale threshold fix

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-058]

**Checklist**:
- [x] Modify `src/memory/relevanceSearch.ts`:
  - Track which loaded memories were actually referenced in the conversation (feedback signal)
  - Adjust scoring weights based on feedback: memories that were loaded but never referenced get lower future scores
  - Fix stale threshold: change from 1 day to configurable (default 30 days)
  - Add caching of computed scores within a session (invalidate on new memory write)
- [x] Write `test/memory/relevanceSearch-enhanced.test.ts` covering (16 tests):
  - Referenced memories get score boost in future searches
  - Unreferenced memories get score penalty
  - Stale threshold uses configurable value (not hardcoded 1 day)
  - Score caching works within session
  - Cache invalidation on new memory
- [x] Run `tsc --noEmit` + full test suite (75/75 files, 1238/1238 tests pass)

**Spec Documentation**: [§4c Memory System Evolution - Adaptive Relevance Scoring](superpowers/specs/2026-05-17-self-evolving-cli-design.md#adaptive-relevance-scoring)

---

### TASK-058: Memory Quality Pipeline

**Status**: completed
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement memory quality pipeline for extraction validation and pruning
- Present Continuous: Implementing memory quality pipeline for extraction validation and pruning

**Dependencies**:
- `blockedBy`: [TASK-056, TASK-057]
- `blocks`: []

**Checklist**:
- [x] Create `src/services/memoryQuality.ts`:
  - Post-extraction checks: minimum length (20 chars), no code-only content (>50% code blocks)
  - Post-consolidation validation: merged memories are coherent (contradiction detection)
  - Memory pruning: remove memories loaded N+ times but never referenced (configurable, default 5)
- [x] Write `test/services/memoryQuality.test.ts` covering (20 tests):
  - Short memories are rejected
  - Code-only memories are rejected
  - Contradictory merged memories are flagged
  - Pruning removes stale unretrieved memories
  - Actively retrieved memories are preserved
- [x] Run `tsc --noEmit` + full test suite (76/76 files, 1258/1258 tests pass)

**Spec Documentation**: [§4c Memory System Evolution - Memory Quality Pipeline](superpowers/specs/2026-05-17-self-evolving-cli-design.md#memory-quality-pipeline)

---

## Phase 3: Observability (Self-Healing Extended)

### TASK-059: Retry Expansion

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 1.5d

**任务描述**:
- Imperative: Expand retry support to compaction and tool execution with loop-based approach
- Present Continuous: Expanding retry support to compaction and tool execution with loop-based approach

**Dependencies**:
- `blockedBy`: [TASK-050, TASK-051, TASK-052, TASK-053, TASK-054]
- `blocks`: []

**Checklist**:
- [x] Modify `src/query/QueryEngine.ts`:
  - Add retry to compaction API calls (2 retries with `retryAfterMs` support)
  - Use `retryAfterMs` from error classifier when available
  - Convert recursive retry to loop-based approach (prevent stack overflow)
  - Fix retry counter: reset on success, not just on final failure
- [x] Write `test/query/QueryEngine-retry.test.ts` covering (3 tests):
  - Compaction retries on transient error
  - Loop-based retry doesn't overflow stack
  - Retry counter resets on success
- [x] Run `tsc --noEmit` + full test suite (77/77 files, 1261/1261 tests pass)

**Spec Documentation**: [§3a Error Recovery Resilience - Retry Expansion](superpowers/specs/2026-05-17-self-evolving-cli-design.md#retry-expansion)

---

### TASK-060: Health Check Service

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Implement service health monitoring for API, LSP, and MCP connections
- Present Continuous: Implementing service health monitoring for API, LSP, and MCP connections

**Dependencies**:
- `blockedBy`: [TASK-051]
- `blocks`: [TASK-063]

**Checklist**:
- [x] Create `src/services/healthCheck.ts` with:
  - `ServiceHealth` interface (service, status, lastCheck, latencyMs, error)
  - `HealthCheckService` class with per-service health checks
  - `checkApiHealth()` — checks API circuit breaker state
  - `checkLspHealth()` — checks LSP circuit breaker state
  - `checkMcpHealth()` — checks MCP circuit breaker state
  - `getServiceHealth()` — return all service health statuses
  - `startPeriodicChecks(intervalMs)` / `stop()` — background monitoring
  - Custom health check injection for testing
- [x] Integrate with circuit breaker: unhealthy service → open circuit
- [x] Write `test/services/healthCheck.test.ts` covering (17 tests):
  - API/LSP/MCP health check returns healthy when circuit breaker closed
  - Unhealthy when circuit breaker open
  - Failure tracking with degraded/unhealthy thresholds
  - Custom health check functions
  - Periodic checks run at configured interval
  - Unhealthy service triggers circuit breaker
- [x] Run `tsc --noEmit` + full test suite (78/78 files, 1278/1278 tests pass)

**Spec Documentation**: [§3c Service Health Monitoring - Health Check Service](superpowers/specs/2026-05-17-self-evolving-cli-design.md#health-check-service)

---

### TASK-061: Auto-Reconnect

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement automatic reconnection for LSP and MCP services
- Present Continuous: Implementing automatic reconnection for LSP and MCP services

**Dependencies**:
- `blockedBy`: [TASK-060]
- `blocks`: []

**Checklist**:
- [x] Create `src/services/autoReconnect.ts`:
  - `AutoReconnectService` class with exponential backoff (configurable: 3 attempts, 1s/2s/4s)
  - `reconnect()` — attempt reconnection with retry loop
  - `scheduleReconnect()` — background reconnection scheduling
  - `markConnected()` / `markDisconnected()` — state management
  - `needsReconnect()` — check if service needs reconnection
- [x] Write `test/services/autoReconnect.test.ts` covering (15 tests):
  - Reconnect succeeds on first retry
  - Reconnect retries on failure
  - Reconnect fails after max attempts
  - Exponential backoff timing
  - Service state management
  - Error handling
- [x] Run `tsc --noEmit` + full test suite (79/79 files, 1293/1293 tests pass)

**Spec Documentation**: [§3c Service Health Monitoring - Auto-Reconnect](superpowers/specs/2026-05-17-self-evolving-cli-design.md#auto-reconnect)

---

### TASK-062: Session Metrics Collector

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement session metrics collection for behavioral adaptation foundation
- Present Continuous: Implementing session metrics collection for behavioral adaptation foundation

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-064, TASK-066]

**Checklist**:
- [x] Create `src/services/sessionMetrics.ts` with:
  - `ToolMetrics` interface (toolName, totalCalls, successCount, failureCount, avgExecutionMs, lastUsed)
  - `SessionMetrics` interface (sessionId, startTime, endTime, turnCount, toolCalls, commandsUsed, errorCount, compactCount)
  - `SessionMetricsCollector` class with `recordToolCall()`, `recordCommand()`, `recordTurn()`, `recordError()`, `getMetrics()`
  - `persist()` — save to `~/.kc-cli/metrics/`
  - `load()` — load historical metrics
  - `getMostUsedTools()` / `getMostFailingTools()` — analytics
- [x] Write `test/services/sessionMetrics.test.ts` covering (16 tests):
  - Tool call recording (success/failure, execution time)
  - Command usage tracking
  - Turn counting
  - Average execution time calculation
  - Most used/failing tools analytics
- [x] Run `tsc --noEmit` + full test suite (80/80 files, 1309/1309 tests pass)

**Spec Documentation**: [§4a Behavioral Adaptation - Session Metrics Collector](superpowers/specs/2026-05-17-self-evolving-cli-design.md#session-metrics-collector)

---

## Phase 4: Behavioral Adaptation (Self-Evolution Extended)

### TASK-063: User Profile Service

**Status**: completed
**Priority**: P2
**Phase**: Phase 4
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement user profile service for tracking preferences and coding style
- Present Continuous: Implementing user profile service for tracking preferences and coding style

**Dependencies**:
- `blockedBy`: [TASK-062]
- `blocks`: [TASK-065, TASK-067, TASK-069]

**Checklist**:
- [x] Create `src/services/userProfile.ts` with:
  - `UserProfile` interface (level, preferredTools, codingStyle, sessionCount, totalToolCalls)
  - `UserProfileService` class with `getProfile()`, `updateLevel()`, `recordToolPreference()`, `recordCodingStyle()`, `persist()`
  - `detectCodingStyle()` helper for file analysis
- [x] Track preferred tools (top 10 by recency)
- [x] Track coding style: language from extensions, indentation, naming convention
- [x] User level manually set via `updateLevel()` (beginner/intermediate/advanced)
- [x] Persist to `~/.kc-cli/settings.json`
- [x] Write `test/services/userProfile.test.ts` covering (18 tests):
  - Profile creation with default values
  - Level update (beginner/intermediate/advanced)
  - Tool preference tracking
  - Coding style detection
  - Persistence and loading
- [x] Run `tsc --noEmit` + full test suite (81/81 files, 1327/1327 tests pass)

**Spec Documentation**: [§4a Behavioral Adaptation - User Profile Service](superpowers/specs/2026-05-17-self-evolving-cli-design.md#user-profile-service)

---

### TASK-064: Behavioral Adapter

**Status**: completed
**Priority**: P2
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Implement behavioral adapter for system prompt and tool hint customization
- Present Continuous: Implementing behavioral adapter for system prompt and tool hint customization

**Dependencies**:
- `blockedBy`: [TASK-063]
- `blocks`: [TASK-069]

**Checklist**:
- [x] Create `src/services/behavioralAdapter.ts` with:
  - `getSystemPromptAdaptation(level)` — returns prompt additions based on user level
  - `getToolHints(toolName, success, errorHistory)` — returns contextual hints after tool execution
  - `adaptConversationPacing(level)` — adjusts verbosity and detail level
  - `getAdaptationConfig(level)` — returns full config for a level
- [x] System prompt adaptation:
  - `beginner`: include brief tool descriptions in system prompt
  - `intermediate`: include tool names only, no descriptions
  - `advanced`: minimal system prompt, no tool list
- [x] Tool hint system:
  - `beginner`: show hint after every tool execution
  - `intermediate`: show hints only after errors
  - `advanced`: no hints
  - Tool alternative suggestions when tool fails repeatedly (3+ failures)
- [x] Write `test/services/behavioralAdapter.test.ts` covering (16 tests):
  - Beginner gets tool descriptions in prompt
  - Intermediate gets tool names only
  - Advanced gets minimal prompt
  - Hints shown after errors for intermediate
  - No hints for advanced
  - Tool alternative suggestions when tool fails repeatedly
- [x] Run `tsc --noEmit` + full test suite (82/82 files, 1343/1343 tests pass)

**Spec Documentation**: [§4a Behavioral Adaptation - Behavioral Adapter](superpowers/specs/2026-05-17-self-evolving-cli-design.md#behavioral-adapter)

---

### TASK-065: Parameter Auto-Tuning Service

**Status**: completed
**Priority**: P2
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Implement parameter auto-tuning service for adaptive configuration
- Present Continuous: Implementing parameter auto-tuning service for adaptive configuration

**Dependencies**:
- `blockedBy`: [TASK-062]
- `blocks`: []

**Checklist**:
- [x] Create `src/services/paramTuner.ts` with:
  - `TunedParameters` interface (toolTimeouts, maxRetries, compactionThreshold, extractionThrottle, lastTuned, observationCount)
  - `ParameterTuningService` class with `recordOutcome()`, `getTunedValue()`, `shouldTune()`, `tune()`, `persist()`
- [x] Auto-tune parameters:
  - `toolTimeout` — per-tool, based on historical execution times (p95 + 20% buffer)
  - `maxRetries` — per-service, based on recovery rates
  - `compactionThreshold` — based on conversation patterns
  - `extractionThrottle` — based on extraction yield
- [x] Conservative adjustments: only adjust after N observations (default 10), never more than 20% per adjustment
- [x] Persist tuned parameters to `~/.kc-cli/tuned-params.json`
- [x] Write `test/services/paramTuner.test.ts` covering (13 tests):
  - Outcome recording
  - Tuned value retrieval
  - Conservative adjustment (max 20%)
  - Observation threshold before tuning
  - Per-tool timeout tuning
- [x] Run `tsc --noEmit` + full test suite (83/83 files, 1356/1356 tests pass)

**Spec Documentation**: [§4b Parameter Auto-Tuning - Parameter Tuning Service](superpowers/specs/2026-05-17-self-evolving-cli-design.md#parameter-auto-tuning)

---

## Phase 5: Out-of-the-Box Experience

### TASK-066: First-Run Experience

**Status**: completed
**Priority**: P1
**Phase**: Phase 5
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement first-run experience with guided tour and auto-configuration
- Present Continuous: Implementing first-run experience with guided tour and auto-configuration

**Dependencies**:
- `blockedBy`: [TASK-063]
- `blocks`: []

**Checklist**:
- [x] Create `src/services/firstRun.ts` with:
  - `isFirstRun()` — check if `~/.kc-cli/.first-run-complete` exists
  - `runTour()` — guided tour with 5 steps (async generator)
  - `completeTour()` — create marker file
  - `skipTour()` — create marker file without running tour
- [x] Guided tour steps:
  1. "Welcome to KC-CLI! I'm your AI coding assistant."
  2. "I can read files, run commands, search code, and more."
  3. "Try asking me to 'list files in this directory' to get started."
  4. "Type /help anytime to see available commands."
  5. "Use /level to adjust assistance level (beginner/intermediate/advanced)."
- [x] Tour is skippable with `skipTour()`
- [x] After tour, set `~/.kc-cli/.first-run-complete` marker
- [x] Write `test/services/firstRun.test.ts` covering (13 tests):
  - First run detected when marker file missing
  - Tour creates marker file
  - Skip creates marker file
  - Subsequent runs skip tour
  - Tour steps execute in order
- [x] Run `tsc --noEmit` + full test suite (84/84 files, 1369/1369 tests pass)

**Spec Documentation**: [§5 Out-of-the-Box - First-Run Experience](superpowers/specs/2026-05-17-self-evolving-cli-design.md#5e-first-run-experience)

---

### TASK-067: Auto-Configuration

**Status**: completed
**Priority**: P1
**Phase**: Phase 5
**预估工时**: 1.5d

**任务描述**:
- Imperative: Implement auto-configuration based on project type detection
- Present Continuous: Implementing auto-configuration based on project type detection

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [x] Create `src/bootstrap/autoConfig.ts` with:
  - `detectProjectType()` — detect project type from indicator files
  - `autoConfigure()` — run full auto-configuration
  - `getRecommendedLsp()` — get LSP server for project type
  - `getSupportedProjectTypes()` — list all supported types
- [x] Project type detection:
  - `package.json` → Node.js
  - `pyproject.toml` / `setup.py` / `requirements.txt` → Python
  - `go.mod` → Go
  - `Cargo.toml` → Rust
  - `pom.xml` / `build.gradle` → Java
  - `Gemfile` → Ruby
  - `CMakeLists.txt` / `Makefile` → C/C++
- [x] Auto-enable relevant LSP servers based on detected language
- [x] Show summary: "Detected Node.js project. LSP enabled. Sandbox configured."
- [x] Write `test/bootstrap/autoConfig.test.ts` covering (14 tests):
  - Node.js project detection
  - Python project detection
  - Go project detection
  - Multi-language project (primary detected)
  - Unknown project type fallback
  - LSP auto-enable
  - Summary message output
- [x] Run `tsc --noEmit` + full test suite (85/85 files, 1383/1383 tests pass)

**Spec Documentation**: [§5 Out-of-the-Box - Auto-Configuration](superpowers/specs/2026-05-17-self-evolving-cli-design.md#5f-auto-configuration)

---

### TASK-068: Level-Based Tool Hints and System Prompt Adaptation

**Status**: completed
**Priority**: P1
**Phase**: Phase 5
**预估工时**: 1d

**任务描述**:
- Imperative: Integrate level-based tool hints and system prompt adaptation into QueryEngine
- Present Continuous: Integrating level-based tool hints and system prompt adaptation into QueryEngine

**Dependencies**:
- `blockedBy`: [TASK-063, TASK-064]
- `blocks`: []

**Checklist**:
- [x] Modify `src/query/QueryEngine.ts`:
  - Load user profile at session start
  - Inject system prompt adaptation from `BehavioralAdapter` into streaming phase
  - After tool execution, append level-appropriate hints from `BehavioralAdapter`
- [x] Modify `src/main.ts`:
  - Add `/level beginner|intermediate|advanced` REPL command
  - Show current level on `/status`
- [x] Modify `src/bootstrap/config.ts`:
  - Add `userLevel` field to config schema
  - Default to `beginner`
- [x] Write `test/query/level-adaptation.test.ts` covering:
  - Beginner gets tool descriptions in system prompt
  - Intermediate gets tool names only
  - Advanced gets minimal prompt
  - `/level` command changes level
  - Level persists across sessions
  - Tool hints appear for beginner after every tool
  - Tool hints appear for intermediate only after errors
  - No tool hints for advanced
- [x] Run `tsc --noEmit` + full test suite

**Spec Documentation**: [§5 Out-of-the-Box - Tool Hints + System Prompt Adaptation](superpowers/specs/2026-05-17-self-evolving-cli-design.md#5b-tool-hint-system-level-based)

---

## 状态追踪

| Status | Count | Tasks |
|--------|-------|-------|
| ✅ completed | 19 | TASK-050, TASK-051, TASK-052, TASK-053, TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-059, TASK-060, TASK-061, TASK-062, TASK-063, TASK-064, TASK-065, TASK-066, TASK-067, TASK-068 |
| 🔄 in_progress | 0 | — |
| ⏳ pending | 0 | — |
| 🚫 blocked | 0 | — |

**总预估工时**: ~28 天（5.5 周）

---

## 优先级排序

| 优先级 | 任务 | 理由 |
|--------|------|------|
| **P0** | TASK-050, 051, 052, 053, 054, 055 | 自愈核心 + 记忆系统基础，所有后续任务的前置依赖 |
| **P1** | TASK-056, 057, 058, 059, 060, 061, 062, 066, 067, 068 | 记忆增强 + 可观测性 + 开箱即用体验 |
| **P2** | TASK-063, 064, 065 | 行为自适应，依赖可观测性基础设施 |

---

## 文件清单

### 新建文件 (8)

| 文件 | 用途 | Phase | 对应任务 |
|------|------|-------|----------|
| `src/services/circuitBreaker.ts` | 熔断器 | 1 | TASK-051 |
| `src/services/stateValidator.ts` | 状态校验器 | 1 | TASK-052 |
| `src/services/healthCheck.ts` | 健康检查 | 3 | TASK-060 |
| `src/services/sessionMetrics.ts` | 会话指标 | 3 | TASK-062 |
| `src/services/userProfile.ts` | 用户画像 | 4 | TASK-063 |
| `src/services/behavioralAdapter.ts` | 行为适配器 | 4 | TASK-064 |
| `src/services/paramTuner.ts` | 参数调优 | 4 | TASK-065 |
| `src/services/firstRun.ts` | 首次运行 | 5 | TASK-066 |

### 修改文件 (10)

| 文件 | 变更 | Phase | 对应任务 |
|------|------|-------|----------|
| `src/services/error-classifier.ts` | HTTP 状态码、Retry-After、重置修复 | 1 | TASK-050 |
| `src/query/QueryEngine.ts` | 熔断器集成、状态校验、锚点保护、重试扩展 | 1, 3 | TASK-054, 059, 068 |
| `src/executors/toolExecutor.ts` | 超时修复、瞬态错误重试 | 1, 3 | TASK-053, 059 |
| `src/memory/integration.ts` | 接入提取、去重 | 2 | TASK-055 |
| `src/services/memoryConsolidation.ts` | 实现合并逻辑 | 2 | TASK-055 |
| `src/services/consolidationScheduler.ts` | 实现会话门控 | 2 | TASK-055 |
| `src/services/memoryExtraction.ts` | LLM 提取、置信度、去重 | 2 | TASK-056 |
| `src/memory/relevanceSearch.ts` | 自适应评分、阈值修复 | 2 | TASK-057 |
| `src/bootstrap/config.ts` | 新增 userLevel、tunedParams 配置 | 4, 5 | TASK-065, 068 |
| `src/main.ts` | 首次运行检查、/level 命令、自动配置 | 5 | TASK-066, 067, 068 |
