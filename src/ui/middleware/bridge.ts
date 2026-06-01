import type { EventMiddleware, UIEvent } from '../event-bus';

interface BridgeWriter {
  write(event: UIEvent): void;
  close(): void;
}

/**
 * BridgeMiddleware - Forward events as NDJSON to stdout when --json flag is set.
 * Each line: {"type":"...","payload":{...},"timestamp":...}
 */
export function createBridgeMiddleware(): EventMiddleware & { enable(): void; disable(): void; isEnabled(): boolean } {
  let enabled = false;

  const middleware: EventMiddleware = (event: UIEvent, next: () => void) => {
    if (enabled) {
      const line = JSON.stringify({
        type: (event as any).type || 'unknown',
        payload: event,
        timestamp: Date.now(),
      });
      process.stdout.write(line + '\n');
    }

    next();
  };

  return Object.assign(middleware, {
    enable: () => { enabled = true; },
    disable: () => { enabled = false; },
    isEnabled: () => enabled,
  });
}

/**
 * Create a bridge writer for structured output.
 */
export function createBridgeWriter(sessionId: string): BridgeWriter {
  let sequence = 0;

  return {
    write(event: UIEvent): void {
      const msg = {
        type: 'event',
        payload: event,
        sessionId,
        sequence: sequence++,
      };
      process.stdout.write(JSON.stringify(msg) + '\n');
    },
    close(): void {
      // No-op for stdout writer
    },
  };
}
