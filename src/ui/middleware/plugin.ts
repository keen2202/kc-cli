import type { EventMiddleware, UIEvent } from '../event-bus';
import type { ToolCall } from '../../query/protocol';

export interface PluginEventHooks {
  onToolStart?(toolCall: ToolCall): void;
  onToolComplete?(toolCall: ToolCall, result: any): void;
  onTurnComplete?(message: any, usage: any): void;
  onError?(error: Error, recoverable: boolean): void;
  onTextDelta?(text: string): void;
}

/**
 * PluginMiddleware - Routes events to registered plugin hooks.
 */
export function createPluginMiddleware(): EventMiddleware & { register(hooks: PluginEventHooks): void } {
  const hooks: PluginEventHooks[] = [];

  const middleware: EventMiddleware = (event: UIEvent, next: () => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = event as any;
    const type = (ev.type || '').startsWith('agent:') ? (ev.type as string).slice(6) : (ev.type || '');

    for (const hook of hooks) {
      try {
        switch (type) {
          case 'tool_started':
            hook.onToolStart?.(ev.toolCall);
            break;
          case 'tool_completed':
            hook.onToolComplete?.(ev.toolCall, ev.result);
            break;
          case 'turn_complete':
            hook.onTurnComplete?.(ev.message, ev.usage);
            break;
          case 'error':
            hook.onError?.(ev.error, ev.recoverable);
            break;
          case 'text_delta':
            hook.onTextDelta?.(ev.text);
            break;
        }
      } catch (_err) {
        // Plugin errors don't break the pipeline
      }
    }

    next();
  };

  return Object.assign(middleware, {
    register: (h: PluginEventHooks) => { hooks.push(h); },
  });
}
