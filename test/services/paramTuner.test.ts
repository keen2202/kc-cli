import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterTuningService } from '../../src/services/paramTuner';

// Mock fs for persistence tests
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

describe('ParameterTuningService', () => {
  let service: ParameterTuningService;

  beforeEach(() => {
    service = new ParameterTuningService({
      settingsPath: '/tmp/test-tuned-params.json',
      observationThreshold: 5, // Lower threshold for testing
    });
    vi.clearAllMocks();
  });

  describe('recordOutcome', () => {
    it('should record outcomes', () => {
      service.recordOutcome({
        parameter: 'toolTimeout',
        toolName: 'Read',
        success: true,
        value: 100,
        timestamp: Date.now(),
      });

      expect(service.getObservationCount()).toBe(1);
    });

    it('should track multiple observations', () => {
      for (let i = 0; i < 5; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100 + i * 10,
          timestamp: Date.now(),
        });
      }

      expect(service.getObservationCount()).toBe(5);
    });
  });

  describe('getTunedValue', () => {
    it('should return default value when no tuning done', () => {
      const value = service.getTunedValue('toolTimeout', 'Read', 5000);
      expect(value).toBe(5000);
    });

    it('should return tuned value after tuning', () => {
      // Record enough observations
      for (let i = 0; i < 10; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      service.tune();
      const value = service.getTunedValue('toolTimeout', 'Read');
      expect(value).toBeDefined();
    });

    it('should return compaction threshold', () => {
      const value = service.getTunedValue('compactionThreshold');
      expect(value).toBe(180_000);
    });

    it('should return extraction throttle', () => {
      const value = service.getTunedValue('extractionThrottle');
      expect(value).toBe(3);
    });
  });

  describe('shouldTune', () => {
    it('should return false when not enough observations', () => {
      service.recordOutcome({
        parameter: 'toolTimeout',
        toolName: 'Read',
        success: true,
        value: 100,
        timestamp: Date.now(),
      });

      expect(service.shouldTune()).toBe(false);
    });

    it('should return true when enough observations', () => {
      for (let i = 0; i < 5; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      expect(service.shouldTune()).toBe(true);
    });
  });

  describe('tune', () => {
    it('should not tune when not enough observations', () => {
      service.recordOutcome({
        parameter: 'toolTimeout',
        toolName: 'Read',
        success: true,
        value: 100,
        timestamp: Date.now(),
      });

      service.tune();
      expect(service.getObservationCount()).toBe(1); // Not reset
    });

    it('should tune tool timeouts conservatively', () => {
      // Record observations with consistent values
      for (let i = 0; i < 10; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      service.tune();
      const timeout = service.getTunedValue('toolTimeout', 'Read');

      // Should be within 20% of observed value
      expect(timeout).toBeGreaterThanOrEqual(80);
      expect(timeout).toBeLessThanOrEqual(120);
    });

    it('should reset observation count after tuning', () => {
      for (let i = 0; i < 10; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      service.tune();
      expect(service.getObservationCount()).toBe(0);
    });

    it('should update lastTuned timestamp', () => {
      for (let i = 0; i < 10; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      const before = Date.now();
      service.tune();
      const params = service.getParameters();
      expect(params.lastTuned).toBeGreaterThanOrEqual(before);
    });
  });

  describe('reset', () => {
    it('should reset to defaults', () => {
      for (let i = 0; i < 10; i++) {
        service.recordOutcome({
          parameter: 'toolTimeout',
          toolName: 'Read',
          success: true,
          value: 100,
          timestamp: Date.now(),
        });
      }

      service.tune();
      service.reset();

      const params = service.getParameters();
      expect(params.compactionThreshold).toBe(180_000);
      expect(params.extractionThrottle).toBe(3);
      expect(params.observationCount).toBe(0);
    });
  });
});
