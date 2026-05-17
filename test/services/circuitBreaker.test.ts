import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../src/services/circuitBreaker';
import type { CircuitBreakerConfig } from '../../src/services/circuitBreaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker('test-api');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('should allow execution when closed', () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it('should have zero failure count', () => {
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('closed → open transition', () => {
    it('should open after reaching failure threshold', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe('open');
    });

    it('should not open before reaching failure threshold', () => {
      for (let i = 0; i < 4; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe('closed');
    });

    it('should reject execution when open', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }
      expect(breaker.canExecute()).toBe(false);
    });

    it('should use custom failure threshold', () => {
      const customBreaker = new CircuitBreaker('custom', { failureThreshold: 3 });
      customBreaker.recordFailure();
      customBreaker.recordFailure();
      customBreaker.recordFailure();
      expect(customBreaker.getState()).toBe('open');
    });
  });

  describe('open → half-open transition', () => {
    it('should transition to half-open after reset timeout', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe('open');

      // Advance time past reset timeout (30s)
      vi.advanceTimersByTime(30001);
      expect(breaker.getState()).toBe('half-open');
    });

    it('should not transition before reset timeout', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      vi.advanceTimersByTime(29000);
      expect(breaker.getState()).toBe('open');
    });

    it('should allow execution in half-open state', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      vi.advanceTimersByTime(30001);
      expect(breaker.canExecute()).toBe(true);
    });

    it('should use custom reset timeout', () => {
      const customBreaker = new CircuitBreaker('custom', { resetTimeoutMs: 5000 });
      for (let i = 0; i < 5; i++) {
        customBreaker.recordFailure();
      }

      vi.advanceTimersByTime(5001);
      expect(customBreaker.getState()).toBe('half-open');
    });
  });

  describe('half-open → closed transition', () => {
    it('should close after successful test count', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      vi.advanceTimersByTime(30001);
      expect(breaker.getState()).toBe('half-open');

      breaker.recordSuccess();
      expect(breaker.getState()).toBe('closed');
    });

    it('should use custom half-open test count', () => {
      const customBreaker = new CircuitBreaker('custom', { halfOpenTestCount: 3 });
      for (let i = 0; i < 5; i++) {
        customBreaker.recordFailure();
      }

      vi.advanceTimersByTime(30001);
      // Transition to half-open by calling getState once
      expect(customBreaker.getState()).toBe('half-open');

      // Record 3 successes (don't call getState between, as it resets successCount on transition)
      customBreaker.recordSuccess();
      customBreaker.recordSuccess();
      customBreaker.recordSuccess();
      expect(customBreaker.getState()).toBe('closed');
    });
  });

  describe('half-open → open transition', () => {
    it('should reopen on failure in half-open state', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      vi.advanceTimersByTime(30001);
      expect(breaker.getState()).toBe('half-open');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
    });
  });

  describe('success resets failure count', () => {
    it('should reset failure count on success in closed state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(3);

      breaker.recordSuccess();
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('should not accumulate failures across successful calls', () => {
      for (let i = 0; i < 4; i++) {
        breaker.recordFailure();
      }
      breaker.recordSuccess();
      for (let i = 0; i < 4; i++) {
        breaker.recordFailure();
      }
      // Should still be closed because success reset the counter
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('manual reset', () => {
    it('should reset to closed state', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe('open');

      breaker.reset();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('getTimeUntilHalfOpen', () => {
    it('should return 0 when not open', () => {
      expect(breaker.getTimeUntilHalfOpen()).toBe(0);
    });

    it('should return remaining time when open', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      vi.advanceTimersByTime(10000);
      const remaining = breaker.getTimeUntilHalfOpen();
      expect(remaining).toBeGreaterThanOrEqual(19000);
      expect(remaining).toBeLessThanOrEqual(21000);
    });
  });

  describe('getName', () => {
    it('should return the breaker name', () => {
      expect(breaker.getName()).toBe('test-api');
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
  });

  it('should create breaker on first access', () => {
    const breaker = registry.getBreaker('api');
    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe('closed');
  });

  it('should return same breaker for same service', () => {
    const breaker1 = registry.getBreaker('api');
    const breaker2 = registry.getBreaker('api');
    expect(breaker1).toBe(breaker2);
  });

  it('should create different breakers for different services', () => {
    const apiBreaker = registry.getBreaker('api');
    const lspBreaker = registry.getBreaker('lsp');
    expect(apiBreaker).not.toBe(lspBreaker);
  });

  it('should report status of all breakers', () => {
    registry.getBreaker('api');
    registry.getBreaker('lsp');

    const status = registry.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0].service).toBe('api');
    expect(status[0].state).toBe('closed');
    expect(status[1].service).toBe('lsp');
    expect(status[1].state).toBe('closed');
  });

  it('should reset all breakers', () => {
    const apiBreaker = registry.getBreaker('api');
    const lspBreaker = registry.getBreaker('lsp');

    for (let i = 0; i < 5; i++) {
      apiBreaker.recordFailure();
      lspBreaker.recordFailure();
    }

    registry.resetAll();

    expect(apiBreaker.getState()).toBe('closed');
    expect(lspBreaker.getState()).toBe('closed');
  });

  it('should reset specific breaker', () => {
    const apiBreaker = registry.getBreaker('api');
    const lspBreaker = registry.getBreaker('lsp');

    for (let i = 0; i < 5; i++) {
      apiBreaker.recordFailure();
      lspBreaker.recordFailure();
    }

    registry.reset('api');

    expect(apiBreaker.getState()).toBe('closed');
    expect(lspBreaker.getState()).toBe('open');
  });

  it('should return false when resetting unknown service', () => {
    expect(registry.reset('unknown')).toBe(false);
  });

  it('should apply default config to new breakers', () => {
    const customRegistry = new CircuitBreakerRegistry({ failureThreshold: 2 });
    const breaker = customRegistry.getBreaker('api');

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
  });
});
