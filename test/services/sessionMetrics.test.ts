import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionMetricsCollector } from '../../src/services/sessionMetrics';

// Mock fs for persistence tests
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

describe('SessionMetricsCollector', () => {
  let collector: SessionMetricsCollector;

  beforeEach(() => {
    collector = new SessionMetricsCollector('test-session-123');
    vi.clearAllMocks();
  });

  describe('recordToolCall', () => {
    it('should record successful tool call', () => {
      collector.recordToolCall('Read', true, 100);

      const metrics = collector.getToolMetrics('Read');
      expect(metrics).not.toBeNull();
      expect(metrics!.totalCalls).toBe(1);
      expect(metrics!.successCount).toBe(1);
      expect(metrics!.failureCount).toBe(0);
      expect(metrics!.avgExecutionMs).toBe(100);
    });

    it('should record failed tool call', () => {
      collector.recordToolCall('Bash', false, 500);

      const metrics = collector.getToolMetrics('Bash');
      expect(metrics!.failureCount).toBe(1);
      expect(metrics!.successCount).toBe(0);
    });

    it('should calculate average execution time', () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Read', true, 200);
      collector.recordToolCall('Read', true, 300);

      const metrics = collector.getToolMetrics('Read');
      expect(metrics!.avgExecutionMs).toBe(200); // (100+200+300)/3
    });

    it('should track multiple tools', () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Write', true, 200);
      collector.recordToolCall('Bash', false, 300);

      const allMetrics = collector.getAllToolMetrics();
      expect(allMetrics.length).toBe(3);
    });
  });

  describe('tool timers', () => {
    it('should time tool execution', () => {
      collector.startToolTimer('Read');
      // Simulate some work
      const metrics = collector.getMetrics();
      collector.endToolTimer('Read', true);

      const toolMetrics = collector.getToolMetrics('Read');
      expect(toolMetrics).not.toBeNull();
      expect(toolMetrics!.totalCalls).toBe(1);
    });
  });

  describe('recordCommand', () => {
    it('should record unique commands', () => {
      collector.recordCommand('/help');
      collector.recordCommand('/clear');
      collector.recordCommand('/help'); // Duplicate

      const metrics = collector.getMetrics();
      expect(metrics.session.commandsUsed).toEqual(['/help', '/clear']);
    });
  });

  describe('recordTurn', () => {
    it('should increment turn count', () => {
      collector.recordTurn();
      collector.recordTurn();
      collector.recordTurn();

      const metrics = collector.getMetrics();
      expect(metrics.session.turnCount).toBe(3);
    });
  });

  describe('recordError', () => {
    it('should increment error count', () => {
      collector.recordError();
      collector.recordError();

      const metrics = collector.getMetrics();
      expect(metrics.session.errorCount).toBe(2);
    });
  });

  describe('recordCompact', () => {
    it('should increment compact count', () => {
      collector.recordCompact();

      const metrics = collector.getMetrics();
      expect(metrics.session.compactCount).toBe(1);
    });
  });

  describe('endSession', () => {
    it('should set end time', () => {
      collector.endSession();

      const metrics = collector.getMetrics();
      expect(metrics.session.endTime).not.toBeNull();
      expect(metrics.session.endTime!).toBeGreaterThanOrEqual(metrics.session.startTime);
    });
  });

  describe('getSessionDuration', () => {
    it('should calculate duration for active session', () => {
      const duration = collector.getSessionDuration();
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('should calculate duration for ended session', () => {
      collector.endSession();
      const duration = collector.getSessionDuration();
      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMostUsedTools', () => {
    it('should return tools sorted by usage', () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Write', true, 100);
      collector.recordToolCall('Write', true, 100);
      collector.recordToolCall('Bash', true, 100);

      const mostUsed = collector.getMostUsedTools(2);
      expect(mostUsed.length).toBe(2);
      expect(mostUsed[0].toolName).toBe('Read');
      expect(mostUsed[1].toolName).toBe('Write');
    });
  });

  describe('getMostFailingTools', () => {
    it('should return tools with highest failure rate', () => {
      // Tool with high failure rate
      collector.recordToolCall('Bash', false, 100);
      collector.recordToolCall('Bash', false, 100);
      collector.recordToolCall('Bash', true, 100);

      // Tool with no failures
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Read', true, 100);

      const mostFailing = collector.getMostFailingTools(1);
      expect(mostFailing.length).toBe(1);
      expect(mostFailing[0].toolName).toBe('Bash');
    });

    it('should filter tools with insufficient data', () => {
      // Only 2 calls (below threshold of 3)
      collector.recordToolCall('RareTool', false, 100);
      collector.recordToolCall('RareTool', false, 100);

      const mostFailing = collector.getMostFailingTools();
      expect(mostFailing.find(t => t.toolName === 'RareTool')).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should reset all metrics', () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordTurn();
      collector.recordError();
      collector.recordCommand('/help');

      collector.reset();

      const metrics = collector.getMetrics();
      expect(metrics.session.turnCount).toBe(0);
      expect(metrics.session.errorCount).toBe(0);
      expect(metrics.session.toolCalls).toBe(0);
      expect(metrics.tools.size).toBe(0);
    });
  });
});
