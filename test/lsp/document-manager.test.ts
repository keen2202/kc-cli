// Tests for DocumentManager

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentManager } from '../../src/lsp/document-manager';

// Mock LSPClientManager
const mockClientInstance = {
  connect: vi.fn().mockResolvedValue(true),
  getDiagnostics: vi.fn().mockResolvedValue([]),
  getHover: vi.fn().mockResolvedValue(null),
  getDefinition: vi.fn().mockResolvedValue([]),
  disconnectAll: vi.fn(),
  isConnected: vi.fn().mockReturnValue(false),
};

vi.mock('../../src/lsp/client', () => ({
  LSPClientManager: class MockLSPClientManager {
    connect = mockClientInstance.connect;
    getDiagnostics = mockClientInstance.getDiagnostics;
    getHover = mockClientInstance.getHover;
    getDefinition = mockClientInstance.getDefinition;
    disconnectAll = mockClientInstance.disconnectAll;
    isConnected = mockClientInstance.isConnected;
  },
  detectLanguage: vi.fn().mockReturnValue('typescript'),
}));

describe('DocumentManager', () => {
  let manager: DocumentManager;

  beforeEach(() => {
    manager = new DocumentManager();
    vi.clearAllMocks();
  });

  describe('open', () => {
    it('should open a document and track it', async () => {
      const doc = await manager.open('/test/file.ts', 'const x = 1;');

      expect(doc.uri).toBe('file:///test/file.ts');
      expect(doc.filePath).toBe('/test/file.ts');
      expect(doc.languageId).toBe('typescript');
      expect(doc.version).toBe(1);
      expect(doc.content).toBe('const x = 1;');
      expect(doc.isOpen).toBe(true);
    });

    it('should auto-detect language from file extension', async () => {
      const doc = await manager.open('/test/file.ts', '');
      expect(doc.languageId).toBe('typescript');
    });

    it('should use provided languageId if given', async () => {
      const doc = await manager.open('/test/file.txt', '', 'python');
      expect(doc.languageId).toBe('python');
    });
  });

  describe('update', () => {
    it('should update document content and increment version', async () => {
      await manager.open('/test/file.ts', 'const x = 1;');
      const updated = await manager.update('/test/file.ts', 'const x = 2;');

      expect(updated.version).toBe(2);
      expect(updated.content).toBe('const x = 2;');
    });

    it('should throw if document is not open', async () => {
      await expect(manager.update('/nonexistent.ts', 'content'))
        .rejects.toThrow('Document not opened');
    });
  });

  describe('close', () => {
    it('should close and remove document', async () => {
      await manager.open('/test/file.ts', 'content');
      manager.close('/test/file.ts');

      expect(manager.get('/test/file.ts')).toBeUndefined();
      expect(manager.isOpen('/test/file.ts')).toBe(false);
    });

    it('should handle closing non-existent document gracefully', () => {
      expect(() => manager.close('/nonexistent.ts')).not.toThrow();
    });
  });

  describe('get', () => {
    it('should return document if open', async () => {
      await manager.open('/test/file.ts', 'content');
      const doc = manager.get('/test/file.ts');

      expect(doc).toBeDefined();
      expect(doc?.content).toBe('content');
    });

    it('should return undefined if not open', () => {
      expect(manager.get('/nonexistent.ts')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return all open documents', async () => {
      await manager.open('/test/file1.ts', 'content1');
      await manager.open('/test/file2.ts', 'content2');

      const docs = manager.getAll();
      expect(docs).toHaveLength(2);
    });

    it('should not return closed documents', async () => {
      await manager.open('/test/file1.ts', 'content1');
      await manager.open('/test/file2.ts', 'content2');
      manager.close('/test/file1.ts');

      const docs = manager.getAll();
      expect(docs).toHaveLength(1);
      expect(docs[0].filePath).toBe('/test/file2.ts');
    });
  });

  describe('getContent', () => {
    it('should return content of open document', async () => {
      await manager.open('/test/file.ts', 'hello');
      expect(manager.getContent('/test/file.ts')).toBe('hello');
    });

    it('should return undefined for non-existent document', () => {
      expect(manager.getContent('/nonexistent.ts')).toBeUndefined();
    });
  });

  describe('incremental changes', () => {
    it('should compute changes when lines are added at the end', async () => {
      await manager.open('/test/file.ts', 'line1\nline2');
      const doc = await manager.update('/test/file.ts', 'line1\nline2\nline3');

      expect(doc.content).toBe('line1\nline2\nline3');
      expect(doc.version).toBe(2);
    });

    it('should compute changes when lines are modified', async () => {
      await manager.open('/test/file.ts', 'line1\nline2\nline3');
      const doc = await manager.update('/test/file.ts', 'line1\nmodified\nline3');

      expect(doc.content).toBe('line1\nmodified\nline3');
    });

    it('should compute changes when lines are deleted', async () => {
      await manager.open('/test/file.ts', 'line1\nline2\nline3');
      const doc = await manager.update('/test/file.ts', 'line1\nline3');

      expect(doc.content).toBe('line1\nline3');
    });
  });
});
