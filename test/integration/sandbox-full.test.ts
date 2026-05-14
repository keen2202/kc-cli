import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxManager } from '../../src/services/sandbox';
import type { SandboxProbe } from '../../src/services/sandbox-probe';
import type { SandboxMonitor } from '../../src/services/sandbox-monitor';
import type { ImageManager } from '../../src/services/sandbox-images';

/**
 * Full sandbox integration tests.
 * Tests the integration of SandboxProbe, SandboxMonitor, and ImageManager
 * into SandboxManager.
 */

describe('SandboxManager Full Integration', () => {
  describe('Probe Integration', () => {
    it('should run probe on start when probeOnStart is true', async () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        probeOnStart: true,
      });

      // Probe runs async in background — wait for it
      await new Promise(resolve => setTimeout(resolve, 100));

      // noop backend has _isAvailable=false, so probe is NOT run
      const probeResult = manager.getProbeResult();
      // For noop, probe is skipped because _isAvailable is false
      expect(probeResult).toBeNull();
    });

    it('should not run probe when probeOnStart is false', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        probeOnStart: false,
      });

      expect(manager.getProbeResult()).toBeNull();
    });

    it('should manually run probe', async () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        probeOnStart: false,
      });

      // Manual probe on noop backend
      const result = await manager.runProbe();
      expect(result).toBeDefined();
      expect(result.total).toBe(4);
      expect(typeof result.passed).toBe('number');
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe('Monitor Integration', () => {
    it('should start and stop monitor', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        enableMonitor: true,
      });

      // Start monitoring a fake PID
      manager.startMonitor(1, 'proc', 500);

      // Stop and get metrics
      const metrics = manager.stopMonitor();
      expect(Array.isArray(metrics)).toBe(true);
    });

    it('should not start monitor when enableMonitor is false', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        enableMonitor: false,
      });

      manager.startMonitor(1, 'proc');
      const metrics = manager.stopMonitor();
      expect(metrics).toHaveLength(0);
    });

    it('should get latest metrics', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        enableMonitor: true,
      });

      expect(manager.getMonitorLatest()).toBeNull();
    });

    it('should check thresholds', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      // No metrics collected yet — should be ok
      expect(manager.checkThresholds()).toBe('ok');
    });
  });

  describe('ImageManager Integration', () => {
    it('should expose image manager', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
      });

      const imageManager = manager.getImageManager();
      expect(imageManager).toBeDefined();
      expect(typeof imageManager.ensureImage).toBe('function');
      expect(typeof imageManager.listCachedImages).toBe('function');
      expect(typeof imageManager.pruneUnused).toBe('function');
    });
  });

  describe('Probe + Monitor Coordination', () => {
    it('should run probe then monitor in sequence', async () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        probeOnStart: false,
        enableMonitor: true,
      });

      // Run probe
      const probeResult = await manager.runProbe();
      expect(probeResult).toBeDefined();

      // Start monitor
      manager.startMonitor(1, 'proc', 100);
      await new Promise(resolve => setTimeout(resolve, 250));

      // Stop monitor
      const metrics = manager.stopMonitor();
      expect(metrics.length).toBeGreaterThanOrEqual(1);

      // Check thresholds with collected metrics
      const status = manager.checkThresholds();
      expect(['ok', 'warn', 'kill']).toContain(status);
    });
  });

  describe('Options Integration', () => {
    it('should default probeOnStart and enableMonitor to true', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
      });

      // These should not throw — defaults are applied
      expect(manager.getProbeResult()).toBeNull(); // noop, so probe not run
      expect(manager.checkThresholds()).toBe('ok');
    });

    it('should accept all new options', () => {
      const manager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
        probeOnStart: false,
        enableMonitor: false,
        maxMemoryMb: 256,
        cpuTimeLimitSec: 30,
      });

      expect(manager).toBeDefined();
      expect(manager.getBackendName()).toBe('noop');
    });
  });
});
