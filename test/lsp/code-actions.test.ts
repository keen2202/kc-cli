// Tests for CodeActionProvider

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeActionProvider, CodeActionKind } from '../../src/lsp/code-actions';

describe('CodeActionProvider', () => {
  let provider: CodeActionProvider;

  beforeEach(() => {
    provider = new CodeActionProvider();
    vi.clearAllMocks();
  });

  describe('getCodeActions', () => {
    it('should return empty if document not managed', async () => {
      const mockClient = {} as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(undefined),
      } as any;

      const actions = await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      );

      expect(actions).toEqual([]);
    });

    it('should open document if not already open', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue(doc),
      } as any;

      await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      );

      expect(mockDocManager.open).toHaveBeenCalledWith('/test/file.ts', doc.content, doc.languageId);
    });

    it('should return code actions from language server', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockActions = [
        { title: 'Add import', kind: CodeActionKind.QuickFix },
        { title: 'Organize imports', kind: CodeActionKind.SourceOrganizeImports },
      ];
      const mockClient = { request: vi.fn().mockResolvedValue(mockActions) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const actions = await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      );

      expect(actions).toHaveLength(2);
      expect(actions[0].title).toBe('Add import');
    });

    it('should pass diagnostics in context', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;
      const diagnostics = [{ message: 'Cannot find name', severity: 1 }];

      await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        { diagnostics }
      );

      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/codeAction', expect.objectContaining({
        context: expect.objectContaining({ diagnostics }),
      }));
    });

    it('should pass only filter', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        { only: [CodeActionKind.QuickFix] }
      );

      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/codeAction', expect.objectContaining({
        context: expect.objectContaining({ only: [CodeActionKind.QuickFix] }),
      }));
    });

    it('should return empty on request failure', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockRejectedValue(new Error('LSP error')) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const actions = await provider.getCodeActions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      );

      expect(actions).toEqual([]);
    });
  });

  describe('getQuickFixes', () => {
    it('should filter for quickfix actions only', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;
      const diagnostics = [{ message: 'error', severity: 1 }];

      await provider.getQuickFixes(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 },
        diagnostics
      );

      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/codeAction', expect.objectContaining({
        context: expect.objectContaining({
          only: [CodeActionKind.QuickFix],
          diagnostics,
        }),
      }));
    });
  });

  describe('organizeImports', () => {
    it('should return empty if document not managed', async () => {
      const mockClient = {} as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(undefined),
      } as any;

      const actions = await provider.organizeImports(mockClient, mockDocManager, '/test/file.ts');
      expect(actions).toEqual([]);
    });

    it('should request organize imports for full document range', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'import a from "a";\nimport b from "b";', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      await provider.organizeImports(mockClient, mockDocManager, '/test/file.ts');

      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/codeAction', expect.objectContaining({
        range: {
          start: { line: 0, character: 0 },
          end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
        },
        context: expect.objectContaining({
          only: [CodeActionKind.SourceOrganizeImports],
        }),
      }));
    });
  });

  describe('applyCodeAction', () => {
    it('should apply workspace edit if present', async () => {
      const mockNav = { applyWorkspaceEdit: vi.fn().mockResolvedValue(undefined) };
      const action = {
        title: 'Fix import',
        edit: {
          changes: {
            'file:///test/file.ts': [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: 'import x from "x";\n',
            }],
          },
        },
      };

      await provider.applyCodeAction(action, mockNav);
      expect(mockNav.applyWorkspaceEdit).toHaveBeenCalledWith(action.edit);
    });

    it('should not throw if no navigation provider', async () => {
      const action = { title: 'Fix', edit: { changes: {} } };
      await expect(provider.applyCodeAction(action)).resolves.not.toThrow();
    });

    it('should handle action with command but no edit', async () => {
      const action = {
        title: 'Fix',
        command: { title: 'fix', command: 'editor.action.fixAll' },
      };
      await expect(provider.applyCodeAction(action)).resolves.not.toThrow();
    });
  });

  describe('CodeActionKind', () => {
    it('should define standard kinds', () => {
      expect(CodeActionKind.QuickFix).toBe('quickfix');
      expect(CodeActionKind.Refactor).toBe('refactor');
      expect(CodeActionKind.SourceOrganizeImports).toBe('source.organizeImports');
      expect(CodeActionKind.SourceFixAll).toBe('source.fixAll');
    });
  });
});
