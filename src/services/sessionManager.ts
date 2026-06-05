// Session manager - handles session persistence, recovery, and lifecycle

import type { SessionSnapshot, SessionFilter } from '../memory/types';
import { FileMemoryService } from '../memory/FileMemoryService';
import type { AgentState } from '../state/types';
import type { ChatMessage } from '../query/protocol';

export class SessionManager {
  private memoryService: FileMemoryService;
  private currentSessionId: string | null = null;

  constructor(memoryService: FileMemoryService) {
    this.memoryService = memoryService;
  }

  /**
   * Set the current session ID
   */
  setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Save the current session state
   */
  async saveSession(
    sessionId: string,
    messages: ChatMessage[],
    state: AgentState,
    toolsUsed: string[]
  ): Promise<void> {
    const snapshot: SessionSnapshot = {
      sessionId,
      messages,
      state: {
        cwd: state.cwd,
        model: state.model,
        provider: state.provider,
        turnCount: state.turnCount,
        totalTokensUsed: state.totalTokensUsed,
      },
      metadata: {
        createdAt: state.createdAt,
        lastModified: Date.now(),
        toolsUsed,
      },
    };

    await this.memoryService.saveSession(snapshot);
  }

  /**
   * Load a session by ID
   * Returns the session data if found, null otherwise
   */
  async loadSession(
    sessionId: string
  ): Promise<{
    messages: ChatMessage[];
    state: {
      cwd: string;
      model: string;
      provider: string;
      turnCount: number;
      totalTokensUsed: number;
    };
    metadata: {
      createdAt: number;
      lastModified: number;
      toolsUsed: string[];
    };
  } | null> {
    const snapshot = await this.memoryService.loadSession(sessionId);
    if (!snapshot) {
      return null;
    }

    return {
      messages: snapshot.messages,
      state: snapshot.state,
      metadata: snapshot.metadata,
    };
  }

  /**
   * List recent sessions
   */
  async listRecentSessions(limit: number = 20): Promise<SessionSnapshot[]> {
    const filter: SessionFilter = {
      limit,
    };
    return this.memoryService.listSessions(filter);
  }

  /**
   * Archive a session
   */
  async archiveSession(sessionId: string): Promise<void> {
    await this.memoryService.archiveSession(sessionId);
  }

  /**
   * Delete a session permanently
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.memoryService.deleteSession(sessionId);
  }

  /**
   * Prune old sessions beyond retention period
   */
  async pruneOldSessions(retentionDays: number): Promise<number> {
    return this.memoryService.pruneOldSessions(retentionDays);
  }

  /**
   * Get statistics for a session
   */
  async getSessionStats(sessionId: string): Promise<{
    sessionId: string;
    turnCount: number;
    totalTokensUsed: number;
    toolsUsed: string[];
    createdAt: number;
    lastModified: number;
    messageCount: number;
  } | null> {
    const snapshot = await this.memoryService.loadSession(sessionId);
    if (!snapshot) {
      return null;
    }

    return {
      sessionId: snapshot.sessionId,
      turnCount: snapshot.state.turnCount,
      totalTokensUsed: snapshot.state.totalTokensUsed,
      toolsUsed: snapshot.metadata.toolsUsed,
      createdAt: snapshot.metadata.createdAt,
      lastModified: snapshot.metadata.lastModified,
      messageCount: snapshot.messages.length,
    };
  }

  /**
   * Get the most recent session (for resume prompt)
   */
  async getLastSession(): Promise<SessionSnapshot | null> {
    const sessions = await this.listRecentSessions(1);
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * Clear the current session ID
   */
  clearCurrentSession(): void {
    this.currentSessionId = null;
  }
}
