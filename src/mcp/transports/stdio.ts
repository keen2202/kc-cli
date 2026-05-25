// MCP stdio transport - wraps @modelcontextprotocol/sdk StdioClientTransport

import { spawn, type ChildProcess } from 'child_process';
import type { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from '../types';

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
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private notificationHandler: ((notification: JSONRPCNotification) => void) | null = null;
  private sdkTransport: { connect(): Promise<void>; sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): Promise<void> } | null = null;
  private useSdk = false;
  private isDisconnecting = false;

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
    } catch {
      // SDK not available, fall back to hand-rolled implementation
    }

    return new Promise((resolve, reject) => {
      const mergedEnv = { ...process.env, ...env };

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
      });

      this._onProcessError = (err: Error) => {
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
        if (this.isDisconnecting) return;
        this.process = null;
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`MCP server exited with code ${code}`));
        }
        this.pendingRequests.clear();
      };
      this.process.on('exit', this._onProcessExit);

      // Give the process a moment to start
      setTimeout(() => {
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
      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 30000);
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
    this.isDisconnecting = false;
  }

  isConnected(): boolean {
    if (this.useSdk && this.sdkTransport) {
      return true;
    }
    return this.process !== null && !this.process.killed;
  }

  private processBuffer(): void {
    // indexOf-based incremental parsing instead of split('\n') to avoid allocating array for entire buffer
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        this.handleMessage(message);
      } catch {
        // Ignore malformed lines
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
