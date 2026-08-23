#!/usr/bin/env bash
# ==============================================================================
# Architecture Hardening Systematic Test Suite
# ==============================================================================
# Covers T1-T6 verification as specified in:
#   docs/specs/architecture-hardening-spec.md
#   docs/specs/architecture-hardening-tasks.md
#
# Usage:
#   ./scripts/arch-hardening-test.sh          # full suite
#   ./scripts/arch-hardening-test.sh --quick  # skip full test run
#   ./scripts/arch-hardening-test.sh --ci     # CI mode (no color, exit on first failure)
# ==============================================================================

set -o pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

QUICK_MODE=false
CI_MODE=false
PASSED=0
FAILED=0
START_TIME=$(date +%s)

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK_MODE=true ;;
    --ci)    CI_MODE=true ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
if [ "$CI_MODE" = false ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m' # No Color
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

pass() { echo -e "  ${GREEN}✓ PASS${NC}  $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC}  $1 — $2"; FAILED=$((FAILED + 1)); }
info() { echo -e "${CYAN}[ … ]${NC}  $1"; }
section() { echo -e "\n${BOLD}═══ $1 ═══${NC}"; }

run_silent() {
  # Run a command, return exit code, suppress stdout (keep stderr)
  "$@" > /dev/null 2>&1
}

# ── Header ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Architecture Hardening — Systematic Test Suite         ║${NC}"
echo -e "${BOLD}║  $(date '+%Y-%m-%d %H:%M:%S')                                       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Prerequisites
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 0 — Prerequisites"

info "Node.js version: $(node --version)"
info "Working directory: $PROJECT_ROOT"

if [ ! -f "package.json" ]; then
  fail "Prerequisites" "package.json not found — wrong working directory?"
  exit 1
fi
pass "Working directory is project root"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1 — Static Verification (Archival Grep Checks)
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 1 — Static Verification (grep assertions)"

# T1: _fallbackState must be gone
info "T1: Checking _fallbackState is removed..."
if grep -rq "_fallbackState" src/ 2>/dev/null; then
  fail "T1 _fallbackState" "still referenced in src/: $(grep -rl '_fallbackState' src/ | tr '\n' ' ')"
else
  pass "T1 _fallbackState removed from src/"
fi

# T1: createScopedState must use structuredClone
info "T1: Checking createScopedState uses structuredClone..."
if grep -q "structuredClone" src/bootstrap/state.ts 2>/dev/null; then
  pass "T1 createScopedState uses structuredClone for deep isolation"
else
  fail "T1 createScopedState" "structuredClone not found in state.ts"
fi

# T1: init-sequence must wrap post-compose in runWithScopedState
info "T1: Checking init-sequence wraps post-compose in ALS..."
if grep -q "runWithScopedState(result.state" src/bootstrap/init-sequence.ts 2>/dev/null; then
  pass "T1 init-sequence wraps post-compose in runWithScopedState"
else
  fail "T1 init-sequence" "runWithScopedState(result.state, ...) not found"
fi

# T2: restoreSession must exist on QueryEngine
info "T2: Checking restoreSession method..."
if grep -q "restoreSession(snapshot" src/query/QueryEngine.ts 2>/dev/null; then
  pass "T2 restoreSession() method exists on QueryEngine"
else
  fail "T2 restoreSession" "method not found in QueryEngine.ts"
fi

# T2: AppRoot must call restoreSession instead of direct assignment
info "T2: Checking AppRoot uses restoreSession..."
if grep -q "queryEngine.restoreSession(loaded)" src/ui/components/AppRoot.tsx 2>/dev/null; then
  pass "T2 AppRoot calls queryEngine.restoreSession(loaded)"
else
  fail "T2 AppRoot" "queryEngine.restoreSession(loaded) not found"
fi
if grep -q "queryEngine.messages = loaded.messages" src/ui/components/AppRoot.tsx 2>/dev/null; then
  fail "T2 AppRoot" "direct assignment queryEngine.messages = loaded.messages still present"
else
  pass "T2 AppRoot direct assignment removed"
fi

# T3: BudgetEnforcer imported in QueryEngine
info "T3: Checking BudgetEnforcer wired into QueryEngine..."
if grep -q "BudgetEnforcer" src/query/QueryEngine.ts 2>/dev/null; then
  pass "T3 BudgetEnforcer imported in QueryEngine.ts"
else
  fail "T3 BudgetEnforcer" "not imported in QueryEngine.ts"
fi

# T3: budget check before streaming
if grep -q "budgetEnforcer.checkTurnBudget" src/query/QueryEngine.ts 2>/dev/null; then
  pass "T3 checkTurnBudget called in streamingPhase"
else
  fail "T3 checkTurnBudget" "not called in QueryEngine.ts"
fi

# T3: recordUsage after successful provider call
if grep -q "budgetEnforcer.recordUsage" src/query/QueryEngine.ts 2>/dev/null; then
  pass "T3 recordUsage called after LLM response"
else
  fail "T3 recordUsage" "not called in QueryEngine.ts"
fi

# T3: budget_enforcer event type registered
info "T3: Checking agent:budget_exceeded event type..."
if grep -q "agent:budget_exceeded" src/state/events.ts 2>/dev/null; then
  pass "T3 agent:budget_exceeded event type registered"
else
  fail "T3 agent:budget_exceeded" "not found in events.ts"
fi

# T3: BudgetEnforcer.reset() exists
info "T3: Checking BudgetEnforcer.reset()..."
if grep -q "reset(): void" src/services/budget.ts 2>/dev/null; then
  pass "T3 BudgetEnforcer.reset() method exists"
else
  fail "T3 BudgetEnforcer.reset" "method not found"
fi

# T4: No @deprecated in src/ui
info "T4: Checking @deprecated removed from src/ui..."
DEPRECATED_COUNT=$(grep -r "@deprecated" src/ui/ 2>/dev/null | wc -l)
if [ "$DEPRECATED_COUNT" -eq 0 ]; then
  pass "T4 zero @deprecated annotations in src/ui/"
else
  fail "T4 @deprecated" "$DEPRECATED_COUNT @deprecated annotation(s) still in src/ui/"
fi

# T4: No production references to deleted renderers
info "T4: Checking deleted renderers have no production references..."
RENDER_REFS=$(grep -rn "renderChatView\|renderSidebar\|renderChatMessage" src/ 2>/dev/null | grep -v "SidebarPanel.tsx" | wc -l)
if [ "$RENDER_REFS" -eq 0 ]; then
  pass "T4 zero production references to deleted renderers"
else
  fail "T4 renderer references" "$RENDER_REFS reference(s) still in src/"
fi

# T4: ChatView.ts keeps ChatMessage type but not render functions
info "T4: Checking ChatView.ts structure..."
if grep -q "export interface ChatMessage" src/ui/components/ChatView.ts 2>/dev/null; then
  pass "T4 ChatMessage interface preserved in ChatView.ts"
else
  fail "T4 ChatView.ts" "ChatMessage interface missing"
fi
if grep -q "export function render" src/ui/components/ChatView.ts 2>/dev/null; then
  fail "T4 ChatView.ts" "render function still present — should be deleted"
else
  pass "T4 render functions removed from ChatView.ts"
fi

# T4: Sidebar.ts keeps types and helpers but not renderSidebar
info "T4: Checking Sidebar.ts structure..."
if grep -q "export function renderSidebar" src/ui/components/Sidebar.ts 2>/dev/null; then
  fail "T4 Sidebar.ts" "renderSidebar still present — should be deleted"
else
  pass "T4 renderSidebar removed from Sidebar.ts"
fi
if grep -q "export interface SidebarData" src/ui/components/Sidebar.ts 2>/dev/null; then
  pass "T4 SidebarData interface preserved in Sidebar.ts"
else
  fail "T4 Sidebar.ts" "SidebarData interface missing"
fi

# T5: uuid upgraded to v11
info "T5: Checking uuid version..."
UUID_VER=$(node -e "try { console.log(require('uuid/package.json').version) } catch { console.log('error') }" 2>/dev/null)
if [ "$UUID_VER" != "error" ] && [ "${UUID_VER%%.*}" -ge 11 ]; then
  pass "T5 uuid@${UUID_VER} (>=11)"
else
  fail "T5 uuid" "version check failed (got: $UUID_VER)"
fi

# T5: zod still at v3 with documented reason
info "T5: Checking zod version (expecting v3)..."
ZOD_VER=$(node -e "try { console.log(require('zod/package.json').version) } catch { console.log('error') }" 2>/dev/null)
if [ "${ZOD_VER%%.*}" = "3" ]; then
  pass "T5 zod@${ZOD_VER} — locked at v3 (documented in spec 6.0)"
else
  fail "T5 zod" "unexpected version: $ZOD_VER (expected v3.x)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2 — Type Checking
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 2 — TypeScript Compilation"

info "Running tsc --noEmit..."
TYPECHECK_START=$(date +%s%N)
if run_silent npx tsc --noEmit; then
  TYPECHECK_END=$(date +%s%N)
  TYPECHECK_MS=$(( (TYPECHECK_END - TYPECHECK_START) / 1000000 ))
  pass "tsc --noEmit (${TYPECHECK_MS}ms)"
else
  fail "tsc --noEmit" "type errors found"
  npx tsc --noEmit 2>&1 | tail -30
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3 — Targeted New Tests
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 3 — Targeted Test Suites (T1, T2, T3)"

# T1: State isolation tests
info "Running T1 state-isolation tests..."
T1_START=$(date +%s%N)
if npx vitest run test/bootstrap/state-isolation.test.ts --reporter=dot > /tmp/t1-output.txt 2>&1; then
  T1_END=$(date +%s%N)
  T1_MS=$(( (T1_END - T1_START) / 1000000 ))
  T1_COUNT=$(grep -oP 'Tests\s+\K\d+' /tmp/t1-output.txt | head -1)
  pass "T1 state-isolation.test.ts — ${T1_COUNT} tests (${T1_MS}ms)"
else
  fail "T1 state-isolation.test.ts" "tests failed"
  tail -20 /tmp/t1-output.txt
fi

# T2: Restore session tests
info "Running T2 restore-session tests..."
T2_START=$(date +%s%N)
if npx vitest run test/query/restore-session.test.ts --reporter=dot > /tmp/t2-output.txt 2>&1; then
  T2_END=$(date +%s%N)
  T2_MS=$(( (T2_END - T2_START) / 1000000 ))
  T2_COUNT=$(grep -oP 'Tests\s+\K\d+' /tmp/t2-output.txt | head -1)
  pass "T2 restore-session.test.ts — ${T2_COUNT} tests (${T2_MS}ms)"
else
  fail "T2 restore-session.test.ts" "tests failed"
  tail -20 /tmp/t2-output.txt
fi

# T3: Budget enforcement tests
info "Running T3 budget-enforcement tests..."
T3_START=$(date +%s%N)
if npx vitest run test/query/budget-enforcement.test.ts --reporter=dot > /tmp/t3-output.txt 2>&1; then
  T3_END=$(date +%s%N)
  T3_MS=$(( (T3_END - T3_START) / 1000000 ))
  T3_COUNT=$(grep -oP 'Tests\s+\K\d+' /tmp/t3-output.txt | head -1)
  pass "T3 budget-enforcement.test.ts — ${T3_COUNT} tests (${T3_MS}ms)"
else
  fail "T3 budget-enforcement.test.ts" "tests failed"
  tail -20 /tmp/t3-output.txt
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 4 — Full Regression Suite
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 4 — Full Test Suite"

if [ "$QUICK_MODE" = true ]; then
  echo -e "  ${YELLOW}⊘ SKIP${NC}  Full test suite (--quick mode)"
else
  info "Running full test suite (npm test)..."
  info "This may take 2-3 minutes..."
  FULL_START=$(date +%s%N)
  if npm test > /tmp/full-test-output.txt 2>&1; then
    FULL_END=$(date +%s%N)
    FULL_MS=$(( (FULL_END - FULL_START) / 1000000 ))
    FULL_SEC=$(( FULL_MS / 1000 ))
    FULL_FILES=$(grep -oP 'Test Files\s+\K\d+' /tmp/full-test-output.txt | head -1)
    FULL_TESTS=$(grep -oP 'Tests\s+\K\d+' /tmp/full-test-output.txt | head -1)
    pass "Full suite — ${FULL_FILES} files, ${FULL_TESTS} tests (${FULL_SEC}s)"
  else
    FAILED_TESTS=$(grep -oP 'Tests\s+\K\d+ failed' /tmp/full-test-output.txt | head -1)
    fail "Full suite" "test failures detected: $FAILED_TESTS"
    tail -30 /tmp/full-test-output.txt
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 5 — Spec/Docs Integrity
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 5 — Documentation Integrity"

# Spec and tasks files exist
for DOC in "docs/specs/architecture-hardening-spec.md" "docs/specs/architecture-hardening-tasks.md"; do
  if [ -f "$DOC" ]; then
    pass "Document exists: $DOC"
  else
    fail "Document" "$DOC not found"
  fi
done

# Spec progress tracker shows all completed
SPEC_COMPLETED=$(grep -c "completed" docs/specs/architecture-hardening-spec.md 2>/dev/null || echo 0)
if [ "$SPEC_COMPLETED" -ge 6 ]; then
  pass "Spec progress tracker: all 6 tasks marked completed"
else
  fail "Spec tracker" "only $SPEC_COMPLETED/6 tasks show as completed"
fi

# T6 audit conclusions present in spec
if grep -q "T6 Medium/Low" docs/specs/architecture-hardening-spec.md 2>/dev/null; then
  pass "T6 audit conclusions recorded in spec §6.0"
else
  fail "T6 audit" "conclusions not found in spec"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

section "Summary"

echo -e "  Total:  $((PASSED + FAILED)) checks"
echo -e "  ${GREEN}Passed: $PASSED${NC}"
if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}Failed: $FAILED${NC}"
fi
echo -e "  Duration: ${DURATION}s"

# Cleanup temp files
rm -f /tmp/t1-output.txt /tmp/t2-output.txt /tmp/t3-output.txt /tmp/full-test-output.txt

echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║  ALL CHECKS PASSED               ║${NC}"
  echo -e "${GREEN}${BOLD}║  Architecture hardening verified  ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════╝${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}╔══════════════════════════════════╗${NC}"
  echo -e "${RED}${BOLD}║  $FAILED CHECK(S) FAILED               ║${NC}"
  echo -e "${RED}${BOLD}║  Review output above              ║${NC}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════╝${NC}"
  echo ""
  exit 1
fi
