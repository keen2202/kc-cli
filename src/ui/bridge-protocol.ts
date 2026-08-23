import type { UIEvent } from './event-bus';

/**
 * Bridge message protocol for IDE integration.
 * Wraps events with session ID and sequence number.
 */
export interface BridgeMessage {
  type: 'event' | 'command' | 'response';
  payload: UIEvent | BridgeCommand | BridgeResponse;
  sessionId: string;
  sequence: number;
}

export interface BridgeCommand {
  action: 'cancel' | 'steer' | 'close';
  data?: string;
}

export interface BridgeResponse {
  status: 'ok' | 'error';
  message?: string;
}

/**
 * Create a bridge writer that handles framing and buffering.
 *
 * @internal Kept despite zero current callers (audit round3 T11): designated
 * implementation vehicle for the open JSON-output mode
 * (`docs/specs/ui-event-system-tasks.md` Phase 7 T7.1/T7.3; the `--json` CLI
 * flag already exists unwired in `bootstrap/cli-config.ts`). Delete if Phase 7
 * has not landed by one release after audit round 3.
 */
export function createBridgeWriter(sessionId: string) {
  let sequence = 0;

  return {
    writeEvent(event: UIEvent): void {
      const msg: BridgeMessage = {
        type: 'event',
        payload: event,
        sessionId,
        sequence: sequence++,
      };
      process.stdout.write(JSON.stringify(msg) + '\n');
    },

    writeResponse(response: BridgeResponse): void {
      const msg: BridgeMessage = {
        type: 'response',
        payload: response,
        sessionId,
        sequence: sequence++,
      };
      process.stdout.write(JSON.stringify(msg) + '\n');
    },

    getSequence(): number {
      return sequence;
    },

    getSessionId(): string {
      return sessionId;
    },
  };
}
