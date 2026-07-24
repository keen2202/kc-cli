// Post-turn hook system - fire-and-forget hooks executed after each turn

import type { ChatMessage } from '../query/protocol';
import type { AgentState } from '../state/types';
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
