import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReadFile,
  mockWriteFile,
  mockReaddir,
  mockStat,
  mockLstat,
  mockUnlink,
  mockRename,
  mockMkdir,
  mockAccess,
  mockRealpath,
  mockRm,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockLstat: vi.fn(),
  mockUnlink: vi.fn(),
  mockRename: vi.fn(),
  mockMkdir: vi.fn(),
  mockAccess: vi.fn(),
  mockRealpath: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  stat: mockStat,
  lstat: mockLstat,
  unlink: mockUnlink,
  rename: mockRename,
  mkdir: mockMkdir,
  access: mockAccess,
  realpath: mockRealpath,
  rm: mockRm,
}));

vi.mock('../../src/memory/paths', () => ({
  getProjectMemoryPath: vi.fn((hash: string) => `/mock/memory/${hash}`),
  getMemoryFilePath: vi.fn((hash: string, file: string) => `/mock/memory/${hash}/${file}`),
  getSessionPath: vi.fn((id: string) => `/mock/sessions/${id}.json`),
  getSessionArchivePath: vi.fn((id: string) => `/mock/sessions/.archive/${id}.json`),
  getSessionBasePath: vi.fn(() => '/mock/sessions'),
  getArchivePath: vi.fn(() => '/mock/sessions/.archive'),
  getKcCliBasePath: vi.fn(() => '/mock/.kc-cli'),
  ensureMemoryDir: vi.fn().mockResolvedValue(undefined),
  ensureSessionDirs: vi.fn().mockResolvedValue(undefined),
  validateMemoryPath: vi.fn().mockResolvedValue(true),
  sanitizeFileName: vi.fn((name: string) => name),
  ensureGitignore: vi.fn().mockResolvedValue(undefined),
  ALLOWED_MEMORY_EXTENSIONS: ['.md'],
  ALLOWED_SESSION_EXTENSIONS: ['.json'],
}));

vi.mock('../../src/memory/frontmatter', () => ({
  parseFrontmatter: vi.fn(),
  composeMemoryFile: vi.fn(),
  validateMemoryType: vi.fn((type: string) => {
    const valid = ['user', 'feedback', 'project', 'reference'];
    return valid.includes(type) ? type : undefined;
  }),
}));

import { FileMemoryService } from '../../src/memory/FileMemoryService';
import * as paths from '../../src/memory/paths';
import * as frontmatter from '../../src/memory/frontmatter';
import type { MemoryEntry, SessionSnapshot, MemoryType } from '../../src/memory/types';

const mockPaths = vi.mocked(paths);
const mockFrontmatter = vi.mocked(frontmatter);

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    header: {
      name: 'test_memory',
      description: 'A test memory',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    content: 'Test content',
    filePath: '/mock/memory/hash/test.md',
    fileName: 'test.md',
    mtime: Date.now(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-123',
    messages: [],
    state: {
      cwd: '/home/user/project',
      model: 'claude-3',
      provider: 'anthropic',
      turnCount: 5,
      totalTokensUsed: 1000,
    },
    metadata: {
      createdAt: Date.now(),
      lastModified: Date.now(),
      toolsUsed: ['Bash', 'FileRead'],
    },
    ...overrides,
  };
}

describe('FileMemoryService (comprehensive, mocked)', () => {
  let service: FileMemoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FileMemoryService();

    mockPaths.validateMemoryPath.mockResolvedValue(true);
    mockPaths.sanitizeFileName.mockImplementation((name: string) => name);
    mockPaths.ensureMemoryDir.mockResolvedValue(undefined);
    mockPaths.ensureSessionDirs.mockResolvedValue(undefined);
    mockPaths.ensureGitignore.mockResolvedValue(undefined);
    mockPaths.getProjectMemoryPath.mockImplementation((hash: string) => `/mock/memory/${hash}`);
    mockPaths.getMemoryFilePath.mockImplementation(
      (hash: string, file: string) => `/mock/memory/${hash}/${file}`
    );
    mockPaths.getSessionPath.mockImplementation((id: string) => `/mock/sessions/${id}.json`);
    mockPaths.getSessionArchivePath.mockImplementation(
      (id: string) => `/mock/sessions/.archive/${id}.json`
    );
    mockPaths.getSessionBasePath.mockReturnValue('/mock/sessions');
    mockPaths.getArchivePath.mockReturnValue('/mock/sessions/.archive');
    mockPaths.getKcCliBasePath.mockReturnValue('/mock/.kc-cli');

    mockFrontmatter.composeMemoryFile.mockImplementation(
      (header: any, content: string) =>
        `---\nname: ${header.name}\ntype: ${header.type}\n---\n${content}`
    );
    mockFrontmatter.parseFrontmatter.mockImplementation((content: string) => {
      const nameMatch = content.match(/name:\s*(\S+)/);
      const typeMatch = content.match(/type:\s*(\S+)/);
      return {
        header: {
          name: nameMatch?.[1] || 'unknown',
          description: '',
          type: typeMatch?.[1] || 'user',
        },
        body: content.split('---').pop()?.trim() || '',
      };
    });
    mockFrontmatter.validateMemoryType.mockImplementation((type: string) => {
      const valid = ['user', 'feedback', 'project', 'reference'];
      return valid.includes(type) ? type : undefined;
    });
  });

  describe('initialize', () => {
    it('should create directories and ensure gitignore', async () => {
      mockMkdir.mockResolvedValue(undefined);

      await service.initialize();

      expect(mockPaths.ensureSessionDirs).toHaveBeenCalled();
      expect(mockMkdir).toHaveBeenCalledWith('/mock/.kc-cli/memory', { recursive: true });
      expect(mockPaths.ensureGitignore).toHaveBeenCalledWith('/mock/.kc-cli');
    });
  });

  describe('addMemory', () => {
    it('should write memory file using atomic write pattern', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      const memory = makeMemoryEntry();
      const fileName = await service.addMemory('test-hash', memory);

      expect(mockPaths.ensureMemoryDir).toHaveBeenCalledWith('test-hash');
      expect(mockPaths.validateMemoryPath).toHaveBeenCalled();
      expect(mockFrontmatter.composeMemoryFile).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();

      const writePath = mockWriteFile.mock.calls[0][0] as string;
      const renameFrom = mockRename.mock.calls[0][0] as string;
      const renameTo = mockRename.mock.calls[0][1] as string;

      expect(writePath.endsWith('.tmp')).toBe(true);
      expect(renameFrom).toBe(writePath);
      expect(renameTo).toBe(writePath.replace('.tmp', ''));

      expect(fileName).toBeDefined();
    });

    it('should throw error for invalid path', async () => {
      mockPaths.validateMemoryPath.mockResolvedValue(false);

      const memory = makeMemoryEntry();
      await expect(service.addMemory('test-hash', memory)).rejects.toThrow('Invalid memory path');
    });

    it('should use sanitizeFileName on the filename', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      const memory = makeMemoryEntry({ fileName: 'custom-name.md' });
      await service.addMemory('test-hash', memory);

      expect(mockPaths.sanitizeFileName).toHaveBeenCalledWith('custom-name.md');
    });

    it('should default filename from header name if not provided', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      const memory = makeMemoryEntry();
      (memory as any).fileName = undefined;
      await service.addMemory('test-hash', memory);

      expect(mockPaths.sanitizeFileName).toHaveBeenCalledWith('test_memory.md');
    });
  });

  describe('listMemories', () => {
    it('should return empty array when directory does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await service.listMemories('nonexistent');
      expect(result).toEqual([]);
    });

    it('should list memory files with valid frontmatter', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['memory1.md', 'memory2.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: mem\ndescription: desc\ntype: user\n---\nBody`
      );

      const result = await service.listMemories('test-hash');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('should filter by memory type when specified', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['mem1.md', 'mem2.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);

      mockFrontmatter.parseFrontmatter
        .mockReturnValueOnce({
          header: { name: 'user_mem', description: '', type: 'user' },
          body: 'content',
        })
        .mockReturnValueOnce({
          header: { name: 'proj_mem', description: '', type: 'project' },
          body: 'content',
        });

      mockFrontmatter.validateMemoryType.mockImplementation((type: string) => {
        const valid = ['user', 'feedback', 'project', 'reference'];
        return valid.includes(type) ? (type as MemoryType) : undefined;
      });

      mockReadFile.mockResolvedValue('dummy');

      const result = await service.listMemories('test-hash', 'user');
      const userMemories = result.filter((m) => m.header.type === 'user');
      expect(userMemories.length).toBe(result.length);
    });
  });

  describe('getMemory', () => {
    it('should return parsed memory when file exists', async () => {
      mockReadFile.mockResolvedValue(
        `---\nname: test\ndescription: Test memory\ntype: user\n---\nContent body`
      );
      mockStat.mockResolvedValue({ mtimeMs: 12345 } as any);

      const result = await service.getMemory('test-hash', 'test.md');

      expect(result).not.toBeNull();
      expect(result!.header.name).toBe('test');
      expect(result!.content).toBe('Content body');
      expect(result!.mtime).toBe(12345);
    });

    it('should return null when file does not exist', async () => {
      const error: any = new Error('ENOENT');
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const result = await service.getMemory('test-hash', 'nonexistent.md');
      expect(result).toBeNull();
    });

    it('should throw on non-ENOENT errors', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      await expect(service.getMemory('test-hash', 'test.md')).rejects.toThrow('Permission denied');
    });

    it('should throw error for invalid path', async () => {
      mockPaths.validateMemoryPath.mockResolvedValue(false);

      await expect(service.getMemory('test-hash', '../escape.md')).rejects.toThrow(
        'Invalid memory path'
      );
    });

    it('should return null for memory with missing name in frontmatter', async () => {
      mockReadFile.mockResolvedValue('content');
      mockStat.mockResolvedValue({ mtimeMs: 12345 } as any);

      mockFrontmatter.parseFrontmatter.mockReturnValueOnce({
        header: { type: 'user' } as any,
        body: 'Content',
      });

      const result = await service.getMemory('test-hash', 'bad.md');
      expect(result).toBeNull();
    });

    it('should return null for memory with invalid type', async () => {
      mockReadFile.mockResolvedValue('content');
      mockStat.mockResolvedValue({ mtimeMs: 12345 } as any);

      mockFrontmatter.parseFrontmatter.mockReturnValueOnce({
        header: { name: 'bad', description: '', type: 'invalid_type' as any },
        body: 'Content',
      });
      mockFrontmatter.validateMemoryType.mockReturnValue(undefined);

      const result = await service.getMemory('test-hash', 'bad.md');
      expect(result).toBeNull();
    });
  });

  describe('removeMemory', () => {
    it('should delete the memory file', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await service.removeMemory('test-hash', 'test.md');

      expect(mockUnlink).toHaveBeenCalledWith('/mock/memory/test-hash/test.md');
    });

    it('should not throw when file does not exist', async () => {
      const error: any = new Error('ENOENT');
      error.code = 'ENOENT';
      mockUnlink.mockRejectedValue(error);

      await expect(service.removeMemory('test-hash', 'missing.md')).resolves.not.toThrow();
    });

    it('should throw on non-ENOENT errors', async () => {
      mockUnlink.mockRejectedValue(new Error('Permission denied'));

      await expect(service.removeMemory('test-hash', 'test.md')).rejects.toThrow(
        'Permission denied'
      );
    });

    it('should throw for invalid path', async () => {
      mockPaths.validateMemoryPath.mockResolvedValue(false);

      await expect(service.removeMemory('test-hash', '../escape.md')).rejects.toThrow(
        'Invalid memory path'
      );
    });
  });

  describe('updateMemory', () => {
    it('should update an existing memory with atomic write', async () => {
      mockReadFile.mockResolvedValue(
        `---\nname: existing\ndescription: Old desc\ntype: user\n---\nOld content`
      );
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await service.updateMemory('test-hash', 'existing.md', {
        content: 'New content',
        header: { description: 'New desc' } as any,
      });

      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();
    });

    it('should throw when memory does not exist', async () => {
      const error: any = new Error('ENOENT');
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      await expect(
        service.updateMemory('test-hash', 'missing.md', { content: 'new' })
      ).rejects.toThrow('Memory not found');
    });

    it('should preserve existing header when only updating content', async () => {
      mockReadFile.mockResolvedValue(
        `---\nname: keep\ndescription: Keep this\ntype: project\n---\nOld body`
      );
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await service.updateMemory('test-hash', 'keep.md', {
        content: 'New body',
      });

      expect(mockFrontmatter.composeMemoryFile).toHaveBeenCalled();
    });
  });

  describe('saveSession', () => {
    it('should write session as JSON with atomic write', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      const session = makeSession();
      await service.saveSession(session);

      expect(mockPaths.ensureSessionDirs).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();

      const content = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe('session-123');
    });
  });

  describe('loadSession', () => {
    it('should load session from primary path', async () => {
      const session = makeSession();
      mockReadFile.mockResolvedValue(JSON.stringify(session));

      const result = await service.loadSession('session-123');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('session-123');
    });

    it('should try archive path when primary path returns ENOENT', async () => {
      const session = makeSession({ sessionId: 'archived-session' });
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      mockReadFile
        .mockRejectedValueOnce(enoent)
        .mockResolvedValueOnce(JSON.stringify(session));

      const result = await service.loadSession('archived-session');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('archived-session');
    });

    it('should return null when both primary and archive return ENOENT', async () => {
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      mockReadFile
        .mockRejectedValueOnce(enoent)
        .mockRejectedValueOnce(enoent);

      const result = await service.loadSession('missing');
      expect(result).toBeNull();
    });

    it('should throw on non-ENOENT errors from primary path', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      await expect(service.loadSession('test')).rejects.toThrow('Permission denied');
    });
  });

  describe('listSessions', () => {
    it('should return empty array when session directory does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await service.listSessions();
      expect(result).toEqual([]);
    });

    it('should list and parse session files', async () => {
      const session = makeSession();
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session-1.json', 'session-2.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(JSON.stringify(session));

      const result = await service.listSessions();

      expect(result.length).toBe(2);
    });

    it('should sort sessions by lastModified descending', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['a.json', 'b.json'] as any);

      const now = Date.now();
      mockStat
        .mockResolvedValueOnce({ mtimeMs: now - 1000 } as any)
        .mockResolvedValueOnce({ mtimeMs: now } as any);

      const sessionA = makeSession({
        sessionId: 'a',
        metadata: { ...makeSession().metadata, lastModified: now - 1000 },
      });
      const sessionB = makeSession({
        sessionId: 'b',
        metadata: { ...makeSession().metadata, lastModified: now },
      });

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(sessionA))
        .mockResolvedValueOnce(JSON.stringify(sessionB));

      const result = await service.listSessions();

      expect(result[0].sessionId).toBe('b');
      expect(result[1].sessionId).toBe('a');
    });

    it('should filter by newerThan', async () => {
      const now = Date.now();
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['a.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: now - 5000 } as any);
      mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));

      const result = await service.listSessions({ newerThan: now - 1000 });
      expect(result.length).toBe(0);
    });

    it('should filter by olderThan', async () => {
      const now = Date.now();
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['a.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: now - 5000 } as any);
      mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));

      const result = await service.listSessions({ olderThan: now - 1000 });
      expect(result.length).toBe(1);
    });

    it('should apply limit', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['a.json', 'b.json', 'c.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));

      const result = await service.listSessions({ limit: 2 });
      expect(result.length).toBe(2);
    });

    it('should skip invalid JSON files gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['valid.json', 'corrupt.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeSession()))
        .mockResolvedValueOnce('not valid json{{{');

      const result = await service.listSessions();
      expect(result.length).toBe(1);
    });
  });

  describe('deleteSession', () => {
    it('should delete from both primary and archive paths', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await service.deleteSession('session-123');

      expect(mockUnlink).toHaveBeenCalledTimes(2);
    });

    it('should not throw when files do not exist', async () => {
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      mockUnlink.mockRejectedValue(enoent);

      await expect(service.deleteSession('missing')).resolves.not.toThrow();
    });

    it('should throw on non-ENOENT errors', async () => {
      const eacces: any = new Error('EACCES');
      eacces.code = 'EACCES';
      mockUnlink.mockRejectedValueOnce(eacces);

      await expect(service.deleteSession('session-123')).rejects.toThrow();
    });
  });

  describe('archiveSession', () => {
    it('should rename session file to archive path', async () => {
      mockRename.mockResolvedValue(undefined);

      await service.archiveSession('session-123');

      expect(mockPaths.ensureSessionDirs).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalledWith(
        '/mock/sessions/session-123.json',
        '/mock/sessions/.archive/session-123.json'
      );
    });

    it('should throw when session does not exist', async () => {
      const enoent: any = new Error('ENOENT');
      enoent.code = 'ENOENT';
      mockRename.mockRejectedValue(enoent);

      await expect(service.archiveSession('missing')).rejects.toThrow('Session not found');
    });

    it('should rethrow non-ENOENT errors', async () => {
      mockRename.mockRejectedValue(new Error('Disk error'));

      await expect(service.archiveSession('session-123')).rejects.toThrow('Disk error');
    });
  });

  describe('pruneOldSessions', () => {
    it('should delete sessions older than retention period', async () => {
      const now = Date.now();
      const oldSession = makeSession({
        sessionId: 'old',
        metadata: { ...makeSession().metadata, lastModified: now - 100 * 24 * 60 * 60 * 1000 },
      });
      const newSession = makeSession({
        sessionId: 'new',
        metadata: { ...makeSession().metadata, lastModified: now },
      });

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['old.json', 'new.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(oldSession))
        .mockResolvedValueOnce(JSON.stringify(newSession));

      mockUnlink.mockResolvedValue(undefined);

      const pruned = await service.pruneOldSessions(30);

      expect(pruned).toBe(1);
    });

    it('should return 0 when no sessions need pruning', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([] as any);

      const pruned = await service.pruneOldSessions(30);
      expect(pruned).toBe(0);
    });
  });

  describe('scanMemories', () => {
    it('should return empty array when directory does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await service.scanMemories('nonexistent');
      expect(result).toEqual([]);
    });

    it('should scan and parse memory files', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['mem1.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue('dummy');

      const result = await service.scanMemories('test-hash');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      mockAccess.mockResolvedValue(undefined);
      const files = Array.from({ length: 10 }, (_, i) => `file${i}.md`);
      mockReaddir.mockResolvedValue(files as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue('dummy');

      const result = await service.scanMemories('test-hash', 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe('getProjectMemoryPath', () => {
    it('should delegate to paths module', () => {
      const result = service.getProjectMemoryPath('test-hash');
      expect(result).toBe('/mock/memory/test-hash');
    });
  });
});
