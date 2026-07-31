// Exit-gate decision phase, extracted from QueryEngine (architecture 4e).
// Owns the per-query retry budgets (zero-patch / verification / type-check)
// and the last pre-exit verification gate outcomes consumed by the completion
// report (T7/M2). Also orchestrates the forced git commit on exit (P0).
// Pure move of QueryEngine.decidingPhase — no behavior or event change.

import { logger } from '../services/logger';
import { autoCommitAll } from '../utils/git';
import type { AssistantMessage, ChatMessage, PatchGuaranteeConfig } from './protocol';
import {
  verifyBeforeExit,
  verifyTypeCheckBeforeExit,
  extractFailToPassTests,
  toTypeCheckGateReport,
  toTestGateReport,
} from './QueryEngineVerification';
import type { VerificationGateReport } from './completion-report';

/** Everything the deciding phase needs from the engine, passed per call. */
export interface DecisionContext {
  turnCount: number;
  minTurns: number;
  /** Conversational-query exemption (greetings/small talk skip the gates). */
  conversational: boolean;
  cwd: string;
  modifiedFilesCount: number;
  patchGuarantee?: PatchGuaranteeConfig;
  getLastMessage(): ChatMessage | undefined;
  getMessages(): ChatMessage[];
  steer(message: string): void;
  addMessage(message: ChatMessage): void;
}

/**
 * Pre-exit gates for the query loop's 'deciding' state: anti-abandonment,
 * forced commit on exit, zero-patch detection (B1) and pre-exit type-check /
 * test verification (B2/B3). `decide()` returns true when the agent must
 * continue (tool calls pending or a gate forced continuation).
 */
export class DecisionGates {
  /** Zero-patch steer count — read by the loop's exhaustion check. */
  zeroPatchRetries = 0;
  private verificationRetries = 0;
  private typeCheckRetries = 0;

  // T7 (M2): last pre-exit verification gate outcomes, captured so the
  // completion report reflects the final type-check / test result at exit.
  lastTypeCheckGate: VerificationGateReport | null = null;
  lastTestGate: VerificationGateReport | null = null;

  /**
   * Fresh retry budget per user query. Without this, zero-patch / verification
   * retry counters accumulate across queries and a few plain Q&A turns exhaust
   * the budget, poisoning every subsequent query with model_no_patch.
   */
  reset(): void {
    this.zeroPatchRetries = 0;
    this.verificationRetries = 0;
    this.typeCheckRetries = 0;
    this.lastTypeCheckGate = null;
    this.lastTestGate = null;
  }

  async decide(ctx: DecisionContext): Promise<boolean> {
    const lastMsg = ctx.getLastMessage();
    if (!lastMsg || lastMsg.role !== 'assistant') {
      // P1: If below minTurns, force continuation (task queries only)
      if (ctx.turnCount < ctx.minTurns && !ctx.conversational) {
        return true; // Force agent to continue
      }
      return false;
    }

    const assistantMsg = lastMsg as AssistantMessage;
    const hasToolCalls = !!(assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0);

    // Conversational queries complete as soon as the model answers without
    // tools: no anti-abandonment, no zero-patch steer, no exit verification.
    if (ctx.conversational && !hasToolCalls) {
      return false;
    }

    // P1: Anti-abandonment — if below minTurns and agent has no tool calls, force continuation
    if (!hasToolCalls && ctx.turnCount < ctx.minTurns) {
      logger.query.info(`[QueryEngine] Anti-abandonment: turn ${ctx.turnCount} < minTurns ${ctx.minTurns}, forcing continuation`);
      return true; // Force agent to continue
    }

    // P0: Forced commit on exit — if agent wants to exit with uncommitted changes, force a commit
    if (!hasToolCalls && ctx.modifiedFilesCount > 0) {
      try {
        const committed = await autoCommitAll(ctx.cwd);
        if (committed) {
          logger.query.info(`[QueryEngine] Forced commit on exit: ${ctx.modifiedFilesCount} files`);
        }
      } catch {
        // Non-fatal
      }
    }

    // Area 2: Patch Guarantee — zero-patch detection (B1)
    if (!hasToolCalls) {
      const pgConfig: PatchGuaranteeConfig = {
        enabled: ctx.patchGuarantee?.enabled ?? true,
        maxZeroPatchRetries: ctx.patchGuarantee?.maxZeroPatchRetries ?? 3,
        maxVerificationRetries: ctx.patchGuarantee?.maxVerificationRetries ?? 2,
        verificationTimeout: ctx.patchGuarantee?.verificationTimeout ?? 60,
        testCommand: ctx.patchGuarantee?.testCommand ?? 'pytest {test_names} -x',
        typeCheck: ctx.patchGuarantee?.typeCheck ?? true,
        typeCheckCommand: ctx.patchGuarantee?.typeCheckCommand ?? '',
        maxTypeCheckRetries: ctx.patchGuarantee?.maxTypeCheckRetries ?? 2,
      };

      if (!pgConfig.enabled) return hasToolCalls;

      // B1: Zero-patch detection
      if (ctx.modifiedFilesCount === 0) {
        if (this.zeroPatchRetries < pgConfig.maxZeroPatchRetries) {
          this.zeroPatchRetries++;
          const remaining = pgConfig.maxZeroPatchRetries - this.zeroPatchRetries;
          const steerMsg = [
            '## PATCH REQUIRED',
            '',
            `You are about to exit but have modified ZERO files. Retry ${this.zeroPatchRetries}/${pgConfig.maxZeroPatchRetries}.`,
            '',
            'Before giving up, verify:',
            '1. Did you run the FAIL_TO_PASS tests? What exact error do they show?',
            '2. Did you read the source files related to those errors?',
            '3. Form a specific hypothesis and make at least one edit.',
            '',
            `You have ${remaining} more retry attempt(s) before this session is marked as failed.`,
          ].join('\n');

          logger.query.warn(`[QueryEngine] Zero-patch detection: retry ${this.zeroPatchRetries}/${pgConfig.maxZeroPatchRetries}`);
          ctx.steer(steerMsg);

          return true; // Force continuation
        }

        // Retries exhausted — emit structured error
        logger.query.error('[QueryEngine] Zero-patch retries exhausted — model_no_patch');
        return false; // Let the state machine handle the error
      }
    }

    // B2/B3: Pre-exit verification (type-check + tests)
    // Runs whenever the agent modified files and is about to exit.
    if (ctx.modifiedFilesCount > 0) {
      const pgConfig: PatchGuaranteeConfig = {
        enabled: ctx.patchGuarantee?.enabled ?? true,
        maxZeroPatchRetries: ctx.patchGuarantee?.maxZeroPatchRetries ?? 3,
        maxVerificationRetries: ctx.patchGuarantee?.maxVerificationRetries ?? 2,
        verificationTimeout: ctx.patchGuarantee?.verificationTimeout ?? 60,
        testCommand: ctx.patchGuarantee?.testCommand ?? 'pytest {test_names} -x',
        typeCheck: ctx.patchGuarantee?.typeCheck ?? true,
        typeCheckCommand: ctx.patchGuarantee?.typeCheckCommand ?? '',
        maxTypeCheckRetries: ctx.patchGuarantee?.maxTypeCheckRetries ?? 2,
        typeCheckStrict: ctx.patchGuarantee?.typeCheckStrict ?? false,
      };

      // B3: Pre-exit type-check verification. Gated on exit intent (no pending
      // tool calls) so `tsc`/`mypy` don't run on every mid-task turn. Unlike
      // test verification, this does not require FAIL_TO_PASS test names.
      if (!hasToolCalls && pgConfig.enabled && pgConfig.typeCheck
          && this.typeCheckRetries < pgConfig.maxTypeCheckRetries) {
        const tcResult = await verifyTypeCheckBeforeExit(pgConfig);
        // T7 (M2): capture the gate outcome for the completion report.
        this.lastTypeCheckGate = toTypeCheckGateReport(tcResult, pgConfig);

        if (!tcResult.canExit &&
            (tcResult.reason === 'typecheck_fail' || tcResult.reason === 'typecheck_infra_error')) {
          this.typeCheckRetries++;
          const isInfra = tcResult.reason === 'typecheck_infra_error';
          const steerMsg = [
            `## ${isInfra ? 'TYPE-CHECK COULD NOT RUN' : 'TYPE-CHECK FAILED'} (${this.typeCheckRetries}/${pgConfig.maxTypeCheckRetries})`,
            '',
            isInfra
              ? 'The type-check command could not be executed:'
              : 'Your changes do not pass type/compile checking:',
            '```',
            tcResult.failures || '(no output captured)',
            '```',
            isInfra
              ? 'Ensure the type-check toolchain is available before exiting.'
              : 'Please fix these type errors before exiting.',
          ].join('\n');

          ctx.steer(steerMsg);
          ctx.addMessage({
            id: `typecheck_failed_${Date.now()}`,
            role: 'user',
            content: steerMsg,
            timestamp: Date.now(),
          });

          return true; // Force continuation
        } else if (tcResult.canExit && tcResult.reason === 'typecheck_pass') {
          logger.query.info('[QueryEngine] Pre-exit type-check: passed');
        }
      }

      // B2: Pre-exit test verification
      const testNames = extractFailToPassTests(ctx.getMessages());
      if (pgConfig.enabled && testNames.length > 0 && this.verificationRetries < pgConfig.maxVerificationRetries) {
        const result = await verifyBeforeExit(testNames, pgConfig);
        // T7 (M2): capture the gate outcome for the completion report.
        this.lastTestGate = toTestGateReport(result, pgConfig);

        if (!result.canExit && result.reason === 'tests_fail') {
          this.verificationRetries++;
          const failures = (result.failures || []).join('\n\n');
          const steerMsg = [
            `## VERIFICATION FAILED (${this.verificationRetries}/${pgConfig.maxVerificationRetries})`,
            '',
            'The following tests still do not pass:',
            '```',
            failures,
            '```',
            'Please fix these issues before exiting.',
          ].join('\n');

          ctx.steer(steerMsg);
          ctx.addMessage({
            id: `verification_failed_${Date.now()}`,
            role: 'user',
            content: steerMsg,
            timestamp: Date.now(),
          });

          return true; // Force continuation
        } else if (result.canExit && result.reason === 'tests_pass') {
          logger.query.info('[QueryEngine] Pre-exit verification: all tests pass');
        }
      }
    }

    return hasToolCalls;
  }
}
