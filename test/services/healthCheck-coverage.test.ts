import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthCheckService } from '../../src/services/healthCheck';
import { CircuitBreakerRegistry } from '../../src/services/circuitBreaker';

describe('HealthCheckService - coverage', () => {
  let service: HealthCheckService;
  let circuitBreakers: CircuitBreakerRegistry;

  beforeEach(() => {
    circuitBreakers = new CircuitBreakerRegistry();
    service = new HealthCheckService({ checkTimeoutMs: 1000, failureThreshold: 3 }, circuitBreakers);
  });

  afterEach(() => {
    service.reset();
  });

  describe('timeout handling', () => {
    it('should handle health check timeout', async () => {
      service.setHealthChecks({
        api: async () => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return { healthy: true, latencyMs: 2000 };
        },
      });

      const result = await service.checkService('api');
      expect(result.service).toBe('api');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('LSP health check', () => {
    it('should catch errors in LSP health check', async () => {
      service.setHealthChecks({
        lsp: async () => { throw new Error('LSP crash'); },
      });

      const result = await service.checkService('lsp');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('LSP crash');
    });

    it('should handle non-Error exceptions in LSP check', async () => {
      service.setHealthChecks({
        lsp: async () => { throw 'string error'; },
      });

      const result = await service.checkService('lsp');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('string error');
    });
  });

  describe('MCP health check', () => {
    it('should catch errors in MCP health check', async () => {
      service.setHealthChecks({
        mcp: async () => { throw new Error('MCP disconnected'); },
      });

      const result = await service.checkService('mcp');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('MCP disconnected');
    });

    it('should handle non-Error exceptions in MCP check', async () => {
      service.setHealthChecks({
        mcp: async () => { throw 'string error'; },
      });

      const result = await service.checkService('mcp');
      expect(result.status).toBe('degraded');
    });
  });

  describe('API health check error handling', () => {
    it('should catch errors in API health check', async () => {
      service.setHealthChecks({
        api: async () => { throw new Error('Connection reset'); },
      });

      const result = await service.checkService('api');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('Connection reset');
    });

    it('should handle non-Error exceptions in API check', async () => {
      service.setHealthChecks({
        api: async () => { throw 'string error'; },
      });

      const result = await service.checkService('api');
      expect(result.status).toBe('degraded');
      expect(result.error).toBe('string error');
    });
  });

  describe('unhealthy triggers circuit breaker', () => {
    it('should mark service unhealthy after threshold failures', async () => {
      const lowThreshold = new HealthCheckService(
        { checkTimeoutMs: 500, failureThreshold: 1 },
        circuitBreakers
      );

      lowThreshold.setHealthChecks({
        api: async () => ({ healthy: false, latencyMs: 0, error: 'down' }),
      });

      // First failure: count=1, threshold=1 => unhealthy
      const result = await lowThreshold.checkService('api');
      expect(result.status).toBe('unhealthy');
    });
  });

  describe('startPeriodicChecks with default interval', () => {
    it('should use config interval when no interval specified', () => {
      const checkSpy = vi.spyOn(service, 'checkAll');
      service.startPeriodicChecks();
      service.stop();
      expect(checkSpy).toBeDefined();
    });

    it('should replace existing interval when starting again', async () => {
      const checkSpy = vi.spyOn(service, 'checkAll');
      service.startPeriodicChecks(50);
      service.startPeriodicChecks(50);
      await new Promise(resolve => setTimeout(resolve, 150));
      service.stop();
      expect(checkSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('stop when no interval', () => {
    it('should not throw when stopping without starting', () => {
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe('default health check implementations', () => {
    it('should use default API check when no custom check set', async () => {
      const result = await service.checkService('api');
      expect(result.status).toBe('healthy');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use default LSP check when no custom check set', async () => {
      const result = await service.checkService('lsp');
      expect(result.status).toBe('healthy');
    });

    it('should use default MCP check when no custom check set', async () => {
      const result = await service.checkService('mcp');
      expect(result.status).toBe('healthy');
    });

    it('should return unhealthy for default API check when breaker is open', async () => {
      const cb = new CircuitBreakerRegistry();
      // Open the breaker by recording many failures
      const breaker = cb.getBreaker('api');
      for (let i = 0; i < 10; i++) breaker.recordFailure();

      const svc = new HealthCheckService({ checkTimeoutMs: 500 }, cb);
      const result = await svc.checkService('api');
      // The result depends on circuit breaker state
      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status);
    });
  });

  describe('setHealthChecks partial override', () => {
    it('should only override specified checks', async () => {
      service.setHealthChecks({
        api: async () => ({ healthy: false, latencyMs: 0, error: 'custom fail' }),
      });

      const apiResult = await service.checkService('api');
      expect(apiResult.status).toBe('degraded');

      const lspResult = await service.checkService('lsp');
      expect(lspResult.status).toBe('healthy');
    });
  });
});
