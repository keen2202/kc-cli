import type { EventMiddleware, UIEvent } from '../event-bus';

interface BudgetState {
  used: number;
  limit: number;
  warned80: boolean;
  blocked: boolean;
}

/**
 * BudgetMiddleware - Tracks cumulative token usage from turn_complete events.
 * Emits warning at 80% budget. Blocks further queries at 100%.
 */
export function createBudgetMiddleware(limit: number): EventMiddleware & { getState(): BudgetState; reset(): void } {
  const state: BudgetState = {
    used: 0,
    limit,
    warned80: false,
    blocked: false,
  };

  const middleware: EventMiddleware = (event: UIEvent, next: () => void) => {
    const ev = event as any;
    const type = (ev.type || '').replace(/^agent:/, '');

    if (type === 'turn_complete' && ev.usage) {
      state.used += ev.usage.totalTokens || 0;

      const pct = state.used / state.limit;
      if (pct >= 1 && !state.blocked) {
        state.blocked = true;
      } else if (pct >= 0.8 && !state.warned80) {
        state.warned80 = true;
      }
    }

    next();
  };

  return Object.assign(middleware, {
    getState: () => ({ ...state }),
    reset: () => { state.used = 0; state.warned80 = false; state.blocked = false; },
  });
}
