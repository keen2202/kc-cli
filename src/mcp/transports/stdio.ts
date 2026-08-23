// MCP stdio transport - wraps @modelcontextprotocol/sdk StdioClientTransport

import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'node:module';
import type { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from '../types';
import { logger } from '../../services/logger';

// ESM-compatible require for optionally loading the MCP SDK transport (CommonJS)
const require = createRequire(import.meta.url);

type MessageHandler = (message: JSONRPCResponse | JSONRPCNotification) => void;

/**
 * StdioTransport wraps the MCP SDK's StdioClientTransport while
 * preserving the existing public API (connect, sendRequest, disconnect).
 *
 * The SDK handles JSON-RPC framing, message IDs, and buffer management.
 * Falls back to hand-rolled implementation if SDK is not installed.
 */
export class StdioTransport {
  private process: ChildProcess | null = null;
  private buffer = '';
  private contentLength = -1;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationHandler: ((notification: JSONRPCNotification) => void) | null = null;
  private sdkTransport: { connect(): Promise<void>; sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): Promise<void> } | null = null;
  private useSdk = false;
  private isDisconnecting = false;
  private _connectReject: ((err: Error) => void) | null = null;

  // Store event handler references for cleanup
  private _onProcessError: ((err: Error) => void) | null = null;
  private _onStdoutData: ((data: Buffer) => void) | null = null;
  private _onStderrData: ((data: Buffer) => void) | null = null;
  private _onProcessExit: ((code: number | null) => void) | null = null;

  async connect(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    this.isDisconnecting = false;

    // Try to use SDK transport if available
    try {
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
      this.sdkTransport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env },
      });
      await this.sdkTransport!.connect();
      this.useSdk = true;
      return;
    } catch (err) {
      // Optional-dependency feature detection: the SDK is not installed (or
      // failed to load), which is a supported configuration — fall back to the
      // hand-rolled implementation below. Logged at debug so the fallback is
      // observable without turning "SDK absent" into an error-level signal.
      logger.mcp.debug('[MCP stdio] SDK transport unavailable — using built-in framing fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return new Promise((resolve, reject) => {
      this._connectReject = reject;
      const mergedEnv = { ...process.env, ...env };

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
      });

      this._onProcessError = (err: Error) => {
        clearTimeout(startupTimer);
        reject(new Error(`Failed to spawn MCP server: ${err.message}`));
      };
      this.process.on('error', this._onProcessError);

      this._onStdoutData = (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      };
      this.process.stdout?.on('data', this._onStdoutData);

      this._onStderrData = (_data: Buffer) => {
        // stderr is used for logging in MCP servers, ignore silently
      };
      this.process.stderr?.on('data', this._onStderrData);

      this._onProcessExit = (code: number | null) => {
        clearTimeout(startupTimer);
        if (this.isDisconnecting) return;
        // Reject pending connect if process exits before startup completes
        if (this._connectReject) {
          this._connectReject(new Error(`MCP server exited with code ${code}`));
          this._connectReject = null;
        }
        // PERF-05: Clear all pending request timers before rejecting
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`MCP server exited with code ${code}`));
        }
        this.pendingRequests.clear();
        this.process = null;
      };
      this.process.on('exit', this._onProcessExit);

      // Give the process a moment to start — save handle for cleanup
      const startupTimer = setTimeout(() => {
        this._connectReject = null;
        if (this.process) resolve();
        else reject(new Error('MCP server process failed to start'));
      }, 100);
    });
  }

  async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.useSdk && this.sdkTransport) {
      return this.sdkTransport.sendRequest(method, params);
    }

    if (!this.process || !this.process.stdin) {
      throw new Error('MCP transport not connected');
    }

    const id = ++this.messageId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      // PERF-05: Save timer handle so it can be cleared on response or disconnect
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const message = JSON.stringify(request);
      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
      this.process!.stdin!.write(header + message);
    });
  }

  onNotification(handler: (notification: JSONRPCNotification) => void): void {
    this.notificationHandler = handler;
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;

    if (this.useSdk && this.sdkTransport) {
      await this.sdkTransport.close();
      this.sdkTransport = null;
      this.useSdk = false;
      this.isDisconnecting = false;
      return;
    }

    // PERF-05: Clear all pending request timers on disconnect
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP transport disconnected'));
    }
    this.pendingRequests.clear();

    if (this.process) {
      // Remove event listeners to prevent leaks on reconnect
      if (this._onProcessError) {
        this.process.removeListener('error', this._onProcessError);
        this._onProcessError = null;
      }
      if (this._onStdoutData && this.process.stdout) {
        this.process.stdout.removeListener('data', this._onStdoutData);
        this._onStdoutData = null;
      }
      if (this._onStderrData && this.process.stderr) {
        this.process.stderr.removeListener('data', this._onStderrData);
        this._onStderrData = null;
      }
      if (this._onProcessExit) {
        this.process.removeListener('exit', this._onProcessExit);
        this._onProcessExit = null;
      }

      this.process.kill('SIGTERM');
      // Give it a moment, then force kill
      const currentProcess = this.process;
      setTimeout(() => {
        if (currentProcess && !currentProcess.killed) {
          currentProcess.kill('SIGKILL');
        }
      }, 2000);
      this.process = null;
    }
    this.pendingRequests.clear();
    this.buffer = '';
    this.contentLength = -1;
    this.isDisconnecting = false;
  }

  isConnected(): boolean {
    if (this.useSdk && this.sdkTransport) {
      return true;
    }
    return this.process !== null && !this.process.killed;
  }

  private processBuffer(): void {
    // Content-Length framed parsing per MCP specification.
    // Handles partial messages, multiple messages in a single buffer,
    // and messages split across buffer boundaries.
    while (true) {
      // Phase 1: Parse header to get content length
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // Header not complete yet

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Malformed header - discard and try next
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      // Phase 2: Wait for complete body
      if (this.buffer.length < this.contentLength) return;

      // Phase 3: Extract and parse body
      const body = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch (err) {
        // Data-path failure: a complete Content-Length frame failed to parse.
        // The transport stays alive (MCP servers may emit non-JSON frames), but
        // the corruption is surfaced. Payload content is never logged — only
        // its size — so message contents cannot leak into logs.
        logger.mcp.warn('[MCP stdio] Dropping malformed JSON-RPC frame', {
          error: err instanceof Error ? err.message : String(err),
          bytes: body.length,
        });
      }
    }
  }

  private handleMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    if ('id' in message && message.id !== undefined) {
      // This is a response
      const response = message as JSONRPCResponse;
      const pending = this.pendingRequests.get(response.id as number);
      if (pending) {
        this.pendingRequests.delete(response.id as number);
        // PERF-05: Clear the timeout timer on response
        clearTimeout(pending.timer);
        if (response.error) {
          pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      }
    } else if ('method' in message) {
      // This is a notification
      if (this.notificationHandler) {
        this.notificationHandler(message as JSONRPCNotification);
      }
    }
  }
}
