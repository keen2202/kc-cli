// Circuit Breaker Service
// Prevents cascading failures by tracking service health and rejecting requests
// when a service is consistently failing.

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Number of failures before opening (default: 5)
  resetTimeoutMs: number;      // Time in ms before trying half-open (default: 30000)
  halfOpenTestCount: number;   // Number of successful tests to close (default: 1)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenTestCount: 1,
};

export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a request can be executed through this circuit breaker.
   * Returns false if the circuit is open and the reset timeout hasn't elapsed.
   */
  canExecute(): boolean {
    if (this._state === 'closed') {
      return true;
    }

    if (this._state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'half-open';
        this.successCount = 0;
        return true;
      }
      return false;
    }

    // half-open: allow test requests
    return true;
  }

  /**
   * Record a successful execution.
   * In half-open state, accumulates successes until threshold is met to close the circuit.
   */
  recordSuccess(): void {
    if (this._state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenTestCount) {
        this.reset();
      }
    } else {
      // In closed state, reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed execution.
   * In closed state, increments failure count and opens circuit if threshold is reached.
   * In half-open state, immediately reopens the circuit.
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this._state === 'half-open') {
      this._state = 'open';
      return;
    }

    this.failureCount++;
    if (this.failureCount >= this.config.failureThreshold) {
      this._state = 'open';
    }
  }

  /**
   * Get the current circuit state.
   */
  getState(): CircuitState {
    // Check if open circuit should transition to half-open
    if (this._state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'half-open';
        this.successCount = 0;
      }
    }
    return this._state;
  }

  /**
   * Get the current failure count.
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Get time until the circuit transitions from open to half-open.
   * Returns 0 if circuit is not open.
   */
  getTimeUntilHalfOpen(): number {
    if (this._state !== 'open') return 0;
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.resetTimeoutMs - elapsed);
  }

  /**
   * Manually reset the circuit to closed state.
   */
  reset(): void {
    this._state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Get the breaker name (for logging/display).
   */
  getName(): string {
    return this.name;
  }
}

/**
 * Registry of circuit breakers for different services.
 * Provides a centralized way to manage per-service breakers.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly defaultConfig: Partial<CircuitBreakerConfig>;

  constructor(defaultConfig?: Partial<CircuitBreakerConfig>) {
    this.defaultConfig = defaultConfig || {};
  }

  /**
   * Get or create a circuit breaker for a service.
   */
  getBreaker(serviceName: string): CircuitBreaker {
    if (!this.breakers.has(serviceName)) {
      this.breakers.set(serviceName, new CircuitBreaker(serviceName, this.defaultConfig));
    }
    return this.breakers.get(serviceName)!;
  }

  /**
   * Get the health status of all registered breakers.
   */
  getStatus(): Array<{ service: string; state: CircuitState; failures: number }> {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => ({
      service: name,
      state: breaker.getState(),
      failures: breaker.getFailureCount(),
    }));
  }

  /**
   * Reset all circuit breakers.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Reset a specific circuit breaker.
   */
  reset(serviceName: string): boolean {
    const breaker = this.breakers.get(serviceName);
    if (breaker) {
      breaker.reset();
      return true;
    }
    return false;
  }
}
