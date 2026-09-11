// Post-turn hook system - fire-and-forget hooks executed after each turn

import type { ChatMessage } from '../query/protocol';
import type { AgentState } from '../state/types';
import type { MemoryIntegration } from '../memory/integration';
import type { EvidenceBundle } from '../agp/sepl/protocol';
import type { ReportFinding } from '../orchestrator/types.js';
import { logger } from '../services/logger';
import { flushOperationAudit } from '../services/operation-audit-log';

export interface PostTurnHookContext {
  messages: ChatMessage[];
  systemPrompt: string;
  state: AgentState;
  querySource: string;
}

type PostTurnHook = (context: PostTurnHookContext) => Promise<void>;

// Registry of post-turn hooks
const hooks: PostTurnHook[] = [];

/**
 * Register a post-turn hook to be executed after each turn
 */
export function registerPostTurnHook(hook: PostTurnHook): void {
  hooks.push(hook);
}

/**
 * T8: Register the failure-signature → memory bridging hook.
 * The evidence provider returns the current EvidenceBundle (or null when no
 * failure evidence is available this turn). Bridging itself is gated by
 * `memory.failureBridging` (default false) inside MemoryIntegration, so
 * registering this hook alone changes no behaviour.
 */
export function registerFailureBridgingHook(
  integration: MemoryIntegration,
  getEvidence: () => EvidenceBundle | null,
  opts?: { threshold?: number }
): void {
  registerPostTurnHook(async () => {
    const evidence = getEvidence();
    if (!evidence || evidence.clusters.length === 0) {
      return;
    }
    await integration.bridgeFailureSignatures(evidence, opts);
  });
}

/**
 * Execute all registered post-turn hooks
 * Fire-and-forget: hooks run in background, errors are logged but don't block
 */
export async function executePostTurnHooks(context: PostTurnHookContext): Promise<void> {
  for (const hook of hooks) {
    try {
      // Fire-and-forget: run in background
      void hook(context).catch((err) => {
        console.error('[PostTurnHook] Error executing hook:', err);
      });
    } catch (err) {
      console.error('[PostTurnHook] Hook registration error:', err);
    }
  }
}

/**
 * Execute hooks sequentially and wait for completion
 * Used during graceful shutdown to ensure pending work completes
 */
export async function executePostTurnHooksSync(
  context: PostTurnHookContext,
  timeoutMs: number = 60000
): Promise<void> {
  const timeout = setTimeout(() => {
    console.warn('[PostTurnHook] Hook execution timed out after', timeoutMs, 'ms');
  }, timeoutMs);

  try {
    for (const hook of hooks) {
      try {
        await hook(context);
      } catch (err) {
        console.error('[PostTurnHook] Error in synchronous hook execution:', err);
      }
    }
    // T6 (M1): drain any pending operation-audit disk writes on graceful
    // shutdown so the audit trail is complete before the process exits.
    try {
      await flushOperationAudit();
    } catch (err) {
      console.error('[PostTurnHook] Error flushing operation audit log:', err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get the number of registered hooks
 */
export function getHookCount(): number {
  return hooks.length;
}

/**
 * Clear all registered hooks
 */
export function clearHooks(): void {
  hooks.length = 0;
}


// ─── RI-SPEC §3.1/§4: main-agent report-integrity hook ──────────────────

const REPORT_COUNT_RE =
  /(\d[\d,]*)\s*(?:个|条|项|例|次|份|套|用例|测试|断言|检查|文件|命令|tests?|cases?|files?|commands?|assertions?|checks?)/gi;

function extractNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  const re = /\d[\d,]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) numbers.add(value);
  }
  return numbers;
}

/**
 * Deterministic R1/R2-style audit for the main agent's last assistant turn.
 *
 * The post-turn chain is fire-and-forget and cannot hard-block the foreground
 * agent, so findings are attached to the message metadata and logged. This
 * gives the controller and later prompt-assembly passes a durable marker
 * instead of silently trusting a numeric claim or a checkpoint deflection.
 */
function auditMainAgentTurn(context: PostTurnHookContext): ReportFinding[] {
  const lastAssistant = [...context.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string');
  const content = lastAssistant?.content;
  if (!content?.trim()) return [];

  const findings: ReportFinding[] = [];
  const toolEvidence = context.messages
    .filter((m) => m.role === 'tool')
    .map((m) => {
      const maybe = m as { toolResults?: Array<{ output?: unknown }> };
      return Array.isArray(maybe.toolResults)
        ? maybe.toolResults.map((r) => String(r?.output ?? '')).join('\n')
        : '';
    })
    .join('\n');

  if (/(?:作答\s*见消息开头|答案?\s*见消息开头|见消息开头)/i.test(content)) {
    findings.push({
      rule: 'R1',
      severity: 'warning',
      code: 'checkpoint_deflection',
      message: 'Final message uses a "see the beginning" deflection; checkpoint answers are not present in the turn.',
      unsubstantiated: true,
    });
  }

  REPORT_COUNT_RE.lastIndex = 0;
  const claimed = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = REPORT_COUNT_RE.exec(content)) !== null) {
    const rawNumber = match[1];
    if (!rawNumber) continue;
    const key = `${match.index}:${rawNumber}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const value = Number(rawNumber.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;

    const evidenceNumbers = extractNumbers(toolEvidence);
    if (!evidenceNumbers.has(value)) {
      findings.push({
        rule: 'R2',
        severity: 'warning',
        code: evidenceNumbers.size > 0 ? 'numeric_claim_mismatch' : 'numeric_claim_unsubstantiated',
        message: `Final message claims "${match[0].trim()}" but no preceding tool output contains that number.`,
        unsubstantiated: true,
        detail: String(value),
      });
    }
  }

  if (findings.length > 0 && lastAssistant) {
    const assistant = lastAssistant as { metadata?: Record<string, unknown> };
    const existing = assistant.metadata?.reportFindings;
    assistant.metadata = {
      ...(assistant.metadata ?? {}),
      reportFindings: Array.isArray(existing) ? [...existing, ...findings] : findings,
    };
  }

  return findings;
}

let reportIntegrityHookRef: PostTurnHook | null = null;

/** Register the main-agent reporting-integrity audit hook (idempotent while installed). */
export function registerReportIntegrityHook(): void {
  if (reportIntegrityHookRef && hooks.includes(reportIntegrityHookRef)) return;
  const hook: PostTurnHook = async (context) => {
    const findings = auditMainAgentTurn(context);
    if (findings.length > 0) {
      logger.query.debug('[report-integrity] main-agent report findings', {
        findings: findings.map((f) => f.code),
      });
    }
  };
  reportIntegrityHookRef = hook;
  registerPostTurnHook(hook);
}

// RI-SPEC T07/§4: install the hook with the post-turn chain by default. Tests
// that call `clearHooks()` can re-register it explicitly.
registerReportIntegrityHook();
