# KC-CLI Benchmark Optimization Spec

**Date**: 2026-06-29
**Status**: Design Approved
**Scope**: Top-3 high-impact items from SWE-bench / DeepSWE evaluation

## Evaluation Baseline

| Benchmark | Instances | Solved | Avg Duration | Avg Turns | Key Failure Mode |
|-----------|-----------|--------|-------------|-----------|-----------------|
| SWE-bench astropy | 10 | 100% | 234.7s | 24.5 | — |
| DeepSWE v5 | 21 | 61.9% | 1025s | 73.8 | model_no_patch (6) |
| DeepSWE v3 | 113 | 53.1% | 901s | 72 | model_no_patch (44) |

### Root Causes Triaged

1. **No strategic planning** — agent reads files randomly, 7/10 SWE-bench instances consumed all 30 turns for 1-2 line fixes
2. **No patch guarantee** — 39% of DeepSWE v3 failures produced zero diff; agent exits without modifying anything
3. **Context window bloat** — 72-turn runs accumulate redundant file reads and dead-end attempts with no pruning

---

## Area 1: Strategic Planning Phase

### Problem

Agent enters the main loop and immediately starts reading random files. On SWE-bench
astropy, 7/10 instances burned all 30 turns on bugs that required 1-2 line changes.
No structured approach to understanding the problem before making edits.

### Design

Add a `planning` state to the QueryEngine state machine between `idle` and `streaming`.

```
idle → planning → compacting → streaming → deciding → executing → (loop)
```

#### New Sub-Module: `src/query/QueryEnginePlanning.ts`

```typescript
class PlanningPhaseHandler {
  /** Inject specialized planning system prompt. */
  getPlanningPrompt(): string;

  /** Tool allowlist for planning — grep/glob/read/bash OK, write/edit blocked. */
  isToolAllowed(toolName: string): boolean;

  /** After each planning turn, check if agent signals completion. */
  evaluatePlanningComplete(lastMessage: AssistantMessage): boolean;

  /** Extract structured findings for the main execution phase. */
  getPlanningFindings(messages: Message[]): PlanningFinding[];
}

interface PlanningFinding {
  hypothesis: string;
  relevantFiles: string[];
  testErrorSummary?: string;
  confidence: 'low' | 'medium' | 'high';
}
```

#### Planning-Phase Guard Prompt

> "PLANNING PHASE — do NOT edit any files yet. Your goal: understand the problem
> thoroughly before making changes.
> 1. Run the FAIL_TO_PASS tests — capture exact error messages
> 2. Use grep/glob to locate the specific code sections referenced in errors
> 3. Read ONLY the relevant code sections (not entire files)
> 4. Form a hypothesis about the root cause and what the fix should look like
> 5. Signal readiness by describing your plan — the system will unlock edit tools."

#### Tool Restrictions During Planning

| Tool Category | Allowed |
|---------------|---------|
| grep, glob, read, lsp | Yes |
| bash (test execution only) | Yes |
| write, edit | **Blocked** — returns "Edit tools locked during planning phase" |
| git commit | **Blocked** |

#### Config

```typescript
planningPhase?: {
  enabled: boolean;           // default true for benchmark runs
  maxTurns: number;           // default 3
  exemptFromBudget: boolean;  // default true — planning turns don't count
};
```

#### State Machine Transitions

- `idle → planning`: on first message submit (if planning enabled)
- `planning → planning`: agent makes a read/search turn within budget
- `planning → streaming`: agent signals plan complete OR planning budget exhausted
- `planning → error`: unrecoverable failure during planning

#### New Agent Events

- `agent:planning_started` — emitted on entry to planning state
- `agent:planning_turn` — emitted per planning turn
- `agent:planning_complete` — emitted with `PlanningFinding[]` on exit

### Files

| File | Change |
|------|--------|
| `src/query/QueryEngine.ts` | Add `planning` to main loop, wire handler, inject guard prompt |
| `src/query/QueryEnginePlanning.ts` | **New** — PlanningPhaseHandler class |
| `src/state/machine.ts` | Add `planning` state, valid transitions, validation |
| `src/state/types.ts` | Add `planning_started`, `planning_turn`, `planning_complete` events |
| `src/query/protocol.ts` | Add `PlanningFinding`, `PlanningPhaseConfig` types |
| `src/tools/toolExecutor.ts` | Add planning-phase tool filter |

### Testing

- Unit: PlanningPhaseHandler blocks write/edit tool calls, allows read/grep
- Unit: PlanningPhaseHandler detects plan-complete signal from agent message
- Unit: State machine validates planning → streaming transition legality
- Integration: Same SWE-bench instance, planning on vs off; assert planning-on uses fewer total turns
- Integration: Assert no files modified during planning phase

---

## Area 2: Patch Guarantee Mechanism

### Problem

44/113 DeepSWE v3 instances (39%) failed with `model_no_patch` — the agent completed
its run but produced zero git diff. No existing mechanism prevents exit when no
changes have been made or verifies that changes actually pass the target tests.

### Design

Two-part mechanism: (B1) Zero-Patch Exit Gate prevents exit with no modifications;
(B2) Pre-Exit Verification runs FAIL_TO_PASS tests before allowing completion.

#### B1: Zero-Patch Exit Gate

Enhanced `decidingPhase()` logic:

```
Modified decidingPhase flow:
  if hasToolCalls → executing (normal)
  if !hasToolCalls:
    ├─ modifiedFiles.size == 0 AND retries remain → steer + force continue
    ├─ modifiedFiles.size == 0 AND retries exhausted → emit agent:error (model_no_patch)
    └─ modifiedFiles.size > 0 → proceed to B2 verification
```

Steer message injected on zero-patch detection:

> "PATCH REQUIRED. You are about to exit but have modified ZERO files.
> Before giving up: (1) Run the FAIL_TO_PASS tests — what exact error do they show?
> (2) Did you read the source files related to that error?
> (3) Form a specific hypothesis and make at least one edit.
> You have N more retry attempts before this session is marked as failed."

#### B2: Pre-Exit Test Verification

Before allowing natural exit (agent has no more tool calls AND has modifications):

```typescript
interface VerificationResult {
  canExit: boolean;
  reason: 'tests_pass' | 'tests_fail' | 'tests_not_found' | 'timeout';
  failures?: string[];   // failing test names + output
}

async verifyBeforeExit(): Promise<VerificationResult> {
  // 1. Identify FAIL_TO_PASS tests from instance metadata
  // 2. Execute each test in the sandbox (timeout: 60s)
  // 3. Parse results
  // 4. If all pass → canExit=true
  // 5. If any fail → feed failure output to agent via steer, canExit=false
}
```

Verification result steer message:

> "VERIFICATION: N/M tests still fail. Failing tests:
> ```
> test_foo.py::test_bar - AssertionError: expected X got Y
> ```
> Please fix these before exiting. You have used K verification attempts."

#### Error Code

New `KCError` variant: `model_no_patch` (ErrorCode — extends existing enum in `src/utils/error.ts`).

#### Config

```typescript
patchGuarantee?: {
  enabled: boolean;             // default true for benchmarks
  maxZeroPatchRetries: number;  // default 3
  maxVerificationRetries: number; // default 2
  verificationTimeout: number;  // default 60s
  testCommand: string;          // default "pytest {test_names} -x"
};
```

### Files

| File | Change |
|------|--------|
| `src/query/QueryEngine.ts` | Add `patchRetries`, `verificationRetries`, `verifyBeforeExit()`, gate logic in `decidingPhase` |
| `src/query/QueryEngineError.ts` | Add error handling for `model_no_patch` |
| `src/utils/error.ts` | Add `model_no_patch` to ErrorCode enum |
| `src/utils/git.ts` | Add `getModifiedFiles(): string[]` |
| `src/services/sandboxManager.ts` | Add `runTests(testNames: string[], timeout: number): TestResult` |

### Testing

- Unit: `modifiedFiles.size === 0`, retries < max → assert steer message emitted, `true` returned
- Unit: `modifiedFiles.size === 0`, retries exhausted → assert error event yielded
- Unit: `verifyBeforeExit()` with mock test runner, all passing → assert `{ canExit: true }`
- Unit: `verifyBeforeExit()` with mock test runner, some failing → assert steer contains failure output
- Integration: Full 10-minute run with intentionally broken test, verify gate triggers and agent attempts fix
- Integration: Run that produces patch but fails tests → verify retry loop works with max 2 verification attempts

---

## Area 3: Context Window Efficiency

### Problem

72-turn average runs accumulate massive context. Agents re-read unchanged files,
dead-end attempts are kept in full, and compaction treats all messages uniformly.
Estimated 30-50% of context tokens are wasted on redundant or low-value content.

### Design

Two-part solution: (C1) Importance-based turn tagging for smart compaction;
(C2) File-read content dedup cache.

#### C1: Importance Tagging

Each turn in the conversation buffer gets tagged:

```typescript
type TurnImportance = 'key_finding' | 'exploration' | 'failed_attempt';

interface TurnTag {
  importance: TurnImportance;
  keywords: string[];
  filePaths: string[];
  testOutput?: string;
  applied: boolean;     // was an edit made this turn?
}
```

**Auto-tagging heuristics** (applied in main loop after each turn):

| Pattern Match | Tag | Reasoning |
|---------------|-----|-----------|
| Output contains `Error:`, `FAILED`, `AssertionError`, `Traceback` | `key_finding` | Diagnostic data essential for fix |
| Tool calls include `write` or `edit` | `exploration` | Code change — keep for coherence |
| Tool calls include `read`/`grep`/`glob` (first time) | `exploration` | Keep summary, not full content |
| Agent says "let me revert", "that didn't work", "wrong approach" | `failed_attempt` | Dead end |
| Same file re-read within 3 turns with no intervening edit | `failed_attempt` | Pure redundancy |
| Default (no match) | `exploration` | Safe default |

**Compaction behavior by importance**:

```
key_finding:    NEVER compact — preserve full content always
exploration:    compact to summary after 10 turns of age
failed_attempt: compact to 1-line marker after 3 turns
                ("[Turn N: attempted X on file Y, reverted. No lasting effect.]")
```

**Enhanced `CompactionHandler.selectStrategy()`**:

```typescript
selectStrategy(messages: MessageWithTag[]): CompactionAction {
  // Phase 1: Prune failed attempts (low-hanging fruit)
  const staleFails = messages.filter(m =>
    m.tag.importance === 'failed_attempt' && m.age > 3
  );
  if (staleFails.length > 0) {
    return { type: 'prune_failed', targets: staleFails };
  }

  // Phase 2: Compact old exploration
  const oldExploration = messages.filter(m =>
    m.tag.importance === 'exploration' && m.age > 10
  );
  if (oldExploration.length > 0 && wouldExceedWindow(messages)) {
    return { type: 'compact_exploration', targets: oldExploration };
  }

  // Phase 3: Fall through to existing tiered logic
  // (CachedMicro → Snip → Full → Force) but key_findings excluded
  return this.selectTieredStrategy(
    messages.filter(m => m.tag.importance !== 'key_finding')
  );
}
```

#### C2: File-Read Dedup Cache

```typescript
// src/services/cache/FileContentCache.ts — New file
class FileContentCache {
  private cache = new Map<string, { hash: string; turnIndex: number }>();
  private currentTurn = 0;

  setTurn(turn: number): void;
  check(filePath: string, content: string): 'fresh' | { cachedSince: number };
  invalidate(filePath: string): void;  // call after write/edit succeeds
  invalidateAll(): void;               // reset between sessions
}
```

**Integration point**: In the read/grep tool response handling within the main loop.
Before appending read output to the message buffer:

```typescript
const cacheResult = fileContentCache.check(filePath, content);
if (cacheResult !== 'fresh') {
  // Insert short note instead of full content
  return `[File unchanged since turn ${cacheResult.cachedSince}: ${filePath}]`;
}
// Cache miss — store hash + add full content
```

Invalidation: When write/edit tool succeeds, call `fileContentCache.invalidate(filePath)`.

Expected token savings: 20-40% on runs with 50+ turns (agent tendencies to re-read files).

### Config

```typescript
contextEfficiency?: {
  enabled: boolean;              // default true
  importanceTagging: boolean;    // default true
  dedupCache: boolean;           // default true
  dedupCacheSize: number;        // default 500 entries
  failedAttemptMaxAge: number;   // default 3 turns before pruning
  explorationMaxAge: number;     // default 10 turns before compacting
};
```

### Files

| File | Change |
|------|--------|
| `src/query/protocol.ts` | Add `TurnImportance`, `TurnTag`, `MessageWithTag`, `ContextEfficiencyConfig` |
| `src/query/QueryEngine.ts` | Auto-tag turns in main loop, wire FileContentCache into read tool processing |
| `src/query/QueryEngineCompaction.ts` | Enhance `selectStrategy()` with importance-aware pruning |
| `src/query/QueryEngineState.ts` | Extend message storage to carry `TurnTag` metadata |
| `src/services/cache/FileContentCache.ts` | **New** — content-hash LRU cache with invalidation |
| `src/utils/tokenEstimation.ts` | Add helper for estimating compaction savings |

### Testing

- Unit: Each tagging heuristic — feed matching patterns, assert correct `TurnImportance`
- Unit: FileContentCache — write+check same content → `cachedSince`; write+check different → `fresh`
- Unit: Compaction with key_findings present → assert key_findings survive when exploration is snipped
- Unit: Compaction with stale failed_attempts → assert they get pruned first
- Integration: 20-turn simulated session, verify dedup cache reduces total token count by 20%+
- Integration: Verify key_findings (test failures) are never compacted regardless of age

---

## Implementation Order & Dependencies

```
Phase 1: Foundation (no dependencies)
  ├── Add shared types to protocol.ts (PlanningFinding, TurnTag, etc.)
  ├── Add model_no_patch to ErrorCode enum
  └── Add getModifiedFiles() to git utils

Phase 2: Area 3 — Context Efficiency (depends on Phase 1 types)
  ├── FileContentCache (standalone, no other deps)
  ├── Turn tagging heuristics in main loop
  └── Enhanced CompactionHandler

Phase 3: Area 1 — Planning Phase (depends on Phase 1 types + state machine)
  ├── QueryEnginePlanning handler
  ├── State machine planning transitions
  └── Tool filter for planning phase

Phase 4: Area 2 — Patch Guarantee (depends on Phase 1 types + Phase 3 for test exec)
  ├── Zero-patch detection gate
  ├── verifyBeforeExit test execution
  └── Steer message templates
```

## Verification & Validation Plan

### Before/After Benchmark Comparison

Run DeepSWE v3 small subset (20 instances) with:
1. **Baseline**: Current code (no optimizations)
2. **Full opt**: All three areas enabled

Compare on: solve rate, avg turns, avg duration, model_no_patch rate, context token usage.

### Success Criteria

| Metric | Current Baseline | Target | Measurement |
|--------|-----------------|--------|-------------|
| Solve rate (20-inst subset) | ~53% | >65% | DeepSWE evaluation |
| Avg turns | ~72 | <50 | Per-instance turn counter |
| model_no_patch rate | ~39% | <15% | Error classification |
| Context token usage | N/A (not measured) | -20% vs baseline | New metrics tracking |
| Planning phase errors | N/A | 0 | Agent event log |

### Regression Tests

- Existing vitest suite must pass (typecheck + test:coverage)
- Sandbox e2e tests must still pass
- Multi-agent orchestrator tests must not break

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Planning phase increases total turns for simple bugs | Medium | Low | Config toggle; skip planning when problem is trivially small |
| FileContentCache false positive (stale cache after external change) | Low | High | Invalidate on every write/edit; use content hash not mtime |
| turn-tagging heuristics misclassify key_findings as exploration | Low | Medium | Conservative default: ambiguous → exploration; key_finding only on high-confidence matches |
| verifyBeforeExit test execution times out | Medium | Low | 60s timeout per test batch; timeout → skip verification, allow exit |
| State machine regression from new planning state | Low | High | Full state machine unit test coverage; validate all transitions |
