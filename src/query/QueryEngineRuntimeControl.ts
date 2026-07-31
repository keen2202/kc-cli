// Runtime Control Handler (harness-evolution T2 / H2)
// Cross-turn behavior policies ported from the Self-Harness golden rules:
//   1. Retry discipline — the same (toolName, inputHash) call failing
//      repeatedly triggers a soft instruction injection or a hard rejection.
//   2. Exploration-loop breaking — N consecutive read-only turns trigger a
//      "stop exploring, start implementing/verifying" instruction.
//   3. Tool-message cap — a total tool-message ceiling triggers a redirect
//      instruction that steers the agent toward converging on a result.
//
// All interventions are gated by `policy.enabled` (default false). The
// repeated-failure context on error output text is intentionally independent
// of the switch (lightweight, spec-mandated).

import { createHash } from 'node:crypto';
import type { RuntimeControlPolicy, RuntimeControlIntervention } from './protocol';
import { logger } from '../services/logger';

// ── Optional AGP tracing (lazy) ──
// The SEPL trace feed is best-effort. Loading the AGP subsystem lazily keeps
// the core query loop free of a compile/load-time dependency on src/agp
// (plug-in boundary): if AGP is absent or fails to load, tracing is disabled
// silently and the query loop is unaffected.
type TraceRecordFn = (entry: {
  category: 'decision';
  severity: 'warn';
  source: string;
  message: string;
  data: Record<string, unknown>;
}) => void;

let traceRecordFn: TraceRecordFn | null | undefined;

function feedTraceBestEffort(entry: Parameters<TraceRecordFn>[0]): void {
  if (traceRecordFn === null) return; // previous load failed — tracing disabled
  if (traceRecordFn) {
    try {
      traceRecordFn(entry);
    } catch {
      // Tracing is best-effort — never break the query loop.
    }
    return;
  }
  import('../agp/trace-manager')
    .then((m) => {
      traceRecordFn = (e) => m.getTraceManager().record(e);
      try {
        traceRecordFn(entry);
      } catch {
        // best-effort
      }
    })
    .catch(() => {
      traceRecordFn = null;
    });
}

/** Tools considered read-only for the exploration-loop breaker. */
const READ_ONLY_TOOLS = new Set([
  'FileRead', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TaskGet', 'Monitor',
]);

const DEFAULT_POLICY: RuntimeControlPolicy = {
  enabled: false,
  maxSameCallRetries: 2,
  retryIntervention: 'soft',
  maxReadOnlyStreak: 5,
  maxTotalToolMessages: 0,
};

const RETRY_DISCIPLINE_INSTRUCTION = [
  '## Retry Discipline',
  'You have repeated the same tool call with identical arguments after it failed.',
  'Do NOT retry the same command with the same arguments. Diagnose the terminal cause first, then either change the arguments, choose a different tool, or fix the underlying precondition (missing file, dependency, permission).',
].join('\n');

const EXPLORATION_BREAK_INSTRUCTION = [
  '## Exploration Loop Breaker',
  'You have spent several consecutive turns only reading/searching without producing changes or running verification.',
  'Stop exploring. Commit to the best hypothesis you have, implement the change, and verify it. If information is genuinely missing, state exactly what is missing and why.',
].join('\n');

const DEFAULT_REDIRECT_INSTRUCTION = [
  '## Tool Budget Redirect',
  'The tool-message budget for this task has been reached.',
  'Converge now: summarize what you have learned, apply the smallest change that addresses the goal, verify it, and report the outcome.',
].join('\n');

function hashInput(input: Record<string, unknown>): string {
  // Canonical-ish stable hash: sorted keys, JSON values.
  const keys = Object.keys(input).sort();
  const canonical = keys.map(k => `${k}=${JSON.stringify(input[k])}`).join('&');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

interface CallRecord {
  key: string;
  toolName: string;
  inputHash: string;
  isError: boolean;
}

/**
 * Tracks per-session tool-call outcomes and turn composition, and produces
 * the pending instruction injections / hard rejections mandated by the policy.
 */
export class RuntimeControlHandler {
  private policy: RuntimeControlPolicy;
  /** Ring history of recent tool calls (bounded). */
  private callHistory: CallRecord[] = [];
  /** Consecutive failure count per (toolName, inputHash). Reset on success. */
  private consecutiveFailures = new Map<string, number>();
  /** Consecutive read-only-only turns. */
  private readOnlyStreak = 0;
  /** Total tool messages produced this session. */
  private totalToolMessages = 0;
  /** Instructions queued for injection at the next streaming turn. */
  private pendingInjections: string[] = [];
  /** Fired-once flags so the same intervention isn't re-injected every turn. */
  private explorationBreakFired = false;
  private redirectFired = false;
  /** All interventions, for TraceManager/testing introspection. */
  private interventions: RuntimeControlIntervention[] = [];

  private static readonly MAX_HISTORY = 200;

  constructor(policy?: Partial<RuntimeControlPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }

  /** Stable key for a call. */
  private callKey(toolName: string, input: Record<string, unknown>): { key: string; inputHash: string } {
    const inputHash = hashInput(input);
    return { key: `${toolName}:${inputHash}`, inputHash };
  }

  /**
   * Hard-mode gate: returns a structured rejection reason when the identical
   * call has already failed >= maxSameCallRetries times consecutively.
   * Returns null when execution should proceed.
   */
  checkHardReject(toolName: string, input: Record<string, unknown>): string | null {
    if (!this.policy.enabled || this.policy.retryIntervention !== 'hard') return null;
    const { key, inputHash } = this.callKey(toolName, input);
    const failures = this.consecutiveFailures.get(key) ?? 0;
    if (failures >= this.policy.maxSameCallRetries) {
      const reason =
        `Runtime control policy rejected this call: the identical ${toolName} call ` +
        `(input hash ${inputHash}) already failed ${failures} consecutive time(s). ` +
        'Change the arguments or the approach instead of retrying.';
      this.recordIntervention({
        kind: 'retry_discipline',
        mode: 'hard',
        toolName,
        inputHash,
        detail: reason,
        timestamp: Date.now(),
      });
      return reason;
    }
    return null;
  }

  /**
   * Record a tool call outcome. Always active (independent of the policy
   * switch) so the repeated-failure context is available for error text.
   */
  recordToolResult(toolName: string, input: Record<string, unknown>, isError: boolean): void {
    const { key, inputHash } = this.callKey(toolName, input);
    this.callHistory.push({ key, toolName, inputHash, isError });
    if (this.callHistory.length > RuntimeControlHandler.MAX_HISTORY) {
      this.callHistory = this.callHistory.slice(-RuntimeControlHandler.MAX_HISTORY);
    }
    if (isError) {
      const next = (this.consecutiveFailures.get(key) ?? 0) + 1;
      this.consecutiveFailures.set(key, next);
      // Soft intervention: queue a retry-discipline instruction for next turn.
      if (this.policy.enabled
          && this.policy.retryIntervention === 'soft'
          && next >= this.policy.maxSameCallRetries) {
        this.queueInjection(RETRY_DISCIPLINE_INSTRUCTION);
        this.recordIntervention({
          kind: 'retry_discipline',
          mode: 'soft',
          toolName,
          inputHash,
          detail: `Same ${toolName} call failed ${next} consecutive time(s); injecting retry-discipline instruction`,
          timestamp: Date.now(),
        });
      }
    } else {
      this.consecutiveFailures.delete(key);
    }
    this.totalToolMessages++;

    // Tool-message cap redirect (fires once).
    if (this.policy.enabled
        && this.policy.maxTotalToolMessages > 0
        && this.totalToolMessages >= this.policy.maxTotalToolMessages
        && !this.redirectFired) {
      this.redirectFired = true;
      this.queueInjection(this.policy.redirectInstruction || DEFAULT_REDIRECT_INSTRUCTION);
      this.recordIntervention({
        kind: 'tool_message_redirect',
        mode: 'soft',
        detail: `Tool-message cap (${this.policy.maxTotalToolMessages}) reached; injecting redirect instruction`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Lightweight repeated-failure context for error output text.
   * Active regardless of the policy switch (spec: independent enhancement).
   * Call BEFORE recordToolResult for the failing call.
   */
  getRepeatedFailureContext(toolName: string, input: Record<string, unknown>): string | null {
    const { key } = this.callKey(toolName, input);
    const failures = this.consecutiveFailures.get(key) ?? 0;
    if (failures > 0) {
      return `[Note: the previous identical ${toolName} call also failed (${failures} consecutive failure(s)). Consider changing your approach.]`;
    }
    return null;
  }

  /**
   * Record the composition of a completed turn for the exploration-loop
   * breaker. `toolNames` is the set of tools called during the turn.
   */
  recordTurn(toolNames: readonly string[]): void {
    if (toolNames.length === 0) {
      // No tool calls — not an exploration turn; reset the streak.
      this.readOnlyStreak = 0;
      return;
    }
    const allReadOnly = toolNames.every(n => READ_ONLY_TOOLS.has(n));
    if (allReadOnly) {
      this.readOnlyStreak++;
    } else {
      this.readOnlyStreak = 0;
      this.explorationBreakFired = false;
    }

    if (this.policy.enabled
        && this.readOnlyStreak >= this.policy.maxReadOnlyStreak
        && !this.explorationBreakFired) {
      this.explorationBreakFired = true;
      this.queueInjection(EXPLORATION_BREAK_INSTRUCTION);
      this.recordIntervention({
        kind: 'exploration_break',
        mode: 'soft',
        detail: `${this.readOnlyStreak} consecutive read-only turns; injecting exploration-break instruction`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Drain instructions queued for injection at the next streaming turn.
   * Returns '' when nothing is pending or the policy is disabled.
   */
  drainPendingInjections(): string {
    if (!this.policy.enabled || this.pendingInjections.length === 0) return '';
    const text = this.pendingInjections.join('\n\n');
    this.pendingInjections = [];
    return text;
  }

  /** All interventions recorded so far (for tests and SEPL Reflect). */
  getInterventions(): readonly RuntimeControlIntervention[] {
    return this.interventions;
  }

  private queueInjection(text: string): void {
    if (!this.pendingInjections.includes(text)) {
      this.pendingInjections.push(text);
    }
  }

  private recordIntervention(intervention: RuntimeControlIntervention): void {
    this.interventions.push(intervention);
    logger.query.info(`[RuntimeControl] ${intervention.kind} (${intervention.mode}): ${intervention.detail}`);
    // Feed the SEPL trace space (category 'decision') for T3 signature mining.
    feedTraceBestEffort({
      category: 'decision',
      severity: 'warn',
      source: 'runtime-control',
      message: `${intervention.kind}:${intervention.mode}`,
      data: { ...intervention },
    });
  }
}
