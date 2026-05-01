// MCP HTTP+SSE transport - wraps @modelcontextprotocol/sdk StreamableHTTPClientTransport

import type { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from '../types';

/**
 * HttpTransport wraps the MCP SDK's StreamableHTTPClientTransport while
 * preserving the existing public API.
 *
 * The SDK handles SSE parsing, reconnection, and OAuth token refresh.
 * Falls back to hand-rolled implementation if SDK is not installed.
 */
export class HttpTransport {
  private url: string = '';
  private headers: Record<string, string> = {};
  private messageId = 0;
  private notificationHandler: ((notification: JSONRPCNotification) => void) | null = null;
  private connected = false;
  private sdkTransport: any | null = null;
  private useSdk = false;

  async connect(url: string, headers?: Record<string, string>): Promise<void> {
    this.url = url;
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    };

    // Try to use SDK transport if available
    try {
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      this.sdkTransport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: this.headers },
      });
      await this.sdkTransport.connect();
      this.useSdk = true;
      this.connected = true;
      return;
    } catch {
      // SDK not available, fall back to hand-rolled implementation
    }

    this.connected = true;
  }

  async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.useSdk && this.sdkTransport) {
      return this.sdkTransport.sendRequest(method, params);
    }

    if (!this.connected) {
      throw new Error('HTTP transport not connected');
    }

    const id = ++this.messageId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };

    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
    }

    // Check if response is SSE
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return this.handleSSEResponse(response, id);
    }

    // JSON response
    const data = await response.json() as JSONRPCResponse;
    if (data.error) {
      throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    }
    return data.result;
  }

  onNotification(handler: (notification: JSONRPCNotification) => void): void {
    this.notificationHandler = handler;
  }

  async disconnect(): Promise<void> {
    if (this.useSdk && this.sdkTransport) {
      await this.sdkTransport.close();
      this.sdkTransport = null;
      this.useSdk = false;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async handleSSEResponse(response: Response, requestId: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let result: unknown = undefined;
    let hasResult = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = '';
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            if (line.startsWith('data: ')) dataStr = line.slice(6);
          }

          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr);

            if (eventType === 'message' || !eventType) {
              if ('id' in data && data.id === requestId) {
                // This is our response
                if (data.error) {
                  throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
                }
                result = data.result;
                hasResult = true;
              } else if ('method' in data) {
                // Notification
                this.notificationHandler?.(data);
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('MCP error')) throw e;
            // Ignore parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!hasResult) {
      throw new Error('MCP SSE stream ended without result');
    }
    return result;
  }
}
