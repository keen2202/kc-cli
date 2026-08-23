import { logger } from '../services/logger';
import type {
  IMAdapter,
  IMMessage,
  IMContent,
  IMBridgeConfig,
  IMQueryEngineLike,
  IMSession,
  IMNotificationTarget,
  EngineFactory,
  IMPlatform,
} from './protocol';
import type { AgentEvent } from '../state/types';

interface IMSessionState {
  session: IMSession;
  engine: IMQueryEngineLike;
  processing: boolean;
  messageQueue: IMMessage[];
}

export class IMBridge {
  private adapters = new Map<IMPlatform, IMAdapter>();
  private sessions = new Map<string, IMSessionState>();
  private channelToSession = new Map<string, string>();
  private config: IMBridgeConfig;
  private engineFactory: EngineFactory;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: IMBridgeConfig, engineFactory: EngineFactory) {
    this.config = config;
    this.engineFactory = engineFactory;
  }

  registerAdapter(adapter: IMAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((message) => {
      this.handleInboundMessage(message).catch((err) => {
        logger.services.error(`[IMBridge] Error handling message from ${adapter.platform}: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  async startAll(): Promise<void> {
    const tasks = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.connect();
        logger.services.info(`[IMBridge] ${adapter.name} connected`);
      } catch (err) {
        logger.services.error(`[IMBridge] Failed to connect ${adapter.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    await Promise.allSettled(tasks);
    this.startSessionCleanup();
  }

  async shutdownAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const tasks = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    });
    await Promise.allSettled(tasks);

    for (const [, state] of this.sessions) {
      state.engine.abort('IMBridge shutdown');
    }
    this.sessions.clear();
    this.channelToSession.clear();
  }

  async notify(target: IMNotificationTarget, content: IMContent): Promise<void> {
    const adapter = this.adapters.get(target.platform);
    if (!adapter || !adapter.isConnected()) {
      logger.services.warn(`[IMBridge] Cannot notify: ${target.platform} adapter not connected`);
      return;
    }

    const message: IMMessage = {
      id: `notify-${Date.now()}`,
      platform: target.platform,
      direction: 'outbound',
      channelType: target.channelType,
      channelId: target.channelId,
      senderId: 'kc-cli',
      content,
      timestamp: Date.now(),
    };

    await adapter.sendMessage(message);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getAdapterStatus(): Array<{ platform: IMPlatform; connected: boolean }> {
    return Array.from(this.adapters.values()).map((a) => ({
      platform: a.platform,
      connected: a.isConnected(),
    }));
  }

  private async handleInboundMessage(message: IMMessage): Promise<void> {
    const sessionState = await this.getOrCreateSession(message);

    if (sessionState.processing) {
      const maxQueue = this.config.session.maxQueueSize;
      if (sessionState.messageQueue.length >= maxQueue) {
        logger.services.warn(`[IMBridge] Queue full for session ${sessionState.session.sessionId}, dropping message`);
        return;
      }
      sessionState.messageQueue.push(message);
      return;
    }

    await this.processMessage(sessionState, message);
  }

  private async processMessage(sessionState: IMSessionState, message: IMMessage): Promise<void> {
    const { engine, session } = sessionState;
    sessionState.processing = true;
    session.lastActivityAt = Date.now();
    session.messageCount++;

    const text = this.extractText(message.content);
    if (!text) {
      sessionState.processing = false;
      return;
    }

    let accumulated = '';
    try {
      for await (const event of engine.submitMessage(text)) {
        const agentEvent = event as AgentEvent;
        if (agentEvent.type === 'agent:text_delta') {
          accumulated += agentEvent.text;
        } else if (agentEvent.type === 'agent:complete') {
          if (accumulated.trim()) {
            await this.sendReply(message, accumulated.trim());
          }
          break;
        } else if (agentEvent.type === 'agent:error') {
          await this.sendReply(message, `[Error] ${agentEvent.error.message}`);
          break;
        }
      }
    } catch (err) {
      logger.services.error(`[IMBridge] Processing error: ${err instanceof Error ? err.message : String(err)}`);
      await this.sendReply(message, '[Error] Failed to process your message').catch(err => { logger.services.error('[IMBridge] Failed to send reply', err); });
    }

    sessionState.processing = false;
    this.drainQueue(sessionState);
  }

  private async drainQueue(sessionState: IMSessionState): Promise<void> {
    if (sessionState.messageQueue.length === 0) return;

    const next = sessionState.messageQueue.shift()!;
    await this.processMessage(sessionState, next);
  }

  private async sendReply(original: IMMessage, text: string): Promise<void> {
    const adapter = this.adapters.get(original.platform);
    if (!adapter || !adapter.isConnected()) return;

    const reply: IMMessage = {
      id: `reply-${Date.now()}`,
      platform: original.platform,
      direction: 'outbound',
      channelType: original.channelType,
      channelId: original.channelId,
      senderId: 'kc-cli',
      content: { type: 'text', text },
      replyTo: original.id,
      timestamp: Date.now(),
    };

    await adapter.sendMessage(reply);
  }

  private async getOrCreateSession(message: IMMessage): Promise<IMSessionState> {
    const key = `${message.platform}:${message.channelType}:${message.channelId}`;
    const existingId = this.channelToSession.get(key);

    if (existingId) {
      const state = this.sessions.get(existingId);
      if (state && state.session.status !== 'expired' && state.engine) {
        return state;
      }
    }

    const maxSessions = this.config.session.maxSessions;
    if (this.sessions.size >= maxSessions) {
      this.evictOldestSession();
    }

    const sessionId = `im-${message.platform}-${Date.now()}`;
    const session: IMSession = {
      sessionId,
      platform: message.platform,
      channelId: message.channelId,
      channelType: message.channelType,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      status: 'active',
    };

    let engine: IMQueryEngineLike;
    try {
      engine = await this.engineFactory();
    } catch (err) {
      logger.services.error(`[IMBridge] Failed to create engine for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const state: IMSessionState = {
      session,
      engine,
      processing: false,
      messageQueue: [],
    };

    this.sessions.set(sessionId, state);
    this.channelToSession.set(key, sessionId);

    logger.services.info(`[IMBridge] Created session ${sessionId} for ${key}`);
    return state;
  }

  private evictOldestSession(): void {
    let oldest: IMSessionState | null = null;
    for (const [, state] of this.sessions) {
      if (!oldest || state.session.lastActivityAt < oldest.session.lastActivityAt) {
        oldest = state;
      }
    }
    if (oldest) {
      this.destroySession(oldest.session.sessionId);
    }
  }

  private destroySession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.engine?.abort?.('Session destroyed');
    const key = `${state.session.platform}:${state.session.channelType}:${state.session.channelId}`;
    this.channelToSession.delete(key);
    this.sessions.delete(sessionId);
    logger.services.info(`[IMBridge] Destroyed session ${sessionId}`);
  }

  private startSessionCleanup(): void {
    const intervalMs = 60_000; // Check every minute
    this.cleanupTimer = setInterval(() => {
      const timeoutMs = this.config.session.timeoutMinutes * 60_000;
      const now = Date.now();

      for (const [id, state] of this.sessions) {
        if (now - state.session.lastActivityAt > timeoutMs) {
          state.session.status = 'expired';
          this.destroySession(id);
        }
      }
    }, intervalMs);

    // Allow Node.js to exit even if timer is active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private extractText(content: IMContent): string | null {
    if (content.type === 'text') return content.text;
    return null;
  }
}
