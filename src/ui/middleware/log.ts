import type { EventMiddleware, UIEvent } from '../event-bus';

/**
 * LogMiddleware - Logs all events when verbose mode is on.
 * Format: [HH:MM:SS.mmm] event.type {key=data}
 */
export function createLogMiddleware(verbose: boolean): EventMiddleware {
  return (event: UIEvent, next: () => void) => {
    if (verbose) {
      const now = new Date();
      const ts = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join(':') + '.' + String(now.getMilliseconds()).padStart(3, '0');

      const type = (event as any).type || 'unknown';
      const extras = Object.keys(event)
        .filter(k => k !== 'type' && k !== 'timestamp')
        .map(k => {
          const v = (event as any)[k];
          const display = typeof v === 'object' ? '{…}' : String(v).slice(0, 50);
          return `${k}=${display}`;
        })
        .join(' ');

      const suffix = extras ? ` {${extras}}` : '';
      process.stderr.write(`[${ts}] ${type}${suffix}\n`);
    }

    next();
  };
}
