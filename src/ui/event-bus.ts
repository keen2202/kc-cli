/**
 * UIEventBus - Middleware-capable event bus for the UI layer.
 *
 * Events flow: emit() → middleware chain → listeners.
 * Each middleware calls next() to continue the chain, or skips to block.
 */

import type { AgentEvent } from '../state/types';
import type { StreamEvent } from '../types/message';

export type UIEvent = AgentEvent | StreamEvent;

export type EventMiddleware = (
  event: UIEvent,
  next: () => void,
) => void;

export type EventHandler = (event: UIEvent) => void;

export class UIEventBus {
  private middlewares: EventMiddleware[] = [];
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private wildcardListeners: Set<EventHandler> = new Set();

  /**
   * Register a middleware. Middlewares run in registration order
   * before any listener receives the event.
   */
  use(middleware: EventMiddleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * Subscribe to events of a specific type.
   * Use '*' to subscribe to all events.
   * Returns an unsubscribe function.
   */
  on(type: string, handler: EventHandler): () => void {
    if (type === '*') {
      this.wildcardListeners.add(handler);
      return () => { this.wildcardListeners.delete(handler); };
    }

    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);

    return () => { this.listeners.get(type)?.delete(handler); };
  }

  /**
   * Emit an event through the middleware chain, then to listeners.
   */
  emit(event: UIEvent): void {
    let idx = 0;

    const next = (): void => {
      if (idx < this.middlewares.length) {
        const mw = this.middlewares[idx++]!;
        mw(event, next);
      } else {
        this.dispatch(event);
      }
    };

    next();
  }

  /**
   * Dispatch to listeners after middleware chain completes.
   */
  private dispatch(event: UIEvent): void {
    const type = (event as any).type as string;

    // Type-specific listeners
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (_err) {
          // Listener errors don't break the bus
        }
      }
    }

    // Wildcard listeners
    for (const handler of this.wildcardListeners) {
      try {
        handler(event);
      } catch (_err) {
        // Listener errors don't break the bus
      }
    }
  }

  /**
   * Remove all middlewares and listeners.
   */
  clear(): void {
    this.middlewares = [];
    this.listeners.clear();
    this.wildcardListeners.clear();
  }
}
