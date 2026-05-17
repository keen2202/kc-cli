import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthCheckService } from '../../src/services/healthCheck';
import { CircuitBreakerRegistry } from '../../src/services/circuitBreaker';

describe('HealthCheckService', () => {
  let service: HealthCheckService;
  let circuitBreakers: CircuitBreakerRegistry;

  beforeEach(() => {
    circuitBreakers = new CircuitBreakerRegistry();
    service = new HealthCheckService({ checkTimeoutMs: 1000 }, circuitBreakers);
  });

  afterEach(() => {
    service.reset();
  });

  describe('checkService', () => {
    it('should return healthy for API when circuit breaker is closed', async () => {
      const result = await service.checkService('api');
      expect(result.status).toBe('healthy');
      expect(result.service).toBe('api');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return healthy for LSP when circuit breaker is closed', async () => {
      const result = await service.checkService('lsp');
      expect(result.status).toBe('healthy');
    });

    it('should return healthy for MCP when circuit breaker is closed', async () => {
      const result = await service.checkService('mcp');
      expect(result.status).toBe('healthy');
    });

    it('should return unhealthy for unknown service', async () => {
      const result = await service.checkService('unknown');
      expect(result.status).toBe('unhealthy');
      expect(result.error).toContain('Unknown service');
    });

    it('should return unhealthy when circuit breaker is open', async () => {
      // Open the API circuit breaker
      const breaker = circuitBreakers.getBreaker('api');
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      const result = await service.checkService('api');
      expect(result.status).toBe('unhealthy');
      expect(result.error).toContain('Circuit breaker is open');
    });
  });

  describe('checkAll', () => {
    it('should check all services', async () => {
      const results = await service.checkAll();
      expect(results.length).toBe(3);
      expect(results.map(r => r.service)).toContain('api');
      expect(results.map(r => r.service)).toContain('lsp');
      expect(results.map(r => r.service)).toContain('mcp');
    });

    it('should return healthy for all services when circuit breakers are closed', async () => {
      const results = await service.checkAll();
      for (const result of results) {
        expect(result.status).toBe('healthy');
      }
    });
  });

  describe('getServiceHealth', () => {
    it('should return empty before any checks', () => {
      const health = service.getServiceHealth();
      expect(health.length).toBe(0);
    });

    it('should return health after checks', async () => {
      await service.checkAll();
      const health = service.getServiceHealth();
      expect(health.length).toBe(3);
    });
  });

  describe('getServiceHealthByName', () => {
    it('should return null for unchecked service', () => {
      const health = service.getServiceHealthByName('api');
      expect(health).toBeNull();
    });

    it('should return health after check', async () => {
      await service.checkService('api');
      const health = service.getServiceHealthByName('api');
      expect(health).not.toBeNull();
      expect(health!.status).toBe('healthy');
    });
  });

  describe('failure tracking', () => {
    it('should track consecutive failures', async () => {
      // Override health check to always fail
      service.setHealthChecks({
        api: async () => ({ healthy: false, latencyMs: 0, error: 'Connection refused' }),
      });

      // First failure - degraded
      const result1 = await service.checkService('api');
      expect(result1.status).toBe('degraded');

      // Second failure - still degraded
      const result2 = await service.checkService('api');
      expect(result2.status).toBe('degraded');

      // Third failure - unhealthy (threshold reached)
      const result3 = await service.checkService('api');
      expect(result3.status).toBe('unhealthy');
    });

    it('should reset failure count on success', async () => {
      let shouldFail = true;
      service.setHealthChecks({
        api: async () => ({
          healthy: !shouldFail,
          latencyMs: 0,
          error: shouldFail ? 'Connection refused' : undefined,
        }),
      });

      // Fail twice
      await service.checkService('api');
      await service.checkService('api');

      // Succeed
      shouldFail = false;
      const result = await service.checkService('api');
      expect(result.status).toBe('healthy');

      // Failure count should be reset
      shouldFail = true;
      const result2 = await service.checkService('api');
      expect(result2.status).toBe('degraded'); // Not unhealthy, because count was reset
    });
  });

  describe('custom health checks', () => {
    it('should use custom health check functions', async () => {
      service.setHealthChecks({
        api: async () => ({ healthy: false, latencyMs: 100, error: 'Custom error' }),
      });

      const result = await service.checkService('api');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('Custom error');
      expect(result.latencyMs).toBe(100);
    });
  });

  describe('periodic checks', () => {
    it('should start and stop periodic checks', async () => {
      const checkSpy = vi.spyOn(service, 'checkAll');

      service.startPeriodicChecks(100); // 100ms interval

      // Wait for a couple of intervals
      await new Promise(resolve => setTimeout(resolve, 250));

      service.stop();

      // Should have been called at least twice
      expect(checkSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should stop periodic checks on reset', async () => {
      const checkSpy = vi.spyOn(service, 'checkAll');

      service.startPeriodicChecks(100);
      service.reset();

      await new Promise(resolve => setTimeout(resolve, 250));

      // Should not have been called after reset
      expect(checkSpy.mock.calls.length).toBe(0);
    });
  });

  describe('unhealthy service triggers circuit breaker', () => {
    it('should open circuit breaker for unhealthy service', async () => {
      // Create service with lower failure threshold
      const lowThresholdService = new HealthCheckService(
        { checkTimeoutMs: 1000, failureThreshold: 2 },
        circuitBreakers
      );

      lowThresholdService.setHealthChecks({
        api: async () => ({ healthy: false, latencyMs: 0, error: 'Service down' }),
      });

      // Fail enough times to reach unhealthy and open circuit breaker
      // First failure: degraded (count=1), subsequent: unhealthy (count>=2)
      // Each unhealthy call records a circuit breaker failure
      // Need 5 circuit breaker failures to open, so 6 total health check failures
      for (let i = 0; i < 6; i++) {
        await lowThresholdService.checkService('api');
      }

      const breaker = circuitBreakers.getBreaker('api');
      expect(breaker.getState()).toBe('open');
    });
  });
});
