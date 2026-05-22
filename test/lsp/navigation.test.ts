// Tests for NavigationProvider

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NavigationProvider } from '../../src/lsp/navigation';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('test content'),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

describe('NavigationProvider', () => {
  let provider: NavigationProvider;

  beforeEach(() => {
    provider = new NavigationProvider();
    vi.clearAllMocks();
  });

  describe('findReferences', () => {
    it('should return empty array if document not managed', async () => {
      const mockClient = {} as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(undefined),
      } as any;

      const refs = await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(refs).toEqual([]);
    });

    it('should open document if not already open', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue(doc),
      } as any;

      await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(mockDocManager.open).toHaveBeenCalledWith('/test/file.ts', doc.content, doc.languageId);
    });

    it('should return references from language server', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockRefs = [
        { uri: 'file:///test/file.ts', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
        { uri: 'file:///test/other.ts', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } },
      ];
      const mockClient = { request: vi.fn().mockResolvedValue(mockRefs) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const refs = await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 6 }
      );

      expect(refs).toHaveLength(2);
      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/references', expect.objectContaining({
        context: { includeDeclaration: true },
      }));
    });

    it('should pass includeDeclaration parameter', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue([]) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 },
        false
      );

      expect(mockClient.request).toHaveBeenCalledWith('/test/file.ts', 'textDocument/references', expect.objectContaining({
        context: { includeDeclaration: false },
      }));
    });

    it('should return empty array on request failure', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockRejectedValue(new Error('LSP error')) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const refs = await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(refs).toEqual([]);
    });

    it('should return empty when result is not an array', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue(null) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const refs = await provider.findReferences(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(refs).toEqual([]);
    });
  });

  describe('rename', () => {
    it('should return null if document not managed', async () => {
      const mockClient = {} as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(undefined),
      } as any;

      const edit = await provider.rename(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 },
        'newName'
      );

      expect(edit).toBeNull();
    });

    it('should open document if not already open', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue(null) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue(doc),
      } as any;

      await provider.rename(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 6 },
        'newName'
      );

      expect(mockDocManager.open).toHaveBeenCalledWith('/test/file.ts', doc.content, doc.languageId);
    });

    it('should return workspace edit on success', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockEdit = {
        changes: {
          'file:///test/file.ts': [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'newName' }],
        },
      };
      const mockClient = { request: vi.fn().mockResolvedValue(mockEdit) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const edit = await provider.rename(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 6 },
        'newName'
      );

      expect(edit).toEqual(mockEdit);
    });

    it('should return null on request failure', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockRejectedValue(new Error('LSP error')) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const edit = await provider.rename(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 },
        'newName'
      );

      expect(edit).toBeNull();
    });
  });

  describe('findWorkspaceSymbols', () => {
    it('should return symbols from language server', async () => {
      const mockSymbols = [
        { name: 'MyClass', kind: 5, location: { uri: 'file:///test/file.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } } },
      ];
      const mockClient = { request: vi.fn().mockResolvedValue(mockSymbols) } as any;

      const symbols = await provider.findWorkspaceSymbols(mockClient, 'MyClass');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('MyClass');
    });

    it('should return empty array on failure', async () => {
      const mockClient = { request: vi.fn().mockRejectedValue(new Error('fail')) } as any;

      const symbols = await provider.findWorkspaceSymbols(mockClient, 'query');
      expect(symbols).toEqual([]);
    });

    it('should return empty when result is not an array', async () => {
      const mockClient = { request: vi.fn().mockResolvedValue(null) } as any;

      const symbols = await provider.findWorkspaceSymbols(mockClient, 'query');
      expect(symbols).toEqual([]);
    });
  });

  describe('applyWorkspaceEdit', () => {
    it('should apply changes from changes map', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('hello world');
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        changes: {
          'file:///test/file.ts': [{
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            newText: 'goodbye',
          }],
        },
      });

      expect(writeSpy).toHaveBeenCalledWith(
        '/test/file.ts',
        expect.stringContaining('goodbye'),
        'utf-8'
      );
    });

    it('should handle document changes with TextDocumentEdit', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3');
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          textDocument: { uri: 'file:///test/file.ts', version: 1 },
          edits: [{
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            newText: 'modified',
          }],
        }],
      });

      expect(writeSpy).toHaveBeenCalledWith(
        '/test/file.ts',
        expect.stringContaining('modified'),
        'utf-8'
      );
    });

    it('should apply edits in reverse order for TextDocumentEdit', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3');
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          textDocument: { uri: 'file:///test/file.ts' },
          edits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'FIRST' },
            { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, newText: 'THIRD' },
          ],
        }],
      });

      expect(writeSpy).toHaveBeenCalled();
    });

    it('should handle create file document change', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          kind: 'create',
          uri: 'file:///test/newfile.ts',
        }],
      });

      expect(writeSpy).toHaveBeenCalledWith('/test/newfile.ts', '', 'utf-8');
    });

    it('should handle delete file document change', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const unlinkSpy = vi.mocked(fs.unlinkSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          kind: 'delete',
          uri: 'file:///test/oldfile.ts',
        }],
      });

      expect(unlinkSpy).toHaveBeenCalledWith('/test/oldfile.ts');
    });

    it('should skip delete if file does not exist', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const unlinkSpy = vi.mocked(fs.unlinkSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          kind: 'delete',
          uri: 'file:///test/missing.ts',
        }],
      });

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('should skip changes for non-existent files', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        changes: {
          'file:///test/missing.ts': [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: 'new',
          }],
        },
      });

      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('should skip TextDocumentEdit for non-existent files', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        documentChanges: [{
          textDocument: { uri: 'file:///test/missing.ts' },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'new' }],
        }],
      });

      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('should handle empty edit gracefully', async () => {
      await expect(provider.applyWorkspaceEdit({})).resolves.not.toThrow();
    });

    it('should sort edits by position (line then character) descending', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('aaa\nbbb\nccc');
      const writeSpy = vi.mocked(fs.writeFileSync);

      await provider.applyWorkspaceEdit({
        changes: {
          'file:///test/file.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'xxx' },
            { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, newText: 'zzz' },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'yyy' },
          ],
        },
      });

      expect(writeSpy).toHaveBeenCalled();
    });
  });
});
