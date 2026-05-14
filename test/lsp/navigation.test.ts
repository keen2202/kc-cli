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
  });
});
