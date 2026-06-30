import type { EventMiddleware, UIEvent } from '../event-bus';
import { BudgetEnforcer } from '../../services/budget';
import type { BudgetSnapshot } from '../../services/budget';

interface BudgetState {
  used: number;
  limit: number;
  warned80: boolean;
  blocked: boolean;
}

/**
 * BudgetMiddleware - Tracks cumulative token usage from turn_complete events.
 * Delegates token/cost tracking to BudgetEnforcer service.
 * Emits warning at 80% budget. Blocks further queries at 100%.
 */
export function createBudgetMiddleware(limit: number): EventMiddleware & { getState(): BudgetState; reset(): void } {
  let enforcer = new BudgetEnforcer({ sessionTokenLimit: limit });
  let warned80 = false;
  let blocked = false;

  const middleware: EventMiddleware = (event: UIEvent, next: () => void) => {
    const ev = event as any;
    const type = (ev.type || '').startsWith('agent:') ? (ev.type as string).slice(6) : (ev.type || '');

    if (type === 'turn_complete' && ev.usage) {
      enforcer.recordUsage(ev.usage.totalTokens || 0);

      const snapshot = enforcer.getSessionUsage();
      const pct = snapshot.tokens / limit;
      if (pct >= 1 && !blocked) {
        blocked = true;
      } else if (pct >= 0.8 && !warned80) {
        warned80 = true;
      }
    }

    next();
  };

  return Object.assign(middleware, {
    getState: (): BudgetState => {
      const snapshot = enforcer.getSessionUsage();
      return { used: snapshot.tokens, limit, warned80, blocked };
    },
    reset: () => {
      enforcer = new BudgetEnforcer({ sessionTokenLimit: limit });
      warned80 = false;
      blocked = false;
    },
  });
}
