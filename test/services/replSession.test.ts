// Tests for ReplSessionService — REPL (non-UI) session persistence parity.
// Covers: best-effort save (empty-session guard, snapshot shape, swallowed
// failures), event-driven token/tool tracking, load/restore counter resync,
// unknown-id handling, restore failure propagation, and session rotation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplSessionService, type ReplEngine } from '../../src/services/replSession';
import { SessionManager } from '../../src/services/sessionManager';
import type { FileMemoryService } from '../../src/memory/FileMemoryService';
import type { SessionSnapshot } from '../../src/memory/types';
import { initializeState, resetState, getState } from '../../src/bootstrap/state';
import type { ChatMessage } from '../../src/query/protocol';

function createMockMemoryService(): FileMemoryService {
  const sessions = new Map<string, SessionSnapshot>();

  return {
    initialize: vi.fn(),
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
  } as unknown as FileMemoryService;
}

function makeMessages(): ChatMessage[] {
  return [
    { id: 'm1', role: 'system', content: 'sys', timestamp: 1 },
    { id: 'm2', role: 'user', content: 'hello', timestamp: 2 },
    { id: 'm3', role: 'assistant', content: 'hi', timestamp: 3 },
  ] as ChatMessage[];
}

function makeEngine(messages: ChatMessage[] = makeMessages()): ReplEngine & {
  restoreSession: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    getMessages: () => messages,
    restoreSession: vi.fn((snapshot: SessionSnapshot) => snapshot.state.turnCount),
    clear: vi.fn(),
  };
}

describe('ReplSessionService', () => {
  let memoryService: FileMemoryService;
  let service: ReplSessionService;

  beforeEach(() => {
    memoryService = createMockMemoryService();
    service = new ReplSessionService(memoryService, new SessionManager(memoryService));
    initializeState({
      sessionId: 'repl-session-1',
      config: { model: 'test-model', provider: 'test-provider' } as any,
    });
  });

  afterEach(() => {
    resetState();
  });

  describe('save', () => {
    it('never writes an empty session', async () => {
      await service.save(makeEngine([]));
      expect(memoryService.saveSession).not.toHaveBeenCalled();
      expect(memoryService.initialize).not.toHaveBeenCalled();
    });

    it('persists a snapshot with session id, messages and state fields', async () => {
      service.bumpTurn();
      service.bumpTurn();
      await service.save(makeEngine());

      expect(memoryService.initialize).toHaveBeenCalledTimes(1);
      expect(memoryService.saveSession).toHaveBeenCalledTimes(1);
      const snapshot = (memoryService.saveSession as any).mock.calls[0][0] as SessionSnapshot;
      expect(snapshot.sessionId).toBe('repl-session-1');
      expect(snapshot.messages).toHaveLength(3);
      expect(snapshot.state.model).toBe('test-model');
      expect(snapshot.state.provider).toBe('test-provider');
      expect(snapshot.state.turnCount).toBe(2);
    });

    it('initializes the memory service only once across saves', async () => {
      const engine = makeEngine();
      await service.save(engine);
      await service.save(engine);
      expect(memoryService.initialize).toHaveBeenCalledTimes(1);
      expect(memoryService.saveSession).toHaveBeenCalledTimes(2);
    });

    it('swallows persistence failures (best-effort)', async () => {
      (memoryService.saveSession as any).mockRejectedValueOnce(new Error('disk full'));
      await expect(service.save(makeEngine())).resolves.toBeUndefined();
    });
  });

  describe('noteEvent', () => {
    it('accumulates token usage and tools used into the snapshot', async () => {
      service.noteEvent({
        type: 'agent:turn_complete',
        message: {} as any,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        timestamp: Date.now(),
      } as any);
      service.noteEvent({
        type: 'agent:turn_complete',
        message: {} as any,
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        timestamp: Date.now(),
      } as any);
      service.noteEvent({
        type: 'agent:tool_started',
        toolCall: { toolName: 'Read' },
        timestamp: Date.now(),
      } as any);
      service.noteEvent({
        type: 'agent:tool_started',
        toolCall: { toolName: 'Read' },
        timestamp: Date.now(),
      } as any);

      await service.save(makeEngine());
      const snapshot = (memoryService.saveSession as any).mock.calls[0][0] as SessionSnapshot;
      expect(snapshot.state.totalTokensUsed).toBe(42);
      expect(snapshot.metadata.toolsUsed).toEqual(['Read']);
    });
  });

  describe('load', () => {
    const saved: SessionSnapshot = {
      sessionId: 'old-session',
      messages: makeMessages(),
      state: {
        cwd: '/w',
        model: 'saved-model',
        provider: 'saved-provider',
        turnCount: 7,
        totalTokensUsed: 999,
      },
      metadata: { createdAt: 100, lastModified: 200, toolsUsed: ['Bash'] },
    };

    it('returns null for an unknown session id and leaves the engine untouched', async () => {
      const engine = makeEngine();
      const result = await service.load(engine, 'missing');
      expect(result).toBeNull();
      expect(engine.restoreSession).not.toHaveBeenCalled();
      expect(getState().sessionId).toBe('repl-session-1');
    });

    it('restores the engine and resyncs counters + session id', async () => {
      await (memoryService.saveSession as any)(saved);
      const engine = makeEngine();

      const result = await service.load(engine, 'old-session');
      expect(result).not.toBeNull();
      expect(engine.restoreSession).toHaveBeenCalledTimes(1);
      expect(getState().sessionId).toBe('old-session');

      // Subsequent saves continue the restored session's counters.
      await service.save(engine);
      const snapshot = (memoryService.saveSession as any).mock.calls.at(-1)[0] as SessionSnapshot;
      expect(snapshot.sessionId).toBe('old-session');
      expect(snapshot.state.turnCount).toBe(7);
      expect(snapshot.state.totalTokensUsed).toBe(999);
      expect(snapshot.metadata.toolsUsed).toEqual(['Bash']);
      expect(snapshot.metadata.createdAt).toBe(100);
    });

    it('propagates restore validation failures and keeps the current session id', async () => {
      await (memoryService.saveSession as any)(saved);
      const engine = makeEngine();
      engine.restoreSession.mockImplementation(() => {
        throw new Error('Session snapshot is empty');
      });

      await expect(service.load(engine, 'old-session')).rejects.toThrow('Session snapshot is empty');
      expect(getState().sessionId).toBe('repl-session-1');
    });
  });

  describe('saveThrottled', () => {
    it('saves immediately on the first call, then throttles within the interval', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const engine = makeEngine();

        await service.saveThrottled(engine, 15_000);
        expect(memoryService.saveSession).toHaveBeenCalledTimes(1);

        // Within the interval: skipped.
        vi.setSystemTime(1_000_000 + 5_000);
        await service.saveThrottled(engine, 15_000);
        expect(memoryService.saveSession).toHaveBeenCalledTimes(1);

        // Past the interval: saved again.
        vi.setSystemTime(1_000_000 + 20_000);
        await service.saveThrottled(engine, 15_000);
        expect(memoryService.saveSession).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still honors the empty-session guard', async () => {
      await service.saveThrottled(makeEngine([]), 0);
      expect(memoryService.saveSession).not.toHaveBeenCalled();
    });
  });

  describe('latestForCwd', () => {
    it('returns the most recent session recorded for the given cwd', async () => {
      const makeSnapshot = (id: string, cwd: string, lastModified: number): SessionSnapshot => ({
        sessionId: id,
        messages: makeMessages(),
        state: { cwd, model: 'test-model', provider: 'test-provider', turnCount: 1, totalTokensUsed: 0 },
        metadata: { createdAt: lastModified, lastModified, toolsUsed: [] },
      });
      const older = makeSnapshot('s-old', '/repo', 1000);
      const newer = makeSnapshot('s-new', '/repo', 2000);
      const other = makeSnapshot('s-other', '/elsewhere', 3000);
      (memoryService.listSessions as any).mockResolvedValue([other, newer, older]);

      const found = await service.latestForCwd('/repo');
      expect(found?.sessionId).toBe('s-new');
    });

    it('returns null when no session matches the cwd', async () => {
      const makeSnapshot = (id: string, cwd: string): SessionSnapshot => ({
        sessionId: id,
        messages: makeMessages(),
        state: { cwd, model: 'test-model', provider: 'test-provider', turnCount: 1, totalTokensUsed: 0 },
        metadata: { createdAt: 1, lastModified: 1, toolsUsed: [] },
      });
      (memoryService.listSessions as any).mockResolvedValue([makeSnapshot('s-other', '/elsewhere')]);

      expect(await service.latestForCwd('/repo')).toBeNull();
    });
  });

  describe('startNew', () => {
    it('clears the engine, rotates the session id and resets counters', async () => {
      service.bumpTurn();
      service.noteEvent({
        type: 'agent:turn_complete',
        message: {} as any,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        timestamp: Date.now(),
      } as any);

      const engine = makeEngine();
      const newId = service.startNew(engine);

      expect(engine.clear).toHaveBeenCalledTimes(1);
      expect(newId).toMatch(/^session_/);
      expect(getState().sessionId).toBe(newId);

      await service.save(engine);
      const snapshot = (memoryService.saveSession as any).mock.calls[0][0] as SessionSnapshot;
      expect(snapshot.sessionId).toBe(newId);
      expect(snapshot.state.turnCount).toBe(0);
      expect(snapshot.state.totalTokensUsed).toBe(0);
      expect(snapshot.metadata.toolsUsed).toEqual([]);
    });
  });
});
