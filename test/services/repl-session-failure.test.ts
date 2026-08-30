// O5: session persistence failures must be visible, not silently swallowed — round4 §4-O5

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplSessionService, type ReplEngine } from '../../src/services/replSession';
import { SessionManager } from '../../src/services/sessionManager';
import type { FileMemoryService } from '../../src/memory/FileMemoryService';
import type { SessionSnapshot } from '../../src/memory/types';
import { initializeState } from '../../src/bootstrap/state';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';
import type { ChatMessage } from '../../src/query/protocol';

function failingMemoryService(): FileMemoryService {
  return {
    initialize: vi.fn(),
    saveSession: vi.fn(async () => {
      throw new Error('ENOSPC: no space left on device');
    }),
    loadSession: vi.fn(),
    listSessions: vi.fn(),
  } as unknown as FileMemoryService;
}

function makeEngine(): ReplEngine {
  const messages = [
    { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
  ] as ChatMessage[];
  return { getMessages: () => messages, restoreSession: vi.fn(), clear: vi.fn() };
}

describe('O5: ReplSessionService surfaces save failures', () => {
  let spy: LoggerSpy;

  beforeEach(() => {
    initializeState({
      sessionId: 'repl-o5',
      cwd: process.cwd(),
      projectRoot: null,
      permissionMode: 'normal',
      verbose: false,
      printMode: false,
      bareMode: false,
      maxTurns: null,
      maxBudgetUsd: null,
      config: null,
    });
  });

  afterEach(() => {
    spy?.stop();
  });

  it('warns and increments saveFailureCount when saveSession throws', async () => {
    spy = spyOnLogger('services', ['warn']);
    const memory = failingMemoryService();
    const service = new ReplSessionService(memory, new SessionManager(memory));

    await service.save(makeEngine()); // must not throw
    await service.save(makeEngine()); // and must keep working on repeat failure

    expect(service.getSaveFailureCount()).toBe(2);
    expect(spy.calls.length).toBe(2);
    const call = spy.calls[0]!;
    expect(call.message).toBe('session persistence failed (best-effort)');
    expect(call.data).toMatchObject({
      sessionId: 'repl-o5',
      failureCount: 1,
      reason: expect.stringContaining('ENOSPC'),
    });
  });

  it('does not count failures for the empty-session guard (no write attempted)', async () => {
    spy = spyOnLogger('services', ['warn']);
    const memory = failingMemoryService();
    const service = new ReplSessionService(memory, new SessionManager(memory));
    const engine: ReplEngine = { getMessages: () => [], restoreSession: vi.fn(), clear: vi.fn() };

    await service.save(engine);

    expect(service.getSaveFailureCount()).toBe(0);
    expect(spy.calls.length).toBe(0);
  });
});
