# Audit Remediation Round 2 — Specification

**Version**: 1.0.0
**Date**: 2026-07-16
**Source**: Follow-up audit of CODE_REVIEW_2026-07-06.md — 8 residual issues
**Status**: Draft

---

## 1. Issue Classification & Priority Matrix

| Level | Symbol | Criteria |
|-------|--------|----------|
| **P1-High** | 🟠 | Address in next sprint — security gap, missing enforcement, spec violation |
| **P2-Medium** | 🟡 | Important but not blocking — dead code, duplication, incomplete features |

### Summary Count

| Priority | Count | Categories |
|----------|-------|------------|
| P1-High | 4 | Security hardening (S2, S5), Architecture enforcement (A1, A2) |
| P2-Medium | 4 | Architecture cleanup (A3), Code quality (Q2, NEW-1, NEW-2) |

---

## 2. P1-High Fix Plans

---

### S2: Sandbox failIfNoSandbox Default — Fail-Closed Posture

**Severity**: High
**File**: `src/services/sandbox.ts:42-48, 120-138`
**Current Behavior**: `DEFAULT_OPTIONS` omits `failIfNoSandbox`, so it defaults to `undefined` (falsy). When no real sandbox backend (bubblewrap/seccomp/docker) is available, the system warns but degrades to `NoopSandbox`, running commands directly on the host.

**Root Cause**: The security-default posture is "warn and proceed" rather than "fail closed." A developer who installs the tool without reading sandbox prerequisites will unknowingly run all shell commands without isolation.

**Fix Plan**:

1. Add `failIfNoSandbox: true` to `DEFAULT_OPTIONS` (line 42), making "fail closed" the default.
2. Update the startup warning (lines 132-136) to include remediation instructions referencing the docs.
3. Update `README.md` to document sandbox prerequisites (bubblewrap/bwrap, seccomp, or docker) clearly.
4. Update `docs/guides/` sandbox guide to reflect the new default.

**Technical Implementation**:

```typescript
// sandbox.ts — DEFAULT_OPTIONS
const DEFAULT_OPTIONS: Omit<SandboxOptions, 'workDir' | 'policy'> = {
  enabled: true,
  backend: 'bubblewrap',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
  failIfNoSandbox: true,  // S2: default to fail-closed
};
```

**Backward Compatibility**: Users who previously relied on automatic noop fallback must explicitly set `failIfNoSandbox: false` in their config, or set `backend: 'noop'`. This is intentional — the old behavior was a security gap.

**Affected Files**:
- `src/services/sandbox.ts` — add `failIfNoSandbox` to DEFAULT_OPTIONS, enhance warning message
- `docs/guides/sandbox.md` or equivalent — document prerequisites
- `README.md` — update sandbox prerequisites section

---

### S5: Dangerous Command Detection — Add AST-Level Analysis

**Severity**: High
**File**: `src/permissions/readonlyCommands.ts:140-167`
**Current Behavior**: `isDangerousBashCommand()` uses multi-layer text-pattern analysis (whitespace normalization, sub-command splitting, keyword detection) but does NOT perform syntactic parsing. Variable expansion (`a=rm; $a -rf /`), function wrapping, and quoted obfuscation can still bypass detection.

**Root Cause**: Regex/keyword-based detection cannot distinguish between literal commands and strings/identifiers that happen to contain dangerous keywords. Without a parse tree, `echo "rm -rf /"` and `rm -rf /` look identical to keyword matching.

**Fix Plan**:

1. Integrate a lightweight shell lexer/parser (e.g., `bash-parser` or a Tree-sitter grammar via the existing LSP module) to produce a minimal AST.
2. Walk the AST to identify actual command invocations (not string literals, comments, or variable assignments).
3. Apply dangerous-command checks only to AST-verified command nodes.
4. Keep the existing `isDangerousBashCommand()` as a fast-path pre-filter: if it returns `false`, skip the AST parse. Only invoke the parser when the text-based filter flags a potential match (reducing perf impact).
5. Fall back to the text-based result if the parser fails (unparseable input), maintaining defense-in-depth.

**Technical Implementation**:

```typescript
// readonlyCommands.ts — new function
export function isDangerousBashCommandWithAST(command: string): boolean {
  // Fast path: text-based filter
  if (!isDangerousBashCommand(command)) return false;

  // Slow path: verify via AST
  try {
    const ast = parseShellCommand(command);
    return walkASTForDangerousCommands(ast);
  } catch {
    // Unparseable — fall back to text-based result (defense-in-depth)
    return true;
  }
}
```

**Affected Files**:
- `src/permissions/readonlyCommands.ts` — add AST-based verification
- `src/tools/BashTool/index.ts` — update call site if needed
- `test/permissions/dangerous-commands.test.ts` — new AST bypass test cases

---

### A1: Remove GlobalState Module-Level Singleton Fallback

**Severity**: High
**Files**: `src/bootstrap/state.ts:26, 49-64`
**Current Behavior**: `getState()` resolves via (1) AsyncLocalStorage scoped state, (2) DI container, (3) module-level `let state` singleton. The fallback at priority (3) means any code path NOT wrapped in `runWithScopedState()` still mutates a shared global object.

**Root Cause**: The module-level singleton exists as a backward-compatibility fallback. For true per-agent isolation, all state access must go through ALS or per-instance injection.

**Fix Plan**:

1. Remove the `let state: GlobalState | null = null` module-level variable.
2. Remove the fallback branch in `getState()` (lines 60-63).
3. Ensure every call site that invokes `getState()` is already within a `runWithScopedState()` context or has state injected directly.
4. For the REPL/main entry path, wrap the entire session in `runWithScopedState()` at bootstrap time.
5. For ACP sessions, ensure each session creates its own scoped state via `runWithScopedState()` (already partially done in ACP handlers).
6. Update `updateState()` to work exclusively on ALS-resolved state.

**Technical Implementation**:

```typescript
// state.ts — after fix
const scopedStateStorage = new AsyncLocalStorage<GlobalState>();

export function getState(): GlobalState {
  const scoped = scopedStateStorage.getStore();
  if (scoped) return scoped;

  const container = getServiceContainer();
  if (container.has('globalState')) {
    return container.resolve<GlobalState>('globalState');
  }

  throw new Error(
    'GlobalState not initialized. Call initializeState() and wrap with runWithScopedState().'
  );
}
```

**Affected Files**:
- `src/bootstrap/state.ts` — remove module-level singleton, remove fallback
- `src/bootstrap/init-sequence.ts` — wrap main path in `runWithScopedState()`
- `src/acp/handlers.ts` — verify scoped state wrapping (likely already done)
- `src/orchestrator/backends/in-process.ts` — verify sub-agent scoping
- `test/` — update tests that relied on module-level state

---

### A2: Fix DeployTool to Use ExecutionEnv Instead of Direct child_process

**Severity**: High
**File**: `src/tools/DeployTool/index.ts:7, 51`
**Current Behavior**: `DeployTool` imports `exec` from `child_process` directly (line 7) and calls `execAsync(command, ...)` at line 51, completely bypassing the `ExecutionEnv` abstraction. This means:
- Sandbox wrapping is not applied to deploy commands
- The tool cannot be tested with `MockShell`
- Security policies enforced through `ExecutionEnv` are skipped

**Root Cause**: DeployTool was likely written before the ExecutionEnv abstraction was enforced on other tools. It was missed in the A2 remediation pass.

**Fix Plan**:

1. Remove `import { exec } from 'child_process'` and `import { promisify } from 'util'` (lines 7, 10).
2. Remove `const execAsync = promisify(exec)` (line 12).
3. Use `context.env.shell.exec(command, options)` instead (matching BashTool pattern).
4. Verify that `DeployTool` receives `context.env` through the standard `createToolContext()` path.

**Technical Implementation**:

```typescript
// DeployTool/index.ts — fixed call site
const result = await context.env.shell.exec(command, {
  cwd: context.cwd,
  timeout: 600_000,
  maxBuffer: LARGE_MAX_BUFFER,
});
const stdout = result.stdout;
const stderr = result.stderr;
```

**Affected Files**:
- `src/tools/DeployTool/index.ts` — replace direct exec with env.shell.exec
- `test/tools/DeployTool.test.ts` — verify mock shell integration

---

## 3. P2-Medium Fix Plans

---

### A3: ServiceContainer — Enforce or Deprecate

**Severity**: Medium
**File**: `src/services/ServiceContainer.ts`
**Current Behavior**: The `ServiceContainer` class is functional and services ARE registered into it (5 call sites: `globalState`, `toolRegistry`, `logger`, `agpDynamicManager`, `agpGlobalRegistry`), but `.resolve()` is called in only 3 non-test locations (`CacheManager`, ACP handlers, `getState` fallback). The vast majority of the codebase uses direct `import` + module-level accessors.

**Root Cause**: The container was introduced as architectural intent but never fully adopted. This creates confusion: is the codebase DI-driven or not?

**Fix Plan** (Choose ONE path):

**Option A — Deprecate and remove** (recommended for this codebase, given the CLI single-process model):
1. Remove `ServiceContainer` class and `getServiceContainer()` function.
2. Replace container-based access in `CacheManager` with direct instantiation or module-level singleton (consistent with rest of codebase).
3. Replace container-based access in ACP handlers with direct `initializeState()` + `runWithScopedState()`.
4. Remove the container fallback from `getState()`.

**Option B — Enforce universally** (higher effort, only if multi-tenant server use cases are planned):
1. Make every major subsystem (QueryEngine, ToolExecutor, Orchestrator) accept dependencies via constructor injection.
2. Create a `Bootstrap.compose()`-style assembly that wires everything through the container.
3. Add lint rules to ban direct imports of injectable services.

**Recommendation**: Option A. The codebase is a single-user CLI tool. The ACP server path already handles per-session isolation via `runWithScopedState()`. A full DI framework adds complexity without proportional benefit. The `Bootstrap` class already serves as the composition root.

**Affected Files (Option A)**:
- `src/services/ServiceContainer.ts` — delete
- `src/bootstrap/state.ts` — remove container registration/resolution
- `src/services/cache/CacheManager.ts` — replace `resolveService('cacheManager')` with direct singleton
- `src/acp/handlers.ts` — replace container.resolve with direct state initialization
- `src/services/logger.ts` — remove container registration
- `src/tools.ts` — remove container registration
- `src/agp/dynamic-manager.ts` — remove container registration
- `src/agp/registry.ts` — remove container registration

---

### Q2: Rename Duplicate cacheMetrics Files

**Severity**: Medium
**Files**: `src/metrics/cacheMetrics.ts`, `src/services/cacheMetrics.ts`
**Current Behavior**: Two files share the name `cacheMetrics.ts` but serve entirely different purposes:
- `src/metrics/cacheMetrics.ts` — `CacheMetricsCollector` for internal KV cache hit/miss tracking
- `src/services/cacheMetrics.ts` — `PromptCacheMetrics` for LLM prompt caching metrics

While the exported class names differ, same-named files cause IDE confusion and import ambiguity.

**Fix Plan**:

1. Rename `src/metrics/cacheMetrics.ts` → `src/metrics/kvCacheMetrics.ts`
2. Rename `src/services/cacheMetrics.ts` → `src/services/promptCacheMetrics.ts`
3. Update all import paths referencing either file.
4. Add a lint rule (if feasible) to flag duplicate filenames within `src/`.

**Affected Files**:
- `src/metrics/cacheMetrics.ts` → rename to `kvCacheMetrics.ts`
- `src/services/cacheMetrics.ts` → rename to `promptCacheMetrics.ts`
- All files importing from these two modules (estimate: 3-5 files each)

---

### NEW-1: QueryEngineCompaction — Surface Compaction Errors

**Severity**: Medium
**File**: `src/query/QueryEngineCompaction.ts:265`
**Current Behavior**: `.catch(() => { this.pendingCompactDone = true; })` silently swallows all compaction errors. If the async compaction LLM call fails (API error, timeout, budget exceeded), there is no log, no telemetry, and no user-visible indication. The conversation silently continues without compaction.

**Fix Plan**:

1. Replace the empty catch with `logger.query.error()` for observability.
2. Store the error for potential surfacing via `drainPendingCompactResult()`.
3. Optionally emit a metric for monitoring compaction failure rates.

**Technical Implementation**:

```typescript
// QueryEngineCompaction.ts:265
.catch((err) => {
  this.pendingCompactError = getErrorMessage(err);
  this.pendingCompactDone = true;
  logger.query.error('[compaction] Async full compaction failed', { error: getErrorMessage(err) });
});
```

**Affected Files**:
- `src/query/QueryEngineCompaction.ts` — add error logging and storage

---

### NEW-2: MCP HTTP Transport — Log Stream Cancel Errors

**Severity**: Low-Medium
**File**: `src/mcp/transports/http.ts:159`
**Current Behavior**: `.catch(() => { /* ignore cancel errors */ })` silently swallows stream cancellation errors from `response.body?.cancel()`. While cancel errors are expected and non-critical, a complete lack of logging means we lose visibility into transport-layer issues.

**Fix Plan**:

1. Log the error at `debug` level (not `error`, since cancel errors are expected).
2. Only suppress `AbortError` / cancellation-type errors; log anything unexpected at `warn` level.

**Technical Implementation**:

```typescript
// http.ts:159
await response.body?.cancel().catch((err) => {
  if (err instanceof Error && err.name === 'AbortError') {
    logger.mcp.debug('[MCP SSE] Stream cancel (expected)', { error: err.message });
  } else {
    logger.mcp.warn('[MCP SSE] Unexpected error during stream cancel', {
      error: getErrorMessage(err),
    });
  }
});
```

**Affected Files**:
- `src/mcp/transports/http.ts` — add conditional error logging

---

## 4. Verification & Test Plan

### Per-Issue Verification

| Issue | Verification Method |
|-------|-------------------|
| S2 | Unit test: `failIfNoSandbox` default is `true`. Integration: run on system without bubblewrap → expect hard error. |
| S5 | Unit tests: new obfuscation vectors (variable expansion, function wrapping, quoted keywords) confirmed blocked by AST pass but not by text-only pass. |
| A1 | Unit test: call `getState()` without `runWithScopedState()` → throws. Grep for module-level `let state` → absent. |
| A2 | Grep: `from 'child_process'` in `src/tools/` → only BashTool (expected, via ExecutionEnv), Sandbox. Unit test: DeployTool uses `MockShell`. |
| A3 | Grep: `ServiceContainer` → absent or `getServiceContainer` → absent (if Option A). |
| Q2 | Grep: `cacheMetrics.ts` → exactly 0 files with that name in `src/`. Import paths updated. |
| NEW-1 | Unit test: mock LLM failure in compaction → verify `logger.query.error` called. |
| NEW-2 | Unit test: simulate AbortError → `logger.mcp.debug` called. Simulate other error → `logger.mcp.warn` called. |

### Regression Gates

- `npm run typecheck` — 0 errors
- `npm test` — full suite passes (existing + new tests)
- `npm run test:coverage` — thresholds maintained (lines 60%, branches 50%, functions 60%, statements 60%)
- Manual smoke test: REPL session with `failIfNoSandbox: true` on a system without sandbox → clear error message

---

## 5. Implementation Progress Tracking

| Issue | Priority | Status | Assignee | PR |
|-------|----------|--------|----------|-----|
| S2 | P1 | pending | — | — |
| S5 | P1 | pending | — | — |
| A1 | P1 | pending | — | — |
| A2 | P1 | pending | — | — |
| A3 | P2 | pending | — | — |
| Q2 | P2 | pending | — | — |
| NEW-1 | P2 | pending | — | — |
| NEW-2 | P2 | pending | — | — |
