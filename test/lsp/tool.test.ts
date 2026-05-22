// Tests for LSP Tool

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies before importing
const mockGetDiagnosticsForFile = vi.fn().mockResolvedValue([]);
const mockGetHover = vi.fn().mockResolvedValue(null);
const mockGetDefinition = vi.fn().mockResolvedValue([]);
const mockConnect = vi.fn().mockResolvedValue(true);
const mockRequest = vi.fn().mockResolvedValue(null);

vi.mock('../../src/lsp/diagnostics', () => ({
  DiagnosticCollector: class {
    getDiagnosticsForFile = mockGetDiagnosticsForFile;
  },
}));

vi.mock('../../src/lsp/client', () => ({
  LSPClientManager: class {
    connect = mockConnect;
    getHover = mockGetHover;
    getDefinition = mockGetDefinition;
    request = mockRequest;
  },
  detectLanguage: vi.fn().mockReturnValue('typescript'),
}));

// We need to import the tool module fresh each time to reset the singleton instances
// We'll use dynamic import in beforeEach

describe('LSP Tool', () => {
  let tool: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Re-import to get fresh module with reset singletons
    // We need to reset the module registry to get fresh singletons
    vi.resetModules();
    const mod = await import('../../src/lsp/tool');
    tool = mod.tool;
  });

  describe('tool definition', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('LSP');
    });

    it('should have a description', () => {
      expect(tool.description).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
    });

    it('should be read-only', () => {
      expect(tool.isReadOnly()).toBe(true);
    });

    it('should be concurrency safe', () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });

    it('should have a prompt', () => {
      const prompt = tool.prompt({ input: { action: 'diagnostics', filePath: '/test.ts' } });
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
    });

    it('should have a getToolUseSummary', () => {
      const summary = tool.getToolUseSummary({ action: 'diagnostics', filePath: '/test.ts' });
      expect(summary).toBe('LSP diagnostics: /test.ts');
    });

    it('should have an getActivityDescription', () => {
      const desc = tool.getActivityDescription({ action: 'hover', filePath: '/test.ts' });
      expect(desc).toBe('Querying LSP for hover on /test.ts');
    });
  });

  describe('checkPermissions', () => {
    it('should allow all operations', () => {
      const result = tool.checkPermissions(
        { action: 'diagnostics', filePath: '/test.ts' },
        { cwd: '/workspace' }
      );
      expect(result.behavior).toBe('allow');
      expect(result.decisionReason.type).toBe('readonly');
    });
  });

  describe('call - diagnostics', () => {
    it('should return no diagnostics message when empty', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/workspace/test.ts', severity: 'all' },
        context
      );

      expect(result.isError).toBe(false);
      expect(result.output).toBe('No diagnostics found.');
      expect(result.metadata).toEqual({ filePath: '/workspace/test.ts', count: 0 });
    });

    it('should format diagnostics when present', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, severity: 1, message: 'Cannot find name "x"', source: 'typescript' },
        { range: { start: { line: 3, character: 5 }, end: { line: 3, character: 8 } }, severity: 2, message: 'Unused variable', source: 'tslint', code: 'no-unused' },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/workspace/test.ts', severity: 'all' },
        context
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain('[Error]');
      expect(result.output).toContain('[Warning]');
      expect(result.metadata?.count).toBe(2);
    });

    it('should filter by errors severity', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'error' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: 'warning' },
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, severity: 3, message: 'info' },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/workspace/test.ts', severity: 'errors' },
        context
      );

      expect(result.metadata?.count).toBe(1);
    });

    it('should filter by warnings severity (includes errors)', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'error' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: 'warning' },
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, severity: 3, message: 'info' },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/workspace/test.ts', severity: 'warnings' },
        context
      );

      expect(result.metadata?.count).toBe(2);
    });

    it('should handle absolute file paths', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/absolute/path/file.ts', severity: 'all' },
        context
      );

      expect(result.metadata?.filePath).toBe('/absolute/path/file.ts');
    });

    it('should handle relative file paths by prepending cwd', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: 'relative/file.ts', severity: 'all' },
        context
      );

      expect(result.metadata?.filePath).toBe('/workspace/relative/file.ts');
    });

    it('should handle diagnostics without source or code', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'simple error' },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/test.ts', severity: 'all' },
        context
      );

      expect(result.output).toContain('[Error]');
      expect(result.output).toContain('simple error');
      // Should not contain source brackets like [typescript]
      expect(result.output).not.toMatch(/\[typescript\]/);
      // Should not contain code in parentheses
      expect(result.output).not.toMatch(/\(\d+\)/);
    });

    it('should format hint and info severity', async () => {
      mockGetDiagnosticsForFile.mockResolvedValue([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 3, message: 'info msg' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 4, message: 'hint msg' },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/test.ts', severity: 'all' },
        context
      );

      expect(result.output).toContain('[Info]');
      expect(result.output).toContain('[Hint]');
    });
  });

  describe('call - hover', () => {
    it('should require line and character parameters', async () => {
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'hover', filePath: '/test.ts' },
        context
      );

      expect(result.isError).toBe(true);
      expect(result.message).toContain('line and character');
    });

    it('should require character parameter', async () => {
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'hover', filePath: '/test.ts', line: 0 },
        context
      );

      expect(result.isError).toBe(true);
    });

    it('should return no hover info message when null', async () => {
      mockGetHover.mockResolvedValue(null);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'hover', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.isError).toBe(false);
      expect(result.output).toBe('No hover information available.');
    });

    it('should format string hover contents', async () => {
      mockGetHover.mockResolvedValue({ contents: 'Type: string' });
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'hover', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.output).toBe('Type: string');
    });

    it('should format MarkupContent hover contents', async () => {
      mockGetHover.mockResolvedValue({ contents: { value: '**bold** content' } });
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'hover', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.output).toBe('**bold** content');
    });
  });

  describe('call - definition', () => {
    it('should require line and character parameters', async () => {
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'definition', filePath: '/test.ts' },
        context
      );

      expect(result.isError).toBe(true);
      expect(result.message).toContain('line and character');
    });

    it('should return no definition found when empty', async () => {
      mockGetDefinition.mockResolvedValue([]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'definition', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.isError).toBe(false);
      expect(result.output).toBe('No definition found.');
    });

    it('should format single definition location', async () => {
      mockGetDefinition.mockResolvedValue([
        { uri: 'file:///test/other.ts', range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } } },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'definition', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.output).toBe('/test/other.ts:10:0');
      expect(result.metadata?.count).toBe(1);
    });

    it('should format multiple definition locations', async () => {
      mockGetDefinition.mockResolvedValue([
        { uri: 'file:///test/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
        { uri: 'file:///test/b.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 8 } } },
      ]);
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'definition', filePath: '/test.ts', line: 0, character: 5 },
        context
      );

      expect(result.output).toContain('/test/a.ts:0:0');
      expect(result.output).toContain('/test/b.ts:5:3');
      expect(result.metadata?.count).toBe(2);
    });
  });

  describe('call - error handling', () => {
    it('should return error for unknown action', async () => {
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'unknown' as any, filePath: '/test.ts' },
        context
      );

      expect(result.isError).toBe(true);
      expect(result.message).toContain('Unknown LSP action');
    });

    it('should handle exceptions gracefully', async () => {
      mockGetDiagnosticsForFile.mockRejectedValue(new Error('Network error'));
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/test.ts', severity: 'all' },
        context
      );

      expect(result.isError).toBe(true);
      expect(result.message).toContain('LSP error');
      expect(result.message).toContain('Network error');
    });

    it('should handle non-Error exceptions', async () => {
      mockGetDiagnosticsForFile.mockRejectedValue('string error');
      const context = { cwd: '/workspace', abortController: new AbortController() };

      const result = await tool.call(
        { action: 'diagnostics', filePath: '/test.ts', severity: 'all' },
        context
      );

      expect(result.isError).toBe(true);
      expect(result.message).toContain('string error');
    });
  });
});
