// Tests for CompletionProvider

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompletionProvider, CompletionItemKind } from '../../src/lsp/completion';

describe('CompletionProvider', () => {
  let provider: CompletionProvider;

  beforeEach(() => {
    provider = new CompletionProvider();
    vi.clearAllMocks();
  });

  describe('getCompletions', () => {
    it('should return empty if document not managed', async () => {
      const mockClient = {} as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(undefined),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toEqual([]);
      expect(result.isIncomplete).toBe(false);
    });

    it('should open document if not already open', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = { request: vi.fn().mockResolvedValue(null) } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue(doc),
      } as any;

      await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(mockDocManager.open).toHaveBeenCalledWith('/test/file.ts', doc.content, doc.languageId);
    });

    it('should return completions from CompletionList format', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue({
          isIncomplete: false,
          items: [
            { label: 'console', kind: CompletionItemKind.Variable, sortText: '0001' },
            { label: 'const', kind: CompletionItemKind.Keyword, sortText: '0002' },
          ],
        }),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(2);
      expect(result.items[0].label).toBe('console');
      expect(result.isIncomplete).toBe(false);
    });

    it('should handle CompletionItem[] format', async () => {
      const doc = { uri: 'file:///test/file.ts', content: 'const x = 1;', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue([
          { label: 'foo', kind: CompletionItemKind.Function, sortText: '0001' },
        ]),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].label).toBe('foo');
    });

    it('should return empty on request failure', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockRejectedValue(new Error('LSP error')),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toEqual([]);
      expect(result.isIncomplete).toBe(false);
    });

    it('should return empty when request returns null', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue(null),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toEqual([]);
    });
  });

  describe('resolveCompletionItem', () => {
    it('should resolve additional details', async () => {
      const mockClient = {
        request: vi.fn().mockResolvedValue({
          documentation: 'Prints to stdout',
          detail: 'function console.log(...args: any[]): void',
        }),
      } as any;

      const item = { label: 'log', kind: CompletionItemKind.Method };
      const resolved = await provider.resolveCompletionItem(mockClient, item);

      expect(resolved.documentation).toBe('Prints to stdout');
      expect(resolved.detail).toBe('function console.log(...args: any[]): void');
    });

    it('should return original item on failure', async () => {
      const mockClient = {
        request: vi.fn().mockRejectedValue(new Error('resolve failed')),
      } as any;

      const item = { label: 'log', kind: CompletionItemKind.Method };
      const resolved = await provider.resolveCompletionItem(mockClient, item);

      expect(resolved).toEqual(item);
    });

    it('should preserve original fields when resolved has no new data', async () => {
      const mockClient = {
        request: vi.fn().mockResolvedValue({}),
      } as any;

      const item = { label: 'log', kind: CompletionItemKind.Method, detail: 'original' };
      const resolved = await provider.resolveCompletionItem(mockClient, item);

      expect(resolved.detail).toBe('original');
    });
  });

  describe('sortAndFilter', () => {
    it('should filter out snippets', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue([
          { label: 'log', kind: CompletionItemKind.Method, sortText: '0001' },
          { label: 'snippet', kind: CompletionItemKind.Snippet, sortText: '0000' },
        ]),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].label).toBe('log');
    });

    it('should filter out items without label', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue([
          { label: 'valid', kind: CompletionItemKind.Function, sortText: '0001' },
          { label: '', kind: CompletionItemKind.Function, sortText: '0002' },
        ]),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(1);
    });

    it('should sort by sortText', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue([
          { label: 'beta', kind: CompletionItemKind.Function, sortText: '0002' },
          { label: 'alpha', kind: CompletionItemKind.Function, sortText: '0001' },
        ]),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items[0].label).toBe('alpha');
      expect(result.items[1].label).toBe('beta');
    });

    it('should cap results to maxItems', async () => {
      provider.setMaxItems(3);
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const items = Array.from({ length: 10 }, (_, i) => ({
        label: `item${i}`,
        kind: CompletionItemKind.Function,
        sortText: String(i).padStart(4, '0'),
      }));
      const mockClient = {
        request: vi.fn().mockResolvedValue(items),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(3);
    });

    it('should extract documentation value from MarkupContent', async () => {
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const mockClient = {
        request: vi.fn().mockResolvedValue([{
          label: 'fn',
          kind: CompletionItemKind.Function,
          documentation: { kind: 'markdown', value: '**bold** docs' },
          sortText: '0001',
        }]),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items[0].documentation).toBe('**bold** docs');
    });
  });

  describe('setMaxItems', () => {
    it('should update max items', async () => {
      provider.setMaxItems(5);
      const doc = { uri: 'file:///test/file.ts', content: '', languageId: 'typescript' };
      const items = Array.from({ length: 10 }, (_, i) => ({
        label: `item${i}`,
        kind: CompletionItemKind.Function,
        sortText: String(i).padStart(4, '0'),
      }));
      const mockClient = {
        request: vi.fn().mockResolvedValue(items),
      } as any;
      const mockDocManager = {
        get: vi.fn().mockReturnValue(doc),
        isOpen: vi.fn().mockReturnValue(true),
      } as any;

      const result = await provider.getCompletions(
        mockClient,
        mockDocManager,
        '/test/file.ts',
        { line: 0, character: 0 }
      );

      expect(result.items).toHaveLength(5);
    });
  });

  describe('CompletionItemKind', () => {
    it('should define standard LSP completion kinds', () => {
      expect(CompletionItemKind.Text).toBe(1);
      expect(CompletionItemKind.Method).toBe(2);
      expect(CompletionItemKind.Function).toBe(3);
      expect(CompletionItemKind.Variable).toBe(6);
      expect(CompletionItemKind.Class).toBe(7);
      expect(CompletionItemKind.Keyword).toBe(14);
      expect(CompletionItemKind.Snippet).toBe(15);
    });
  });
});
