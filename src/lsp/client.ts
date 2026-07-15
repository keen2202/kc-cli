// LSP Client Manager - connects to language servers

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { LSPDiagnostic, LSPHover, LSPLocation, LanguageId } from './types';
import { getCacheManager } from '../services/cache';

interface LSPMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ServerProcess {
  process: ChildProcess;
  buffer: string;
  messageId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  languageId: LanguageId;
  rootUri: string;
}

const LANGUAGE_SERVER_COMMANDS: Record<LanguageId, { cmd: string; args: string[] }> = {
  typescript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  javascript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  go: { cmd: 'gopls', args: [] },
  python: { cmd: 'pylsp', args: [] },
  rust: { cmd: 'rust-analyzer', args: [] },
  unknown: { cmd: '', args: [] },
};

export function detectLanguage(filePath: string): LanguageId {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, LanguageId> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.go': 'go',
    '.py': 'python',
    '.rs': 'rust',
  };
  return map[ext] || 'unknown';
}

export class LSPClientManager {
  private servers = new Map<LanguageId, ServerProcess>();
  private diagnosticCache = getCacheManager().getOrCreate<LSPDiagnostic[]>(
    'lsp-diagnostics', 'lsp', { maxSize: 500 }
  );
  private pendingDiagnostics = new Map<string, { resolve: (d: LSPDiagnostic[]) => void; timer: ReturnType<typeof setTimeout> }>();

  async connect(languageId: LanguageId, rootUri: string): Promise<boolean> {
    if (this.servers.has(languageId)) return true;

    const cmdConfig = LANGUAGE_SERVER_COMMANDS[languageId];
    if (!cmdConfig.cmd) return false;

    try {
      const proc = spawn(cmdConfig.cmd, cmdConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const server: ServerProcess = {
        process: proc,
        buffer: '',
        messageId: 0,
        pending: new Map(),
        languageId,
        rootUri,
      };

      proc.stdout?.on('data', (data: Buffer) => {
        server.buffer += data.toString();
        this.processBuffer(server);
      });

      proc.on('error', () => {
        // PERF-04: Clear pending request timers before removing server
        for (const [, pending] of server.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('LSP server process exited'));
        }
        server.pending.clear();
        this.servers.delete(languageId);
      });

      proc.on('exit', () => {
        // PERF-04: Clear pending request timers before removing server
        for (const [, pending] of server.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('LSP server process exited'));
        }
        server.pending.clear();
        this.servers.delete(languageId);
      });

      // Initialize BEFORE adding to servers map to avoid dead server on failure (FUN-04)
      await this.sendRequest(server, 'initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: { hover: { contentFormat: ['plaintext'] }, publishDiagnostics: {} },
        },
      });

      this.sendNotification(server, 'initialized', {});

      // Only add to server map after successful initialization
      this.servers.set(languageId, server);
      return true;
    } catch {
      // Clean up: kill process and ensure server is not in map (FUN-04)
      if (this.servers.has(languageId)) {
        this.servers.delete(languageId);
      }
      return false;
    }
  }

  async getDiagnostics(filePath: string, content: string): Promise<LSPDiagnostic[]> {
    const cached = this.diagnosticCache.get(filePath);
    if (cached) return cached;

    const languageId = detectLanguage(filePath);
    const server = this.servers.get(languageId);
    if (!server) return [];

    const uri = pathToFileURL(filePath).href;

    try {
      await this.sendRequest(server, 'textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });

      // Wait for publishDiagnostics notification instead of arbitrary timeout
      return await this.waitForDiagnostics(filePath, 5000);
    } catch {
      return [];
    }
  }

  /**
   * Wait for a publishDiagnostics notification for the given file.
   * Falls back to cached diagnostics on timeout.
   */
  private waitForDiagnostics(filePath: string, timeoutMs: number): Promise<LSPDiagnostic[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDiagnostics.delete(filePath);
        resolve(this.diagnosticCache.get(filePath) || []);
      }, timeoutMs);

      this.pendingDiagnostics.set(filePath, { resolve, timer });
    });
  }

  /**
   * Send a request to the language server for a given file.
   * Public API for CompletionProvider, NavigationProvider, etc.
   */
  async request(filePath: string, method: string, params: unknown): Promise<unknown> {
    const languageId = detectLanguage(filePath);
    const server = this.servers.get(languageId);
    if (!server) return null;

    return this.sendRequest(server, method, params);
  }

  async getHover(filePath: string, content: string, line: number, character: number): Promise<LSPHover | null> {
    const languageId = detectLanguage(filePath);
    const server = this.servers.get(languageId);
    if (!server) return null;

    const uri = pathToFileURL(filePath).href;

    try {
      await this.sendRequest(server, 'textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });

      const result = await this.sendRequest(server, 'textDocument/hover', {
        textDocument: { uri },
        position: { line, character },
      });

      return result as LSPHover | null;
    } catch {
      return null;
    }
  }

  async getDefinition(filePath: string, content: string, line: number, character: number): Promise<LSPLocation[]> {
    const languageId = detectLanguage(filePath);
    const server = this.servers.get(languageId);
    if (!server) return [];

    const uri = pathToFileURL(filePath).href;

    try {
      await this.sendRequest(server, 'textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });

      const result = await this.sendRequest(server, 'textDocument/definition', {
        textDocument: { uri },
        position: { line, character },
      });

      if (Array.isArray(result)) return result as LSPLocation[];
      if (result) return [result as LSPLocation];
      return [];
    } catch {
      return [];
    }
  }

  async disconnectAll(): Promise<void> {
    // Resolve all pending diagnostics with empty arrays
    this.pendingDiagnostics.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.resolve([]);
    });
    this.pendingDiagnostics.clear();

    this.servers.forEach((server) => {
      try {
        server.process.kill('SIGTERM');
      } catch {}
    });
    this.servers.clear();
    this.diagnosticCache.clear();
  }

  isConnected(languageId: LanguageId): boolean {
    return this.servers.has(languageId);
  }

  private async sendRequest(server: ServerProcess, method: string, params: unknown): Promise<unknown> {
    const id = ++server.messageId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 10000);

      server.pending.set(id, { resolve, reject, timer });
      server.process.stdin?.write(header + message);
    });
  }

  private sendNotification(server: ServerProcess, method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    server.process.stdin?.write(header + message);
  }

  private processBuffer(server: ServerProcess): void {
    while (true) {
      const headerEnd = server.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = server.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/);
      if (!contentLengthMatch) break;

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;

      if (server.buffer.length < messageStart + contentLength) break;

      const messageStr = server.buffer.slice(messageStart, messageStart + contentLength);
      server.buffer = server.buffer.slice(messageStart + contentLength);

      try {
        const message: LSPMessage = JSON.parse(messageStr);
        this.handleMessage(server, message);
      } catch {}
    }
  }

  private handleMessage(server: ServerProcess, message: LSPMessage): void {
    if (message.id !== undefined && server.pending.has(message.id as number)) {
      const pending = server.pending.get(message.id as number)!;
      clearTimeout(pending.timer);
      server.pending.delete(message.id as number);

      if (message.error) {
        pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }

    // Handle diagnostics notification
    if (message.method === 'textDocument/publishDiagnostics' && message.params) {
      const params = message.params as { uri: string; diagnostics: LSPDiagnostic[] };
      const filePath = fileURLToPath(params.uri);
      this.diagnosticCache.set(filePath, params.diagnostics);

      // Resolve any pending waitForDiagnostics promise
      const pending = this.pendingDiagnostics.get(filePath);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingDiagnostics.delete(filePath);
        pending.resolve(params.diagnostics);
      }
    }
  }
}
