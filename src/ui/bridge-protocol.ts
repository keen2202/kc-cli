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
