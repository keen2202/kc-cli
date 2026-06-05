import { logger } from '../services/logger';
// In-memory event bus for multi-agent communication

import type { AgentEvent } from '../state/types.js';
import type { MultiAgentEvent } from '../types/orchestrator.js';

type EventHandler = (event: AgentEvent | MultiAgentEvent) => void;
type AnyHandler = (agentId: string, event: AgentEvent | MultiAgentEvent) => void;

// ─── AGP Evolution Events ─────────────────────────────────────────────────

/**
 * AGP evolution event types for multi-agent coordination.
 */
export type EvolutionEventType =
  | 'evolution:started'
  | 'evolution:committed'
  | 'evolution:rolled_back'
  | 'evolution:resource_updated'
  | 'evolution:cycle_complete';

export interface EvolutionEvent {
  type: EvolutionEventType;
  timestamp: number;
  sessionId: string;
  iteration: number;
  resources?: string[];
  details?: Record<string, unknown>;
}

/**
 * EventBus - In-memory pub/sub system for agent communication
 *
 * Each sub-agent has its own event namespace (partitioned by agentId).
 * Supports async iteration for event consumption.
 */
export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private anyHandlers: Set<AnyHandler> = new Set();
  private eventBuffers: Map<string, Array<AgentEvent | MultiAgentEvent>> = new Map();

  // Constants
  private static readonly MAX_BUFFER_SIZE = 1000; // Max events per agent buffer

  /**
   * Emit an event for a specific agent
   */
  emit(agentId: string, event: AgentEvent | MultiAgentEvent): void {
    // Buffer the event with size limit
    if (!this.eventBuffers.has(agentId)) {
      this.eventBuffers.set(agentId, []);
    }
    const buffer = this.eventBuffers.get(agentId)!;
    if (buffer.length >= EventBus.MAX_BUFFER_SIZE) {
      // Drop oldest event to prevent unbounded growth
      // Use index-based removal instead of O(n) shift()
      buffer.splice(0, buffer.length - EventBus.MAX_BUFFER_SIZE + 1);
    }
    buffer.push(event);

    // Notify agent-specific handlers
    const agentHandlers = this.handlers.get(agentId);
    if (agentHandlers) {
      for (const handler of agentHandlers) {
        try {
          handler(event);
        } catch (error) {
          logger.orchestrator.error(`EventBus handler error for agent ${agentId}: ` + String(error));
        }
      }
    }

    // Notify "any" handlers
    for (const handler of this.anyHandlers) {
      try {
        handler(agentId, event);
      } catch (error) {
        logger.orchestrator.error(`EventBus any-handler error: ` + String(error));
      }
    }
  }

  /**
   * Subscribe to events for a specific agent
   */
  on(agentId: string, handler: EventHandler): () => void {
    if (!this.handlers.has(agentId)) {
      this.handlers.set(agentId, new Set());
    }
    this.handlers.get(agentId)!.add(handler);

    return () => {
      this.handlers.get(agentId)?.delete(handler);
    };
  }

  /**
   * Subscribe to once event for a specific agent
   */
  once(agentId: string, handler: EventHandler): () => void {
    const unsubscribe = this.on(agentId, (event) => {
      unsubscribe();
      handler(event);
    });
    return unsubscribe;
  }

  /**
   * Unsubscribe handler(s) for a specific agent
   */
  off(agentId: string, handler?: EventHandler): void {
    if (handler) {
      this.handlers.get(agentId)?.delete(handler);
    } else {
      this.handlers.delete(agentId);
    }
  }

  /**
   * Subscribe to all events from all agents
   */
  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /**
   * Get and clear buffered events for an agent
   */
  drain(agentId: string): Array<AgentEvent | MultiAgentEvent> {
    const buffer = this.eventBuffers.get(agentId) || [];
    this.eventBuffers.set(agentId, []);
    return buffer;
  }

  /**
   * Create a scoped event bus for a specific agent
   */
  createScoped(agentId: string): ScopedEventBus {
    return new ScopedEventBus(this, agentId);
  }

  /**
   * Clear all events and handlers
   */
  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
    this.eventBuffers.clear();
  }

  /**
   * Get all active agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.handlers.keys());
  }

  // ─── AGP Evolution Event Helpers ────────────────────────────────────────

  /**
   * Emit an evolution event to all agents.
   */
  emitEvolution(event: EvolutionEvent): void {
    // Use a pseudo-agent to avoid double-notifying onAny handlers
    this.emit('__evolution__', event as any);
  }

  /**
   * Subscribe to evolution events only.
   */
  onEvolution(handler: (event: EvolutionEvent) => void): () => void {
    return this.onAny((agentId, event) => {
      if (agentId === '__evolution__') {
        handler(event as unknown as EvolutionEvent);
      }
    });
  }
}

/**
 * ScopedEventBus - Event bus scoped to a specific agent
 * Automatically prefixes agentId for all operations
 */
export class ScopedEventBus {
  constructor(
    private parent: EventBus,
    private agentId: string
  ) {}

  emit(event: AgentEvent | MultiAgentEvent): void {
    this.parent.emit(this.agentId, event);
  }

  on(handler: EventHandler): () => void {
    return this.parent.on(this.agentId, handler);
  }

  once(handler: EventHandler): () => void {
    return this.parent.once(this.agentId, handler);
  }

  off(handler?: EventHandler): void {
    this.parent.off(this.agentId, handler);
  }

  drain(): Array<AgentEvent | MultiAgentEvent> {
    return this.parent.drain(this.agentId);
  }
}

/**
 * Create async iterator from event bus for a specific agent
 * Usage: for await (const event of eventsForAgent(bus, agentId)) { ... }
 */
export function eventsForAgent(
  bus: EventBus,
  agentId: string,
  signal?: AbortSignal
): AsyncIterableIterator<AgentEvent | MultiAgentEvent> {
  const queue: Array<AgentEvent | MultiAgentEvent> = [];
  let resolveNext: ((value: IteratorResult<AgentEvent | MultiAgentEvent>) => void) | null = null;
  let closed = false;

  const unsubscribe = bus.on(agentId, (event) => {
    if (closed) return;
    if (resolveNext) {
      resolveNext({ value: event, done: false });
      resolveNext = null;
    } else {
      queue.push(event);
    }
  });

  if (signal) {
    signal.addEventListener('abort', () => {
      closed = true;
      unsubscribe();
      if (resolveNext) {
        resolveNext({ value: undefined as unknown as AgentEvent | MultiAgentEvent, done: true });
        resolveNext = null;
      }
    });
  }

  return {
    async next(): Promise<IteratorResult<AgentEvent | MultiAgentEvent>> {
      if (closed) {
        return { value: undefined as unknown as AgentEvent | MultiAgentEvent, done: true };
      }
      if (queue.length > 0) {
        // Use index-based read instead of O(n) shift()
        const value = queue[0]!;
        queue.splice(0, 1);
        return { value, done: false };
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    async return(): Promise<IteratorResult<AgentEvent | MultiAgentEvent>> {
      closed = true;
      unsubscribe();
      return { value: undefined as unknown as AgentEvent | MultiAgentEvent, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
