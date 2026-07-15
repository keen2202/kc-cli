// Health Check Service - monitors API, LSP, and MCP service health

import { CircuitBreakerRegistry } from './circuitBreaker';
import { withTimeout } from '../utils/async-helpers';

export type ServiceStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ServiceHealth {
  service: string;
  status: ServiceStatus;
  lastCheck: number;
  latencyMs: number;
  error?: string;
}

export interface HealthCheckConfig {
  /** Interval in ms for periodic health checks */
  checkIntervalMs: number;
  /** Timeout in ms for individual health checks */
  checkTimeoutMs: number;
  /** Number of consecutive failures before marking unhealthy */
  failureThreshold: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  checkIntervalMs: 60_000, // 1 minute
  checkTimeoutMs: 5_000,   // 5 seconds
  failureThreshold: 3,
};

/**
 * Health check functions for each service type
 */
type HealthCheckFn = () => Promise<{ healthy: boolean; latencyMs: number; error?: string }>;

/**
 * Service health monitoring
 */
export class HealthCheckService {
  private healthStatus = new Map<string, ServiceHealth>();
  private failureCounts = new Map<string, number>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private config: HealthCheckConfig;
  private circuitBreakers: CircuitBreakerRegistry;

  // Health check functions (can be overridden for testing)
  private apiCheckFn: HealthCheckFn;
  private lspCheckFn: HealthCheckFn;
  private mcpCheckFn: HealthCheckFn;

  constructor(
    config: Partial<HealthCheckConfig> = {},
    circuitBreakers?: CircuitBreakerRegistry
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreakers = circuitBreakers || new CircuitBreakerRegistry();

    // Default health check implementations
    this.apiCheckFn = this.checkApiHealth.bind(this);
    this.lspCheckFn = this.checkLspHealth.bind(this);
    this.mcpCheckFn = this.checkMcpHealth.bind(this);
  }

  /**
   * Set custom health check functions (for testing)
   */
  setHealthChecks(checks: {
    api?: HealthCheckFn;
    lsp?: HealthCheckFn;
    mcp?: HealthCheckFn;
  }): void {
    if (checks.api) this.apiCheckFn = checks.api;
    if (checks.lsp) this.lspCheckFn = checks.lsp;
    if (checks.mcp) this.mcpCheckFn = checks.mcp;
  }

  /**
   * Check API health - lightweight endpoint ping
   */
  private async checkApiHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      // In a real implementation, this would ping a lightweight API endpoint
      // For now, we check the circuit breaker state
      const breaker = this.circuitBreakers.getBreaker('api');
      const state = breaker.getState();

      if (state === 'open') {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: 'Circuit breaker is open',
        };
      }

      return {
        healthy: true,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check LSP health - heartbeat or connection state
   */
  private async checkLspHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      // In a real implementation, this would send a $/cancelRequest or heartbeat
      // For now, we check the circuit breaker state
      const breaker = this.circuitBreakers.getBreaker('lsp');
      const state = breaker.getState();

      if (state === 'open') {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: 'LSP circuit breaker is open',
        };
      }

      return {
        healthy: true,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check MCP health - transport state inspection
   */
  private async checkMcpHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      // In a real implementation, this would inspect MCP transport state
      // For now, we check the circuit breaker state
      const breaker = this.circuitBreakers.getBreaker('mcp');
      const state = breaker.getState();

      if (state === 'open') {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: 'MCP circuit breaker is open',
        };
      }

      return {
        healthy: true,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Run a single health check for a service
   */
  async checkService(service: string): Promise<ServiceHealth> {
    const checkFn = service === 'api' ? this.apiCheckFn
      : service === 'lsp' ? this.lspCheckFn
      : service === 'mcp' ? this.mcpCheckFn
      : null;

    if (!checkFn) {
      return {
        service,
        status: 'unhealthy',
        lastCheck: Date.now(),
        latencyMs: 0,
        error: `Unknown service: ${service}`,
      };
    }

    try {
      const result = await withTimeout(
        checkFn(),
        this.config.checkTimeoutMs,
        'Health check timeout',
      );

      // Update failure count
      if (!result.healthy) {
        const count = (this.failureCounts.get(service) || 0) + 1;
        this.failureCounts.set(service, count);
      } else {
        this.failureCounts.set(service, 0);
      }

      // Determine status:
      // - If healthy: 'healthy'
      // - If circuit breaker is open (check by error message): 'unhealthy'
      // - Otherwise: based on failure count threshold
      const currentFailures = this.failureCounts.get(service) || 0;
      const circuitBreakerOpen = result.error?.includes('Circuit breaker is open');
      const status: ServiceStatus = result.healthy
        ? 'healthy'
        : circuitBreakerOpen || currentFailures >= this.config.failureThreshold
          ? 'unhealthy'
          : 'degraded';

      const health: ServiceHealth = {
        service,
        status,
        lastCheck: Date.now(),
        latencyMs: result.latencyMs,
        error: result.error,
      };

      this.healthStatus.set(service, health);

      // Open circuit breaker if unhealthy
      if (status === 'unhealthy') {
        const breaker = this.circuitBreakers.getBreaker(service);
        breaker.recordFailure();
      }

      return health;
    } catch (error) {
      // Increment failure count
      const count = (this.failureCounts.get(service) || 0) + 1;
      this.failureCounts.set(service, count);

      const currentFailures = this.failureCounts.get(service) || 0;
      const status: ServiceStatus = currentFailures >= this.config.failureThreshold
        ? 'unhealthy'
        : 'degraded';

      const health: ServiceHealth = {
        service,
        status,
        lastCheck: Date.now(),
        latencyMs: this.config.checkTimeoutMs,
        error: error instanceof Error ? error.message : String(error),
      };

      this.healthStatus.set(service, health);

      // Open circuit breaker if unhealthy
      if (status === 'unhealthy') {
        const breaker = this.circuitBreakers.getBreaker(service);
        breaker.recordFailure();
      }

      return health;
    }
  }

  /**
   * Check all services
   */
  async checkAll(): Promise<ServiceHealth[]> {
    const services = ['api', 'lsp', 'mcp'];
    const results = await Promise.all(services.map(s => this.checkService(s)));
    return results;
  }

  /**
   * Get health status for all services
   */
  getServiceHealth(): ServiceHealth[] {
    return Array.from(this.healthStatus.values());
  }

  /**
   * Get health status for a specific service
   */
  getServiceHealthByName(service: string): ServiceHealth | null {
    return this.healthStatus.get(service) || null;
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks(intervalMs?: number): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    const interval = intervalMs || this.config.checkIntervalMs;
    this.checkInterval = setInterval(async () => {
      await this.checkAll();
    }, interval);
  }

  /**
   * Stop periodic health checks
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Reset health check state
   */
  reset(): void {
    this.healthStatus.clear();
    this.failureCounts.clear();
    this.stop();
  }
}
