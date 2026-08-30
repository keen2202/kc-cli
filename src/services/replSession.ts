// REPL session persistence — parity with the ink UI's /session support.
//
// The bare-mode REPL (src/main.ts runREPL) previously kept the whole
// conversation in-process only: exiting or interrupting the REPL lost
// everything, while the ink UI already persisted sessions via
// SessionManager + QueryEngine.restoreSession. This service mirrors that
// flow for the non-UI path: a best-effort snapshot after each completed
// turn, plus list/load/new operations backing the /session command.

import { FileMemoryService } from '../memory/FileMemoryService';
import { SessionManager } from './sessionManager';
import { logger } from './logger';
import type { SessionSnapshot } from '../memory/types';
import type { AgentState, AgentEvent } from '../state/types';
import type { StreamEvent, ChatMessage } from '../query/protocol';
import { getState, updateState } from '../bootstrap/state';
import { getErrorMessage } from '../utils/errors';

/**
 * Minimal engine surface the REPL session service needs. QueryEngine
 * satisfies this structurally; tests can pass a lightweight fake.
 */
export interface ReplEngine {
  getMessages(): ChatMessage[];
  restoreSession(snapshot: SessionSnapshot): number;
  clear(): void;
}

export class ReplSessionService {
  private readonly memoryService: FileMemoryService;
  private readonly sessionManager: SessionManager;
  private initialized = false;
  private turnCount = 0;
  private totalTokensUsed = 0;
  private toolsUsed = new Set<string>();
  private createdAt = Date.now();
  private lastAutoSaveAt = 0;
  /** O5: how many best-effort saves have failed since the service was created. */
  private saveFailureCount = 0;

  /** Number of failed persistence attempts — surfaced via /status and at exit. */
  getSaveFailureCount(): number {
    return this.saveFailureCount;
  }

  constructor(
    memoryService: FileMemoryService = new FileMemoryService(),
    sessionManager: SessionManager = new SessionManager(memoryService)
  ) {
    this.memoryService = memoryService;
    this.sessionManager = sessionManager;
  }

  /** Lazily create the ~/.kc-cli/sessions directory the first time we touch it. */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.memoryService.initialize();
    this.initialized = true;
  }

  /** Count a new user submission (one REPL turn). */
  bumpTurn(): void {
    this.turnCount++;
  }

  /** Track token usage and tools used off the streamed event flow. */
  noteEvent(event: AgentEvent | StreamEvent): void {
    if (event.type === 'agent:turn_complete') {
      if (event.usage && typeof event.usage.totalTokens === 'number') {
        this.totalTokensUsed += event.usage.totalTokens;
      }
    } else if (event.type === 'agent:tool_started' || event.type === 'tool_use_start') {
      this.toolsUsed.add(event.toolCall.toolName);
    }
  }

  /**
   * Persist the current conversation to disk (best-effort). Mirrors the UI's
   * saveCurrentSession: never writes an empty session, and a save failure
   * must never break the REPL loop.
   */
  async save(engine: ReplEngine): Promise<void> {
    const messages = engine.getMessages();
    if (messages.length === 0) return; // never write an empty session
    try {
      await this.ensureInit();
      const state = getState();
      // saveSession only reads cwd/model/provider/turnCount/totalTokensUsed/
      // createdAt off the state, so construct just those fields.
      const stateSnapshot = {
        cwd: state.cwd,
        model: state.config?.model ?? 'unknown',
        provider: state.config?.provider ?? 'unknown',
        turnCount: this.turnCount,
        totalTokensUsed: this.totalTokensUsed,
        createdAt: this.createdAt,
      } as unknown as AgentState;
      await this.sessionManager.saveSession(
        state.sessionId,
        messages,
        stateSnapshot,
        Array.from(this.toolsUsed)
      );
    } catch (error) {
      // O5: persistence stays best-effort, but it must not be *silent* — a full
      // disk or a deleted `.kc-cli` previously looked exactly like a saved
      // session, and hours of conversation vanished without a trace.
      this.saveFailureCount++;
      logger.services.warn('session persistence failed (best-effort)', {
        sessionId: getState().sessionId,
        failureCount: this.saveFailureCount,
        reason: getErrorMessage(error),
      });
    }
  }

  /**
   * Throttled mid-query snapshot. Call on every agent:turn_complete: a single
   * submitMessage can run dozens of turns over hours, so persisting only after
   * the whole query finishes leaves a wide crash-loss window. With this, a
   * crash mid-query loses at most `minIntervalMs` worth of conversation.
   */
  async saveThrottled(engine: ReplEngine, minIntervalMs = 15_000): Promise<void> {
    const now = Date.now();
    if (now - this.lastAutoSaveAt < minIntervalMs) return;
    this.lastAutoSaveAt = now;
    await this.save(engine);
  }

  /** List recent saved sessions (most recent first). */
  async list(limit = 10): Promise<SessionSnapshot[]> {
    await this.ensureInit();
    return this.sessionManager.listRecentSessions(limit);
  }

  /**
   * Most recent saved session recorded for `cwd` (defaults to the current
   * working directory). Backs `kc --continue` / `kc --resume`: a crash loses
   * at most the window since the last throttled save, and the next `kc
   * --continue` picks the conversation back up in this repo.
   */
  async latestForCwd(cwd: string = getState().cwd, limit = 50): Promise<SessionSnapshot | null> {
    const sessions = await this.list(limit);
    return sessions.find((s) => s.state?.cwd === cwd) ?? null;
  }

  /**
   * Load a saved session into the engine. Returns null when the id is
   * unknown; throws when the snapshot fails restoreSession validation (in
   * which case the current session is left untouched). On success the
   * internal counters re-sync from the snapshot so subsequent saves
   * continue the restored session.
   */
  async load(engine: ReplEngine, sessionId: string): Promise<SessionSnapshot | null> {
    await this.ensureInit();
    const loaded = await this.sessionManager.loadSession(sessionId);
    if (!loaded) return null;
    const restoredTurnCount = engine.restoreSession(loaded);
    this.turnCount = restoredTurnCount;
    this.totalTokensUsed = loaded.state.totalTokensUsed ?? 0;
    this.toolsUsed = new Set(loaded.metadata?.toolsUsed ?? []);
    this.createdAt = loaded.metadata?.createdAt ?? Date.now();
    updateState({ sessionId: loaded.sessionId || sessionId });
    return loaded;
  }

  /** Start a fresh session: clear the engine, rotate the session id, reset counters. */
  startNew(engine: ReplEngine): string {
    const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    engine.clear();
    this.turnCount = 0;
    this.totalTokensUsed = 0;
    this.toolsUsed.clear();
    this.createdAt = Date.now();
    updateState({ sessionId: newId });
    return newId;
  }
}
