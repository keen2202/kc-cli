import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordExtraction,
  recordConsolidation,
  updateMemoryCounts,
  updateSessionStats,
  getTelemetry,
  formatTelemetryReport,
  resetTelemetry,
} from '../../src/memory/telemetry';

describe('telemetry', () => {
  beforeEach(() => {
    resetTelemetry();
  });

  describe('getTelemetry (initial state)', () => {
    it('should return all zeroes after reset', () => {
      const data = getTelemetry();

      expect(data.extractionsTotal).toBe(0);
      expect(data.extractionsFailed).toBe(0);
      expect(data.memoriesExtracted).toBe(0);
      expect(data.lastExtractionAt).toBe(0);
      expect(data.consolidationsTotal).toBe(0);
      expect(data.consolidationsFailed).toBe(0);
      expect(data.memoriesProcessed).toBe(0);
      expect(data.lastConsolidationAt).toBe(0);
      expect(data.memoryCountUser).toBe(0);
      expect(data.memoryCountFeedback).toBe(0);
      expect(data.memoryCountProject).toBe(0);
      expect(data.memoryCountReference).toBe(0);
      expect(data.sessionSnapshotsTotal).toBe(0);
      expect(data.sessionsArchived).toBe(0);
      expect(data.sessionsPruned).toBe(0);
      expect(data.averageExtractionTimeMs).toBe(0);
      expect(data.averageConsolidationTimeMs).toBe(0);
    });
  });

  describe('recordExtraction', () => {
    it('should record a successful extraction', () => {
      recordExtraction(true, 3, 150);

      const data = getTelemetry();
      expect(data.extractionsTotal).toBe(1);
      expect(data.extractionsFailed).toBe(0);
      expect(data.memoriesExtracted).toBe(3);
      expect(data.lastExtractionAt).toBeGreaterThan(0);
      expect(data.averageExtractionTimeMs).toBe(150);
    });

    it('should record a failed extraction', () => {
      recordExtraction(false, 0, 50);

      const data = getTelemetry();
      expect(data.extractionsTotal).toBe(1);
      expect(data.extractionsFailed).toBe(1);
      expect(data.memoriesExtracted).toBe(0);
    });

    it('should accumulate totals across multiple calls', () => {
      recordExtraction(true, 2, 100);
      recordExtraction(true, 5, 200);
      recordExtraction(false, 0, 50);

      const data = getTelemetry();
      expect(data.extractionsTotal).toBe(3);
      expect(data.extractionsFailed).toBe(1);
      expect(data.memoriesExtracted).toBe(7);
    });

    it('should compute running average extraction time', () => {
      recordExtraction(true, 1, 100);
      recordExtraction(true, 1, 200);
      recordExtraction(true, 1, 300);

      const data = getTelemetry();
      expect(data.averageExtractionTimeMs).toBe(200);
    });

    it('should update lastExtractionAt to the most recent call', () => {
      const before = Date.now();
      recordExtraction(true, 1, 100);
      const after = Date.now();

      const data = getTelemetry();
      expect(data.lastExtractionAt).toBeGreaterThanOrEqual(before);
      expect(data.lastExtractionAt).toBeLessThanOrEqual(after);
    });

    it('should not add memoriesExtracted for failed extractions', () => {
      recordExtraction(false, 5, 100);

      const data = getTelemetry();
      expect(data.memoriesExtracted).toBe(0);
    });
  });

  describe('recordConsolidation', () => {
    it('should record a successful consolidation', () => {
      recordConsolidation(true, 10, 500);

      const data = getTelemetry();
      expect(data.consolidationsTotal).toBe(1);
      expect(data.consolidationsFailed).toBe(0);
      expect(data.memoriesProcessed).toBe(10);
      expect(data.lastConsolidationAt).toBeGreaterThan(0);
      expect(data.averageConsolidationTimeMs).toBe(500);
    });

    it('should record a failed consolidation', () => {
      recordConsolidation(false, 0, 100);

      const data = getTelemetry();
      expect(data.consolidationsTotal).toBe(1);
      expect(data.consolidationsFailed).toBe(1);
    });

    it('should accumulate memoriesProcessed even for failed consolidations', () => {
      recordConsolidation(false, 5, 100);

      const data = getTelemetry();
      expect(data.memoriesProcessed).toBe(5);
    });

    it('should compute running average consolidation time', () => {
      recordConsolidation(true, 1, 100);
      recordConsolidation(true, 1, 300);

      const data = getTelemetry();
      expect(data.averageConsolidationTimeMs).toBe(200);
    });

    it('should update lastConsolidationAt', () => {
      const before = Date.now();
      recordConsolidation(true, 1, 100);
      const after = Date.now();

      const data = getTelemetry();
      expect(data.lastConsolidationAt).toBeGreaterThanOrEqual(before);
      expect(data.lastConsolidationAt).toBeLessThanOrEqual(after);
    });
  });

  describe('updateMemoryCounts', () => {
    it('should update memory counts by type', () => {
      updateMemoryCounts({ user: 5, feedback: 3, project: 7, reference: 2 });

      const data = getTelemetry();
      expect(data.memoryCountUser).toBe(5);
      expect(data.memoryCountFeedback).toBe(3);
      expect(data.memoryCountProject).toBe(7);
      expect(data.memoryCountReference).toBe(2);
    });

    it('should overwrite previous counts', () => {
      updateMemoryCounts({ user: 5, feedback: 3, project: 7, reference: 2 });
      updateMemoryCounts({ user: 10, feedback: 0, project: 1, reference: 99 });

      const data = getTelemetry();
      expect(data.memoryCountUser).toBe(10);
      expect(data.memoryCountFeedback).toBe(0);
      expect(data.memoryCountProject).toBe(1);
      expect(data.memoryCountReference).toBe(99);
    });
  });

  describe('updateSessionStats', () => {
    it('should update session stats', () => {
      updateSessionStats({ total: 20, archived: 5, pruned: 3 });

      const data = getTelemetry();
      expect(data.sessionSnapshotsTotal).toBe(20);
      expect(data.sessionsArchived).toBe(5);
      expect(data.sessionsPruned).toBe(3);
    });

    it('should overwrite previous session stats', () => {
      updateSessionStats({ total: 20, archived: 5, pruned: 3 });
      updateSessionStats({ total: 0, archived: 0, pruned: 0 });

      const data = getTelemetry();
      expect(data.sessionSnapshotsTotal).toBe(0);
      expect(data.sessionsArchived).toBe(0);
      expect(data.sessionsPruned).toBe(0);
    });
  });

  describe('formatTelemetryReport', () => {
    it('should format a report with initial state', () => {
      const report = formatTelemetryReport();

      expect(report).toContain('Memory System Telemetry');
      expect(report).toContain('Extraction');
      expect(report).toContain('Consolidation');
      expect(report).toContain('Memory Counts');
      expect(report).toContain('Sessions');
      expect(report).toContain('Total extractions: 0');
    });

    it('should include extraction stats after recording', () => {
      recordExtraction(true, 5, 200);
      recordExtraction(false, 0, 100);

      const report = formatTelemetryReport();
      expect(report).toContain('Total extractions: 2');
      expect(report).toContain('Failed extractions: 1');
      expect(report).toContain('Memories extracted: 5');
      expect(report).toContain('Average extraction time: 150ms');
    });

    it('should include consolidation stats', () => {
      recordConsolidation(true, 10, 300);

      const report = formatTelemetryReport();
      expect(report).toContain('Total consolidations: 1');
      expect(report).toContain('Memories processed: 10');
      expect(report).toContain('Average consolidation time: 300ms');
    });

    it('should include memory counts and computed total', () => {
      updateMemoryCounts({ user: 5, feedback: 3, project: 7, reference: 2 });

      const report = formatTelemetryReport();
      expect(report).toContain('User: 5');
      expect(report).toContain('Feedback: 3');
      expect(report).toContain('Project: 7');
      expect(report).toContain('Reference: 2');
      expect(report).toContain('Total: 17');
    });

    it('should include session stats', () => {
      updateSessionStats({ total: 10, archived: 3, pruned: 2 });

      const report = formatTelemetryReport();
      expect(report).toContain('Snapshots: 10');
      expect(report).toContain('Archived: 3');
      expect(report).toContain('Pruned: 2');
    });

    it('should show "Never" for timestamps when no extractions/consolidations', () => {
      const report = formatTelemetryReport();
      expect(report).toContain('Last extraction: Never');
      expect(report).toContain('Last consolidation: Never');
    });

    it('should show ISO date for timestamps when recorded', () => {
      recordExtraction(true, 1, 100);
      recordConsolidation(true, 1, 100);

      const report = formatTelemetryReport();
      // Should contain an ISO date string (contains 'T' and 'Z')
      expect(report).not.toContain('Last extraction: Never');
      expect(report).not.toContain('Last consolidation: Never');
    });
  });

  describe('resetTelemetry', () => {
    it('should reset all telemetry data to initial state', () => {
      recordExtraction(true, 5, 200);
      recordConsolidation(true, 10, 500);
      updateMemoryCounts({ user: 5, feedback: 3, project: 7, reference: 2 });
      updateSessionStats({ total: 20, archived: 5, pruned: 3 });

      resetTelemetry();

      const data = getTelemetry();
      expect(data.extractionsTotal).toBe(0);
      expect(data.extractionsFailed).toBe(0);
      expect(data.memoriesExtracted).toBe(0);
      expect(data.lastExtractionAt).toBe(0);
      expect(data.consolidationsTotal).toBe(0);
      expect(data.consolidationsFailed).toBe(0);
      expect(data.memoriesProcessed).toBe(0);
      expect(data.lastConsolidationAt).toBe(0);
      expect(data.memoryCountUser).toBe(0);
      expect(data.memoryCountFeedback).toBe(0);
      expect(data.memoryCountProject).toBe(0);
      expect(data.memoryCountReference).toBe(0);
      expect(data.sessionSnapshotsTotal).toBe(0);
      expect(data.sessionsArchived).toBe(0);
      expect(data.sessionsPruned).toBe(0);
      expect(data.averageExtractionTimeMs).toBe(0);
      expect(data.averageConsolidationTimeMs).toBe(0);
    });

    it('should reset running averages', () => {
      recordExtraction(true, 1, 100);
      recordExtraction(true, 1, 300);

      resetTelemetry();
      recordExtraction(true, 1, 50);

      const data = getTelemetry();
      expect(data.averageExtractionTimeMs).toBe(50);
    });
  });

  describe('getTelemetry returns a copy', () => {
    it('should not allow mutation of internal state', () => {
      recordExtraction(true, 5, 200);

      const data = getTelemetry();
      data.extractionsTotal = 999;

      const fresh = getTelemetry();
      expect(fresh.extractionsTotal).toBe(1);
    });
  });
});
