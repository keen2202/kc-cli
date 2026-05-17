import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoReconnectService } from '../../src/services/autoReconnect';

describe('AutoReconnectService', () => {
  let service: AutoReconnectService;

  beforeEach(() => {
    service = new AutoReconnectService({
      maxAttempts: 3,
      baseDelayMs: 100, // Fast for testing
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    });
  });

  afterEach(() => {
    service.reset();
  });

  describe('registerService', () => {
    it('should register a service with idle state', () => {
      service.registerService('lsp', async () => true);
      const status = service.getStatus('lsp');
      expect(status).not.toBeNull();
      expect(status!.state).toBe('idle');
      expect(status!.attempt).toBe(0);
    });
  });

  describe('reconnect', () => {
    it('should succeed on first attempt', async () => {
      service.registerService('lsp', async () => true);

      const result = await service.reconnect('lsp');
      expect(result).toBe(true);

      const status = service.getStatus('lsp');
      expect(status!.state).toBe('connected');
      expect(status!.attempt).toBe(1);
    });

    it('should retry on failure and succeed', async () => {
      let callCount = 0;
      service.registerService('lsp', async () => {
        callCount++;
        return callCount >= 2; // Fail first, succeed second
      });

      const result = await service.reconnect('lsp');
      expect(result).toBe(true);
      expect(callCount).toBe(2);
    });

    it('should fail after max attempts', async () => {
      service.registerService('lsp', async () => false);

      const result = await service.reconnect('lsp');
      expect(result).toBe(false);

      const status = service.getStatus('lsp');
      expect(status!.state).toBe('failed');
      expect(status!.attempt).toBe(3);
    });

    it('should use exponential backoff', async () => {
      const delays: number[] = [];
      let lastTime = Date.now();

      service.registerService('lsp', async () => {
        const now = Date.now();
        delays.push(now - lastTime);
        lastTime = now;
        return false;
      });

      await service.reconnect('lsp');

      // First attempt has no delay, subsequent have exponential backoff
      expect(delays.length).toBe(3);
      // Second attempt should have ~100ms delay (baseDelayMs)
      expect(delays[1]).toBeGreaterThanOrEqual(80);
      // Third attempt should have ~200ms delay (baseDelayMs * 2)
      expect(delays[2]).toBeGreaterThanOrEqual(160);
    });

    it('should throw for unregistered service', async () => {
      await expect(service.reconnect('unknown')).rejects.toThrow('No connection function registered');
    });

    it('should store error on failure', async () => {
      service.registerService('lsp', async () => {
        throw new Error('Connection refused');
      });

      await service.reconnect('lsp');

      const status = service.getStatus('lsp');
      expect(status!.state).toBe('failed');
      expect(status!.error).toBe('Connection refused');
    });
  });

  describe('markConnected', () => {
    it('should mark service as connected', () => {
      service.registerService('lsp', async () => true);
      service.markConnected('lsp');

      const status = service.getStatus('lsp');
      expect(status!.state).toBe('connected');
    });
  });

  describe('markDisconnected', () => {
    it('should mark service as idle', () => {
      service.registerService('lsp', async () => true);
      service.markConnected('lsp');
      service.markDisconnected('lsp', 'Connection lost');

      const status = service.getStatus('lsp');
      expect(status!.state).toBe('idle');
      expect(status!.error).toBe('Connection lost');
    });
  });

  describe('needsReconnect', () => {
    it('should return true for idle service', () => {
      service.registerService('lsp', async () => true);
      expect(service.needsReconnect('lsp')).toBe(true);
    });

    it('should return false for connected service', () => {
      service.registerService('lsp', async () => true);
      service.markConnected('lsp');
      expect(service.needsReconnect('lsp')).toBe(false);
    });

    it('should return true for failed service', async () => {
      service.registerService('lsp', async () => false);
      await service.reconnect('lsp');
      expect(service.needsReconnect('lsp')).toBe(true);
    });
  });

  describe('getAllStatuses', () => {
    it('should return all registered services', () => {
      service.registerService('lsp', async () => true);
      service.registerService('mcp', async () => true);

      const statuses = service.getAllStatuses();
      expect(statuses.length).toBe(2);
      expect(statuses.map(s => s.service)).toContain('lsp');
      expect(statuses.map(s => s.service)).toContain('mcp');
    });
  });

  describe('cancelReconnect', () => {
    it('should cancel scheduled reconnection', () => {
      service.registerService('lsp', async () => true);
      service.scheduleReconnect('lsp');
      service.cancelReconnect('lsp');

      // Should not throw or have side effects
      expect(service.getStatus('lsp')!.state).toBe('idle');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      service.registerService('lsp', async () => true);
      service.registerService('mcp', async () => true);
      service.markConnected('lsp');

      service.reset();

      expect(service.getStatus('lsp')).toBeNull();
      expect(service.getStatus('mcp')).toBeNull();
      expect(service.getAllStatuses()).toHaveLength(0);
    });
  });
});
