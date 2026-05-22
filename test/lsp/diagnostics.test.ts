// Tests for DiagnosticCollector

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticCollector } from '../../src/lsp/diagnostics';
import type { LSPDiagnostic } from '../../src/lsp/types';

function makeDiagnostic(severity: 1 | 2 | 3 | 4, message: string): LSPDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity,
    message,
  };
}

describe('DiagnosticCollector', () => {
  let collector: DiagnosticCollector;
  let mockClientManager: any;

  beforeEach(() => {
    mockClientManager = {
      getDiagnostics: vi.fn().mockResolvedValue([]),
    };
    collector = new DiagnosticCollector(mockClientManager);
  });

  describe('constructor', () => {
    it('should create with provided client manager', () => {
      expect(collector).toBeDefined();
    });
  });

  describe('getDiagnosticsForFile', () => {
    it('should fetch diagnostics from client manager when content is provided', async () => {
      const diagnostics = [makeDiagnostic(1, 'error')];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);

      const result = await collector.getDiagnosticsForFile('/test/file.ts', 'const x = 1;');
      expect(result).toEqual(diagnostics);
      expect(mockClientManager.getDiagnostics).toHaveBeenCalledWith('/test/file.ts', 'const x = 1;');
    });

    it('should cache diagnostics after fetching', async () => {
      const diagnostics = [makeDiagnostic(1, 'error')];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);

      await collector.getDiagnosticsForFile('/test/file.ts', 'content');
      // Second call without content should return cached
      const result = await collector.getDiagnosticsForFile('/test/file.ts');
      expect(result).toEqual(diagnostics);
      expect(mockClientManager.getDiagnostics).toHaveBeenCalledTimes(1);
    });

    it('should return empty array if no cache and no content', async () => {
      const result = await collector.getDiagnosticsForFile('/test/file.ts');
      expect(result).toEqual([]);
    });

    it('should re-fetch when content is provided even if cached', async () => {
      const diagnostics1 = [makeDiagnostic(1, 'error1')];
      const diagnostics2 = [makeDiagnostic(2, 'warning1')];
      mockClientManager.getDiagnostics
        .mockResolvedValueOnce(diagnostics1)
        .mockResolvedValueOnce(diagnostics2);

      await collector.getDiagnosticsForFile('/test/file.ts', 'content1');
      const result = await collector.getDiagnosticsForFile('/test/file.ts', 'content2');
      expect(result).toEqual(diagnostics2);
      expect(mockClientManager.getDiagnostics).toHaveBeenCalledTimes(2);
    });

    it('should increment file version on each content update', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([]);

      expect(collector.getFileVersion('/test/file.ts')).toBe(0);
      await collector.getDiagnosticsForFile('/test/file.ts', 'v1');
      expect(collector.getFileVersion('/test/file.ts')).toBe(1);
      await collector.getDiagnosticsForFile('/test/file.ts', 'v2');
      expect(collector.getFileVersion('/test/file.ts')).toBe(2);
    });
  });

  describe('getDiagnosticsForWorkspace', () => {
    it('should return empty map when no diagnostics cached', () => {
      const result = collector.getDiagnosticsForWorkspace();
      expect(result.size).toBe(0);
    });

    it('should return all diagnostics with "all" filter', async () => {
      const diagnostics = [
        makeDiagnostic(1, 'error'),
        makeDiagnostic(2, 'warning'),
        makeDiagnostic(3, 'info'),
      ];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');

      const result = collector.getDiagnosticsForWorkspace('all');
      expect(result.get('/test/file.ts')).toHaveLength(3);
    });

    it('should filter by errors only', async () => {
      const diagnostics = [
        makeDiagnostic(1, 'error'),
        makeDiagnostic(2, 'warning'),
        makeDiagnostic(3, 'info'),
      ];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');

      const result = collector.getDiagnosticsForWorkspace('errors');
      expect(result.get('/test/file.ts')).toHaveLength(1);
      expect(result.get('/test/file.ts')![0].severity).toBe(1);
    });

    it('should filter by warnings (includes errors)', async () => {
      const diagnostics = [
        makeDiagnostic(1, 'error'),
        makeDiagnostic(2, 'warning'),
        makeDiagnostic(3, 'info'),
        makeDiagnostic(4, 'hint'),
      ];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');

      const result = collector.getDiagnosticsForWorkspace('warnings');
      expect(result.get('/test/file.ts')).toHaveLength(2);
    });

    it('should exclude files with no matching diagnostics', async () => {
      mockClientManager.getDiagnostics
        .mockResolvedValueOnce([makeDiagnostic(1, 'error')])
        .mockResolvedValueOnce([makeDiagnostic(3, 'info')]);

      await collector.getDiagnosticsForFile('/test/file1.ts', 'content');
      await collector.getDiagnosticsForFile('/test/file2.ts', 'content');

      const result = collector.getDiagnosticsForWorkspace('errors');
      expect(result.has('/test/file1.ts')).toBe(true);
      expect(result.has('/test/file2.ts')).toBe(false);
    });

    it('should default to "all" filter', async () => {
      const diagnostics = [makeDiagnostic(1, 'error'), makeDiagnostic(3, 'info')];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');

      const result = collector.getDiagnosticsForWorkspace();
      expect(result.get('/test/file.ts')).toHaveLength(2);
    });
  });

  describe('invalidateFile', () => {
    it('should remove file from cache', async () => {
      const diagnostics = [makeDiagnostic(1, 'error')];
      mockClientManager.getDiagnostics.mockResolvedValue(diagnostics);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');

      collector.invalidateFile('/test/file.ts');
      const result = await collector.getDiagnosticsForFile('/test/file.ts');
      expect(result).toEqual([]);
    });

    it('should remove file version', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([]);
      await collector.getDiagnosticsForFile('/test/file.ts', 'content');
      expect(collector.getFileVersion('/test/file.ts')).toBe(1);

      collector.invalidateFile('/test/file.ts');
      expect(collector.getFileVersion('/test/file.ts')).toBe(0);
    });
  });

  describe('invalidateAll', () => {
    it('should clear all cached data', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([makeDiagnostic(1, 'err')]);
      await collector.getDiagnosticsForFile('/test/file1.ts', 'c1');
      await collector.getDiagnosticsForFile('/test/file2.ts', 'c2');

      collector.invalidateAll();
      expect(await collector.getDiagnosticsForFile('/test/file1.ts')).toEqual([]);
      expect(await collector.getDiagnosticsForFile('/test/file2.ts')).toEqual([]);
      expect(collector.getFileVersion('/test/file1.ts')).toBe(0);
    });
  });

  describe('getTotalCount', () => {
    it('should return 0 when empty', () => {
      expect(collector.getTotalCount()).toBe(0);
    });

    it('should count all diagnostics across files', async () => {
      mockClientManager.getDiagnostics
        .mockResolvedValueOnce([makeDiagnostic(1, 'e1'), makeDiagnostic(2, 'w1')])
        .mockResolvedValueOnce([makeDiagnostic(1, 'e2')]);

      await collector.getDiagnosticsForFile('/test/f1.ts', 'c');
      await collector.getDiagnosticsForFile('/test/f2.ts', 'c');

      expect(collector.getTotalCount('all')).toBe(3);
    });

    it('should count only errors with errors filter', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([
        makeDiagnostic(1, 'error'),
        makeDiagnostic(2, 'warning'),
        makeDiagnostic(3, 'info'),
      ]);
      await collector.getDiagnosticsForFile('/test/f.ts', 'c');

      expect(collector.getTotalCount('errors')).toBe(1);
    });

    it('should count errors and warnings with warnings filter', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([
        makeDiagnostic(1, 'error'),
        makeDiagnostic(2, 'warning'),
        makeDiagnostic(3, 'info'),
        makeDiagnostic(4, 'hint'),
      ]);
      await collector.getDiagnosticsForFile('/test/f.ts', 'c');

      expect(collector.getTotalCount('warnings')).toBe(2);
    });
  });

  describe('getFileVersion', () => {
    it('should return 0 for unknown file', () => {
      expect(collector.getFileVersion('/unknown.ts')).toBe(0);
    });

    it('should track versions correctly', async () => {
      mockClientManager.getDiagnostics.mockResolvedValue([]);
      await collector.getDiagnosticsForFile('/test/file.ts', 'v1');
      await collector.getDiagnosticsForFile('/test/file.ts', 'v2');
      await collector.getDiagnosticsForFile('/test/file.ts', 'v3');

      expect(collector.getFileVersion('/test/file.ts')).toBe(3);
    });
  });
});
