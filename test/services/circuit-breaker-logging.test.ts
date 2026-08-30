// Circuit-breaker state transition logging — round4 §4-O2

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CircuitBreaker } from '../../src/services/circuitBreaker';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';

describe('O2: circuit breaker state transitions are logged', () => {
  let spy: LoggerSpy;

  afterEach(() => {
    spy?.stop();
  });

  it('logs closed → open when the failure threshold is reached', () => {
    spy = spyOnLogger('api', ['warn']);
    const breaker = new CircuitBreaker('llm', { failureThreshold: 3, resetTimeoutMs: 30_000 });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(spy.calls.length).toBe(0); // still closed

    breaker.recordFailure();
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.message).toBe('circuit breaker state transition');
    expect(call.data).toMatchObject({
      name: 'llm',
      from: 'closed',
      to: 'open',
      failures: 3,
      threshold: 3,
      resetTimeoutMs: 30_000,
    });
    expect(call.data?.reason).toBeTruthy();
  });

  it('does not spam when recording further failures while open', () => {
    spy = spyOnLogger('api', ['warn']);
    const breaker = new CircuitBreaker('llm', { failureThreshold: 1 });

    breaker.recordFailure();
    const afterOpen = spy.calls.length;
    expect(afterOpen).toBe(1);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(spy.calls.length).toBe(afterOpen); // same-state: no repeat log
  });

  it('logs half-open probe failure as open and manual reset as closed', () => {
    spy = spyOnLogger('api', ['warn']);
    const breaker = new CircuitBreaker('llm', { failureThreshold: 1, resetTimeoutMs: 0 });

    breaker.recordFailure(); // closed → open
    const toHalfOpen = breaker.getState(); // resetTimeoutMs=0 → open → half-open
    expect(toHalfOpen).toBe('half-open');

    breaker.recordFailure(); // half-open → open
    const transitions = spy.calls.map((c) => `${c.data?.from}->${c.data?.to}`);
    expect(transitions).toContain('half-open->open');

    breaker.reset(); // → closed
    expect(spy.calls.at(-1)!.data).toMatchObject({ to: 'closed', reason: 'manual reset' });
  });
});
