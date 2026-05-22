import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import { SessionMetricsCollector } from '../../src/services/sessionMetrics';

// Mock fs for persistence tests
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import * as fs from 'fs/promises';

describe('SessionMetricsCollector - Coverage Tests', () => {
  let collector: SessionMetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new SessionMetricsCollector('coverage-test-session');
  });

  describe('constructor', () => {
    it('should initialize with correct session id', () => {
      const metrics = collector.getMetrics();
      expect(metrics.session.sessionId).toBe('coverage-test-session');
    });

    it('should initialize with zero counts', () => {
      const metrics = collector.getMetrics();
      expect(metrics.session.turnCount).toBe(0);
      expect(metrics.session.toolCalls).toBe(0);
      expect(metrics.session.errorCount).toBe(0);
      expect(metrics.session.compactCount).toBe(0);
      expect(metrics.session.commandsUsed).toEqual([]);
    });

    it('should initialize with null end time', () => {
      const metrics = collector.getMetrics();
      expect(metrics.session.endTime).toBeNull();
    });

    it('should set start time to current time', () => {
      const before = Date.now();
      const c = new SessionMetricsCollector('test');
      const after = Date.now();
      const metrics = c.getMetrics();
      expect(metrics.session.startTime).toBeGreaterThanOrEqual(before);
      expect(metrics.session.startTime).toBeLessThanOrEqual(after);
    });
  });

  describe('recordToolCall - edge cases', () => {
    it('should handle zero execution time', () => {
      collector.recordToolCall('FastTool', true, 0);
      const metrics = collector.getToolMetrics('FastTool');
      expect(metrics!.avgExecutionMs).toBe(0);
    });

    it('should handle very large execution time', () => {
      collector.recordToolCall('SlowTool', true, 999999);
      const metrics = collector.getToolMetrics('SlowTool');
      expect(metrics!.avgExecutionMs).toBe(999999);
    });

    it('should update lastUsed timestamp on each call', () => {
      collector.recordToolCall('Read', true, 100);
      const firstLastUsed = collector.getToolMetrics('Read')!.lastUsed;

      collector.recordToolCall('Read', true, 200);
      const secondLastUsed = collector.getToolMetrics('Read')!.lastUsed;

      expect(secondLastUsed).toBeGreaterThanOrEqual(firstLastUsed);
    });

    it('should increment totalCalls for each call', () => {
      collector.recordToolCall('Bash', true, 100);
      collector.recordToolCall('Bash', false, 200);
      collector.recordToolCall('Bash', true, 300);

      const metrics = collector.getToolMetrics('Bash');
      expect(metrics!.totalCalls).toBe(3);
      expect(metrics!.successCount).toBe(2);
      expect(metrics!.failureCount).toBe(1);
    });

    it('should track toolCalls count on session', () => {
      collector.recordToolCall('A', true, 10);
      collector.recordToolCall('B', false, 20);
      collector.recordToolCall('C', true, 30);

      const metrics = collector.getMetrics();
      expect(metrics.session.toolCalls).toBe(3);
    });
  });

  describe('startToolTimer and endToolTimer', () => {
    it('should handle endToolTimer when no timer was started', () => {
      // endToolTimer with no matching start should be a no-op
      collector.endToolTimer('NonExistent', true);

      const metrics = collector.getToolMetrics('NonExistent');
      expect(metrics).toBeNull();
    });

    it('should not affect other timers when ending one', () => {
      collector.startToolTimer('ToolA');
      collector.startToolTimer('ToolB');

      collector.endToolTimer('ToolA', true);

      // ToolB timer should still be active (not ended)
      const toolA = collector.getToolMetrics('ToolA');
      expect(toolA).not.toBeNull();
      expect(toolA!.totalCalls).toBe(1);
    });

    it('should delete timer after ending', () => {
      collector.startToolTimer('Read');
      collector.endToolTimer('Read', true);

      // Ending again should be a no-op
      collector.endToolTimer('Read', false);
      const metrics = collector.getToolMetrics('Read');
      expect(metrics!.totalCalls).toBe(1);
    });

    it('should record success correctly from timer', () => {
      collector.startToolTimer('Read');
      collector.endToolTimer('Read', true);

      const metrics = collector.getToolMetrics('Read');
      expect(metrics!.successCount).toBe(1);
      expect(metrics!.failureCount).toBe(0);
    });

    it('should record failure correctly from timer', () => {
      collector.startToolTimer('Bash');
      collector.endToolTimer('Bash', false);

      const metrics = collector.getToolMetrics('Bash');
      expect(metrics!.successCount).toBe(0);
      expect(metrics!.failureCount).toBe(1);
    });
  });

  describe('getToolMetrics', () => {
    it('should return null for non-existent tool', () => {
      expect(collector.getToolMetrics('DoesNotExist')).toBeNull();
    });

    it('should return metrics for existing tool', () => {
      collector.recordToolCall('Read', true, 100);
      const metrics = collector.getToolMetrics('Read');
      expect(metrics).not.toBeNull();
      expect(metrics!.toolName).toBe('Read');
    });
  });

  describe('getAllToolMetrics', () => {
    it('should return empty array when no tools recorded', () => {
      expect(collector.getAllToolMetrics()).toEqual([]);
    });

    it('should return all recorded tools', () => {
      collector.recordToolCall('A', true, 10);
      collector.recordToolCall('B', true, 20);
      collector.recordToolCall('C', true, 30);

      const all = collector.getAllToolMetrics();
      expect(all.length).toBe(3);
      expect(all.map(t => t.toolName).sort()).toEqual(['A', 'B', 'C']);
    });
  });

  describe('getMostUsedTools', () => {
    it('should return empty array when no tools', () => {
      expect(collector.getMostUsedTools()).toEqual([]);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        collector.recordToolCall(`Tool${i}`, true, 100);
      }

      const limited = collector.getMostUsedTools(3);
      expect(limited.length).toBe(3);
    });

    it('should default to 5 as limit', () => {
      for (let i = 0; i < 10; i++) {
        collector.recordToolCall(`Tool${i}`, true, 100);
      }

      const defaultLimit = collector.getMostUsedTools();
      expect(defaultLimit.length).toBe(5);
    });

    it('should handle limit larger than available tools', () => {
      collector.recordToolCall('Only', true, 100);

      const result = collector.getMostUsedTools(10);
      expect(result.length).toBe(1);
    });
  });

  describe('getMostFailingTools', () => {
    it('should return empty when no tools meet threshold', () => {
      collector.recordToolCall('Rare', false, 100);
      collector.recordToolCall('Rare', false, 100);

      // Only 2 calls, below threshold of 3
      const result = collector.getMostFailingTools();
      expect(result).toEqual([]);
    });

    it('should sort by failure rate descending', () => {
      // Tool with 50% failure rate
      collector.recordToolCall('HalfFail', true, 100);
      collector.recordToolCall('HalfFail', false, 100);
      collector.recordToolCall('HalfFail', true, 100);
      collector.recordToolCall('HalfFail', false, 100);

      // Tool with 100% failure rate
      collector.recordToolCall('AllFail', false, 100);
      collector.recordToolCall('AllFail', false, 100);
      collector.recordToolCall('AllFail', false, 100);

      const result = collector.getMostFailingTools(2);
      expect(result[0].toolName).toBe('AllFail');
      expect(result[1].toolName).toBe('HalfFail');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        collector.recordToolCall(`Fail${i}`, false, 100);
        collector.recordToolCall(`Fail${i}`, false, 100);
        collector.recordToolCall(`Fail${i}`, false, 100);
      }

      const result = collector.getMostFailingTools(2);
      expect(result.length).toBe(2);
    });

    it('should default to 5 as limit', () => {
      for (let i = 0; i < 8; i++) {
        collector.recordToolCall(`Fail${i}`, false, 100);
        collector.recordToolCall(`Fail${i}`, false, 100);
        collector.recordToolCall(`Fail${i}`, false, 100);
      }

      const result = collector.getMostFailingTools();
      expect(result.length).toBe(5);
    });
  });

  describe('getMetrics', () => {
    it('should return a copy of session data', () => {
      const metrics1 = collector.getMetrics();
      const metrics2 = collector.getMetrics();

      // Should be equal but not the same reference
      expect(metrics1.session).toEqual(metrics2.session);
      expect(metrics1.session).not.toBe(metrics2.session);
    });

    it('should return a copy of tools map', () => {
      collector.recordToolCall('Read', true, 100);
      const metrics1 = collector.getMetrics();
      const metrics2 = collector.getMetrics();

      expect(metrics1.tools).not.toBe(metrics2.tools);
      expect(metrics1.tools.size).toBe(metrics2.tools.size);
    });

    it('should reflect all recorded data', () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordTurn();
      collector.recordError();
      collector.recordCommand('/test');
      collector.recordCompact();

      const metrics = collector.getMetrics();
      expect(metrics.session.toolCalls).toBe(1);
      expect(metrics.session.turnCount).toBe(1);
      expect(metrics.session.errorCount).toBe(1);
      expect(metrics.session.commandsUsed).toEqual(['/test']);
      expect(metrics.session.compactCount).toBe(1);
      expect(metrics.tools.size).toBe(1);
    });
  });

  describe('getSessionDuration', () => {
    it('should return non-negative for active session', () => {
      expect(collector.getSessionDuration()).toBeGreaterThanOrEqual(0);
    });

    it('should use endTime when session is ended', () => {
      collector.endSession();
      const duration = collector.getSessionDuration();
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('should use Date.now() when session is active', () => {
      const before = Date.now();
      const duration = collector.getSessionDuration();
      const after = Date.now();

      // Duration should be between 0 and the time it took to execute
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThanOrEqual(after - before + 10); // +10 for timing tolerance
    });
  });

  describe('recordCommand', () => {
    it('should not add duplicate commands', () => {
      collector.recordCommand('/help');
      collector.recordCommand('/help');
      collector.recordCommand('/help');

      const metrics = collector.getMetrics();
      expect(metrics.session.commandsUsed).toEqual(['/help']);
    });

    it('should track multiple unique commands', () => {
      collector.recordCommand('/help');
      collector.recordCommand('/clear');
      collector.recordCommand('/compact');
      collector.recordCommand('/exit');

      const metrics = collector.getMetrics();
      expect(metrics.session.commandsUsed).toEqual(['/help', '/clear', '/compact', '/exit']);
    });
  });

  describe('recordTurn', () => {
    it('should increment from zero', () => {
      collector.recordTurn();
      expect(collector.getMetrics().session.turnCount).toBe(1);
    });

    it('should increment multiple times', () => {
      for (let i = 0; i < 100; i++) {
        collector.recordTurn();
      }
      expect(collector.getMetrics().session.turnCount).toBe(100);
    });
  });

  describe('recordError', () => {
    it('should increment from zero', () => {
      collector.recordError();
      expect(collector.getMetrics().session.errorCount).toBe(1);
    });

    it('should accumulate', () => {
      collector.recordError();
      collector.recordError();
      collector.recordError();
      expect(collector.getMetrics().session.errorCount).toBe(3);
    });
  });

  describe('recordCompact', () => {
    it('should increment from zero', () => {
      collector.recordCompact();
      expect(collector.getMetrics().session.compactCount).toBe(1);
    });

    it('should accumulate', () => {
      for (let i = 0; i < 5; i++) {
        collector.recordCompact();
      }
      expect(collector.getMetrics().session.compactCount).toBe(5);
    });
  });

  describe('endSession', () => {
    it('should set endTime to a valid timestamp', () => {
      const before = Date.now();
      collector.endSession();
      const after = Date.now();

      const metrics = collector.getMetrics();
      expect(metrics.session.endTime).not.toBeNull();
      expect(metrics.session.endTime!).toBeGreaterThanOrEqual(before);
      expect(metrics.session.endTime!).toBeLessThanOrEqual(after);
    });

    it('should not change other session data', () => {
      collector.recordTurn();
      collector.recordError();
      collector.recordToolCall('Read', true, 100);

      collector.endSession();

      const metrics = collector.getMetrics();
      expect(metrics.session.turnCount).toBe(1);
      expect(metrics.session.errorCount).toBe(1);
      expect(metrics.session.toolCalls).toBe(1);
    });
  });

  describe('reset', () => {
    it('should preserve session id after reset', () => {
      collector.recordTurn();
      collector.reset();

      const metrics = collector.getMetrics();
      expect(metrics.session.sessionId).toBe('coverage-test-session');
    });

    it('should reset start time', () => {
      const beforeReset = Date.now();
      collector.reset();
      const afterReset = Date.now();

      const metrics = collector.getMetrics();
      expect(metrics.session.startTime).toBeGreaterThanOrEqual(beforeReset);
      expect(metrics.session.startTime).toBeLessThanOrEqual(afterReset);
    });

    it('should clear all tools', () => {
      collector.recordToolCall('A', true, 10);
      collector.recordToolCall('B', false, 20);
      collector.recordToolCall('C', true, 30);

      collector.reset();

      expect(collector.getAllToolMetrics()).toEqual([]);
      expect(collector.getMetrics().tools.size).toBe(0);
    });

    it('should reset endTime to null', () => {
      collector.endSession();
      collector.reset();

      expect(collector.getMetrics().session.endTime).toBeNull();
    });
  });

  describe('persist', () => {
    it('should write metrics to file', async () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordTurn();

      await collector.persist();

      const homeDir = os.homedir();
      expect(fs.mkdir).toHaveBeenCalledWith(`${homeDir}/.kc-cli/metrics`, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${homeDir}/.kc-cli/metrics/coverage-test-session.json`,
        expect.any(String),
        'utf-8'
      );
    });

    it('should serialize tools as object entries', async () => {
      collector.recordToolCall('Read', true, 100);
      collector.recordToolCall('Bash', false, 200);

      await collector.persist();

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const data = JSON.parse(writeCall[1]);

      expect(data.tools).toBeDefined();
      expect(data.tools.Read).toBeDefined();
      expect(data.tools.Bash).toBeDefined();
      expect(data.tools.Read.totalCalls).toBe(1);
      expect(data.tools.Bash.failureCount).toBe(1);
    });

    it('should include session data in persisted file', async () => {
      collector.recordTurn();
      collector.recordError();

      await collector.persist();

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const data = JSON.parse(writeCall[1]);

      expect(data.session.sessionId).toBe('coverage-test-session');
      expect(data.session.turnCount).toBe(1);
      expect(data.session.errorCount).toBe(1);
    });
  });

  describe('SessionMetricsCollector.load', () => {
    it('should load metrics from file', async () => {
      const mockData = {
        session: {
          sessionId: 'loaded-session',
          startTime: 1000,
          endTime: 2000,
          turnCount: 5,
          toolCalls: 10,
          commandsUsed: ['/help'],
          errorCount: 1,
          compactCount: 0,
        },
        tools: {
          Read: {
            toolName: 'Read',
            totalCalls: 10,
            successCount: 9,
            failureCount: 1,
            avgExecutionMs: 50,
            lastUsed: 2000,
          },
        },
      };

      (fs.readFile as any).mockResolvedValue(JSON.stringify(mockData));

      const result = await SessionMetricsCollector.load('loaded-session');

      expect(result).not.toBeNull();
      expect(result!.session.sessionId).toBe('loaded-session');
      expect(result!.session.turnCount).toBe(5);
      expect(result!.tools.size).toBe(1);
      expect(result!.tools.get('Read')!.totalCalls).toBe(10);
    });

    it('should return null when file not found', async () => {
      (fs.readFile as any).mockRejectedValue({ code: 'ENOENT' });

      const result = await SessionMetricsCollector.load('non-existent');

      expect(result).toBeNull();
    });

    it('should return null when file has invalid JSON', async () => {
      (fs.readFile as any).mockResolvedValue('not valid json');

      const result = await SessionMetricsCollector.load('invalid');

      expect(result).toBeNull();
    });

    it('should handle missing tools in loaded data', async () => {
      const mockData = {
        session: {
          sessionId: 'no-tools',
          startTime: 1000,
          endTime: null,
          turnCount: 0,
          toolCalls: 0,
          commandsUsed: [],
          errorCount: 0,
          compactCount: 0,
        },
      };

      (fs.readFile as any).mockResolvedValue(JSON.stringify(mockData));

      const result = await SessionMetricsCollector.load('no-tools');

      expect(result).not.toBeNull();
      expect(result!.tools.size).toBe(0);
    });

    it('should load tools into a Map', async () => {
      const mockData = {
        session: { sessionId: 'test' },
        tools: {
          Bash: { toolName: 'Bash', totalCalls: 5, successCount: 3, failureCount: 2, avgExecutionMs: 100, lastUsed: 1000 },
          Write: { toolName: 'Write', totalCalls: 2, successCount: 2, failureCount: 0, avgExecutionMs: 50, lastUsed: 900 },
        },
      };

      (fs.readFile as any).mockResolvedValue(JSON.stringify(mockData));

      const result = await SessionMetricsCollector.load('test');

      expect(result!.tools).toBeInstanceOf(Map);
      expect(result!.tools.get('Bash')).toEqual(mockData.tools.Bash);
      expect(result!.tools.get('Write')).toEqual(mockData.tools.Write);
    });
  });

  describe('SessionMetricsCollector.listSessions', () => {
    it('should return session ids from directory listing', async () => {
      (fs.readdir as any).mockResolvedValue([
        'session-1.json',
        'session-2.json',
        'session-3.json',
        'not-json.txt',
      ]);

      const sessions = await SessionMetricsCollector.listSessions();

      expect(sessions).toEqual(['session-1', 'session-2', 'session-3']);
    });

    it('should return empty array when directory does not exist', async () => {
      (fs.readdir as any).mockRejectedValue({ code: 'ENOENT' });

      const sessions = await SessionMetricsCollector.listSessions();

      expect(sessions).toEqual([]);
    });

    it('should return empty array for empty directory', async () => {
      (fs.readdir as any).mockResolvedValue([]);

      const sessions = await SessionMetricsCollector.listSessions();

      expect(sessions).toEqual([]);
    });

    it('should filter out non-json files', async () => {
      (fs.readdir as any).mockResolvedValue([
        'valid.json',
        'readme.md',
        '.gitignore',
        'another.json',
      ]);

      const sessions = await SessionMetricsCollector.listSessions();

      expect(sessions).toEqual(['valid', 'another']);
    });
  });

  describe('aggregation over multiple turns', () => {
    it('should correctly aggregate metrics across a full session', () => {
      // Simulate a complete session
      collector.recordTurn(); // Turn 1
      collector.recordToolCall('Read', true, 50);
      collector.recordToolCall('Bash', true, 200);
      collector.recordCommand('/help');

      collector.recordTurn(); // Turn 2
      collector.recordToolCall('Read', true, 75);
      collector.recordToolCall('Write', true, 150);
      collector.recordError();

      collector.recordTurn(); // Turn 3
      collector.recordToolCall('Bash', false, 300);
      collector.recordToolCall('Read', true, 60);
      collector.recordCompact();
      collector.recordCommand('/clear');

      const metrics = collector.getMetrics();

      expect(metrics.session.turnCount).toBe(3);
      expect(metrics.session.toolCalls).toBe(6);
      expect(metrics.session.errorCount).toBe(1);
      expect(metrics.session.compactCount).toBe(1);
      expect(metrics.session.commandsUsed).toEqual(['/help', '/clear']);
      expect(metrics.tools.size).toBe(3);

      // Verify Read tool: 3 calls, all success, avg = (50+75+60)/3 = 61.67
      const readMetrics = collector.getToolMetrics('Read');
      expect(readMetrics!.totalCalls).toBe(3);
      expect(readMetrics!.successCount).toBe(3);
      expect(readMetrics!.failureCount).toBe(0);
      expect(readMetrics!.avgExecutionMs).toBeCloseTo(61.67, 0);

      // Verify Bash: 2 calls, 1 success, 1 failure
      const bashMetrics = collector.getToolMetrics('Bash');
      expect(bashMetrics!.totalCalls).toBe(2);
      expect(bashMetrics!.successCount).toBe(1);
      expect(bashMetrics!.failureCount).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty tool name', () => {
      collector.recordToolCall('', true, 100);
      const metrics = collector.getToolMetrics('');
      expect(metrics).not.toBeNull();
      expect(metrics!.toolName).toBe('');
    });

    it('should handle negative execution time', () => {
      collector.recordToolCall('Timer', true, -50);
      const metrics = collector.getToolMetrics('Timer');
      expect(metrics!.avgExecutionMs).toBe(-50);
    });

    it('should handle very long tool name', () => {
      const longName = 'A'.repeat(1000);
      collector.recordToolCall(longName, true, 100);
      expect(collector.getToolMetrics(longName)).not.toBeNull();
    });

    it('should handle special characters in command names', () => {
      collector.recordCommand('/test --flag="value"');
      collector.recordCommand('/path/to/something');

      const metrics = collector.getMetrics();
      expect(metrics.session.commandsUsed).toEqual(['/test --flag="value"', '/path/to/something']);
    });
  });
});
