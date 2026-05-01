// ACP JSON-RPC Server over stdio

import type { ACPRequest, ACPResponse, ACPNotification, ACPSessionInfo } from './types';
import { QueryEngine } from '../query/QueryEngine';
import {
  handleInitialize,
  handleAgentRun,
  handleAgentCancel,
  handleSessionList,
  type ACPHandlerState,
} from './handlers';

export class ACPServer {
  private buffer = '';
  private sessions = new Map<string, { engine: QueryEngine; info: ACPSessionInfo }>();
  private running = false;

  private handlerState: ACPHandlerState;

  constructor() {
    this.handlerState = {
      sessions: this.sessions,
      sendResult: (id, result) => this.sendResult(id, result),
      sendError: (id, code, message) => this.sendError(id, code, message),
      sendNotification: (method, params) => this.sendNotification(method, params),
    };
  }

  async start(): Promise<void> {
    this.running = true;

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      this.running = false;
    });

    // Keep alive
    await new Promise<void>((resolve) => {
      process.stdin.on('end', resolve);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as ACPRequest;
        this.handleRequest(request);
      } catch {
        this.sendError(null, -32700, 'Parse error');
      }
    }
  }

  private async handleRequest(request: ACPRequest): Promise<void> {
    try {
      switch (request.method) {
        case 'initialize':
          await handleInitialize(request, this.handlerState);
          break;
        case 'agent/run':
          await handleAgentRun(request, this.handlerState);
          break;
        case 'agent/cancel':
          handleAgentCancel(request, this.handlerState);
          break;
        case 'session/list':
          handleSessionList(request, this.handlerState);
          break;
        default:
          this.sendError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      this.sendError(request.id, -32603, error instanceof Error ? error.message : 'Internal error');
    }
  }

  private sendResult(id: number | string, result: unknown): void {
    const response: ACPResponse = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendError(id: number | string | null, code: number, message: string): void {
    const response: ACPResponse = { jsonrpc: '2.0', id: id ?? 0, error: { code, message } };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: ACPNotification = { jsonrpc: '2.0', method, params };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }
}
