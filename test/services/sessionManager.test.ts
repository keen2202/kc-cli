import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/services/sessionManager';
import type { FileMemoryService } from '../../src/memory/FileMemoryService';
import type { SessionSnapshot } from '../../src/memory/types';

function createMockMemoryService(): FileMemoryService {
  const sessions = new Map<string, SessionSnapshot>();

  return {
    initialize: vi.fn(),
    addMemory: vi.fn(),
    listMemories: vi.fn(),
    getMemory: vi.fn(),
    removeMemory: vi.fn(),
    updateMemory: vi.fn(),
    scanMemories: vi.fn(),
    getProjectMemoryPath: vi.fn(),
    saveSession: vi.fn(async (session: SessionSnapshot) => {
      sessions.set(session.sessionId, session);
    }),
    loadSession: vi.fn(async (sessionId: string) => {
      return sessions.get(sessionId) || null;
    }),
    listSessions: vi.fn(async () => {
      return Array.from(sessions.values()).sort(
        (a, b) => b.metadata.lastModified - a.metadata.lastModified
      );
    }),
    deleteSession: vi.fn(async (sessionId: string) => {
      sessions.delete(sessionId);
    }),
    archiveSession: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.delete(sessionId);
      }
    }),
    pruneOldSessions: vi.fn(async (retentionDays: number) => {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      let pruned = 0;
      for (const [id, session] of sessions) {
        if (session.metadata.lastModified < cutoff) {
          sessions.delete(id);
          pruned++;
        }
      }
      return pruned;
    }),
  } as unknown as FileMemoryService;
}

function makeSessionSnapshot(sessionId: string, lastModified?: number): SessionSnapshot {
  return {
    sessionId,
    messages: [
      { id: '1', role: 'user', content: 'Hello', timestamp: Date.now() },
      { id: '2', role: 'assistant', content: 'Hi there', timestamp: Date.now() },
    ],
    state: {
      cwd: '/test',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      turnCount: 1,
      totalTokensUsed: 100,
    },
    metadata: {
      createdAt: Date.now() - 10000,
      lastModified: lastModified || Date.now(),
      toolsUsed: ['Bash', 'FileRead'],
    },
  };
}

describe('SessionManager', () => {
  let memoryService: FileMemoryService;
  let manager: SessionManager;

  beforeEach(() => {
    memoryService = createMockMemoryService();
    manager = new SessionManager(memoryService);
  });

  it('should save a session', async () => {
    const snapshot = makeSessionSnapshot('sess_1');
    await manager.saveSession('sess_1', snapshot.messages, {
      cwd: '/test',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      turnCount: 1,
      totalTokensUsed: 100,
      createdAt: Date.now(),
    } as any, ['Bash', 'FileRead']);
    expect(memoryService.saveSession).toHaveBeenCalled();
  });

  it('should load a session', async () => {
    const snapshot = makeSessionSnapshot('sess_1');
    await memoryService.saveSession(snapshot);
    const loaded = await manager.loadSession('sess_1');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(2);
  });

  it('should return null for non-existent session', async () => {
    const loaded = await manager.loadSession('nonexistent');
    expect(loaded).toBeNull();
  });

  it('should list recent sessions', async () => {
    await memoryService.saveSession(makeSessionSnapshot('sess_1'));
    await memoryService.saveSession(makeSessionSnapshot('sess_2'));
    const sessions = await manager.listRecentSessions(10);
    expect(sessions.length).toBe(2);
  });

  it('should archive a session', async () => {
    await memoryService.saveSession(makeSessionSnapshot('sess_1'));
    await manager.archiveSession('sess_1');
    expect(memoryService.archiveSession).toHaveBeenCalledWith('sess_1');
  });

  it('should delete a session', async () => {
    await memoryService.saveSession(makeSessionSnapshot('sess_1'));
    await manager.deleteSession('sess_1');
    expect(memoryService.deleteSession).toHaveBeenCalledWith('sess_1');
  });

  it('should prune old sessions', async () => {
    const oldSession = makeSessionSnapshot('old', Date.now() - 100 * 24 * 60 * 60 * 1000);
    const newSession = makeSessionSnapshot('new', Date.now());
    await memoryService.saveSession(oldSession);
    await memoryService.saveSession(newSession);
    const pruned = await manager.pruneOldSessions(30);
    expect(pruned).toBe(1);
  });

  it('should get session stats', async () => {
    const snapshot = makeSessionSnapshot('sess_1');
    await memoryService.saveSession(snapshot);
    const stats = await manager.getSessionStats('sess_1');
    expect(stats).not.toBeNull();
    expect(stats!.sessionId).toBe('sess_1');
    expect(stats!.turnCount).toBe(1);
    expect(stats!.messageCount).toBe(2);
  });

  it('should return null stats for non-existent session', async () => {
    const stats = await manager.getSessionStats('nonexistent');
    expect(stats).toBeNull();
  });

  it('should get last session', async () => {
    await memoryService.saveSession(makeSessionSnapshot('sess_1'));
    const last = await manager.getLastSession();
    expect(last).not.toBeNull();
    expect(last!.sessionId).toBe('sess_1');
  });

  it('should return null when no sessions exist', async () => {
    const last = await manager.getLastSession();
    expect(last).toBeNull();
  });

  it('should manage current session ID', () => {
    expect(() => manager.clearCurrentSession()).not.toThrow();
    manager.setCurrentSessionId('sess_1');
    manager.clearCurrentSession();
  });
});
