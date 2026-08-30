// MCP Client Manager - Manages connections to multiple MCP servers

import type {
  MCPServerConfig,
  MCPTool,
  MCPToolResult,
  MCPInitializeResult,
  MCPListToolsResult,
  MCPConnectionStatus,
} from './types';
import { StdioTransport } from './transports/stdio';
import { HttpTransport } from './transports/http';
import { VERSION } from '../bootstrap/cli-config';
import { KCError, getErrorMessage } from '../utils/errors';
import { logger } from '../services/logger';
import { redactTruncated } from '../utils/redact';

interface ServerConnection {
  config: MCPServerConfig;
  transport: StdioTransport | HttpTransport;
  status: MCPConnectionStatus;
  tools: MCPTool[];
  serverInfo?: MCPInitializeResult['serverInfo'];
  reconnectAttempts: number;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 1000;

// Pre-compiled regex for MCP error classification (single test instead of multiple includes())
const MCP_ERROR_REGEX = /MCP error/;
const TIMED_OUT_REGEX = /timed out/;
const DISCONNECTED_REGEX = /exited|not connected/;

export class MCPClientManager {
  private connections = new Map<string, ServerConnection>();

  /**
   * O3: fired once when a server's reconnect budget is exhausted. The host app
   * wires this to its UI (notification bar / status line) so "tool not found"
   * later on has a visible root cause. The mcp layer itself stays UI-agnostic.
   */
  private onServerUnavailable?: (serverId: string, reason: string) => void;

  /** Register the UI-facing handler for final reconnect failure. */
  setServerUnavailableHandler(handler: (serverId: string, reason: string) => void): void {
    this.onServerUnavailable = handler;
  }

  async connect(serverId: string, config: MCPServerConfig): Promise<void> {
    if (this.connections.has(serverId)) {
      await this.disconnect(serverId);
    }

    const conn: ServerConnection = {
      config,
      transport: config.type === 'stdio' ? new StdioTransport() : new HttpTransport(),
      status: 'connecting',
      tools: [],
      reconnectAttempts: 0,
    };

    this.connections.set(serverId, conn);

    try {
      await this.establishConnection(serverId, conn);
    } catch (error) {
      conn.status = 'error';
      throw error;
    }
  }

  private async establishConnection(serverId: string, conn: ServerConnection): Promise<void> {
    if (conn.config.type === 'stdio') {
      if (!conn.config.command) {
        throw new KCError('tool_execution_failed', 'stdio transport requires "command" field');
      }
      await (conn.transport as StdioTransport).connect(
        conn.config.command,
        conn.config.args || [],
        conn.config.env
      );
    } else {
      if (!conn.config.url) {
        throw new KCError('tool_execution_failed', 'http transport requires "url" field');
      }
      await (conn.transport as HttpTransport).connect(conn.config.url);
    }

    // Set up notification handler for tool list changes
    conn.transport.onNotification((notification) => {
      if (notification.method === 'notifications/tools/list_changed') {
        this.invalidateToolList(serverId);
      }
    });

    // Initialize MCP session
    const initResult = await this.initialize(serverId);
    conn.serverInfo = initResult.serverInfo;
    conn.status = 'connected';
    conn.reconnectAttempts = 0;

    // Discover tools
    conn.tools = await this.listTools(serverId);
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    try {
      await conn.transport.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    conn.status = 'disconnected';
    this.connections.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    const serverIds = Array.from(this.connections.keys());
    await Promise.allSettled(serverIds.map(id => this.disconnect(id)));
  }

  getStatus(serverId: string): MCPConnectionStatus {
    return this.connections.get(serverId)?.status || 'disconnected';
  }

  getConnectedServers(): string[] {
    return Array.from(this.connections.entries())
      .filter(([, conn]) => conn.status === 'connected')
      .map(([id]) => id);
  }

  getServerTools(serverId: string): MCPTool[] {
    return this.connections.get(serverId)?.tools || [];
  }

  getAllTools(): Array<{ serverId: string; tool: MCPTool }> {
    const result: Array<{ serverId: string; tool: MCPTool }> = [];
    for (const [serverId, conn] of this.connections) {
      if (conn.status === 'connected') {
        for (const tool of conn.tools) {
          result.push({ serverId, tool });
        }
      }
    }
    return result;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== 'connected') {
      throw new KCError('tool_execution_failed', `MCP server ${serverId} is not connected`, { serverId });
    }

    try {
      const result = await conn.transport.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      return result as MCPToolResult;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Classify SDK error types
      if (MCP_ERROR_REGEX.test(msg)) {
        throw error;
      }
      if (TIMED_OUT_REGEX.test(msg)) {
        throw new KCError('tool_timeout', `MCP tool "${toolName}" timed out on server ${serverId}`, { serverId, toolName });
      }
      if (DISCONNECTED_REGEX.test(msg)) {
        // Server crashed, attempt reconnect
        await this.attemptReconnect(serverId);
        throw new KCError('tool_execution_failed', `MCP server ${serverId} disconnected during tool call "${toolName}"`, { serverId, toolName });
      }

      throw new KCError('tool_execution_failed', `MCP tool error on ${serverId}/${toolName}: ${msg}`, { serverId, toolName });
    }
  }

  /**
   * Health check: send ping to verify server is alive
   */
  async healthCheck(serverId: string): Promise<boolean> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== 'connected') {
      return false;
    }

    try {
      await conn.transport.sendRequest('ping');
      return true;
    } catch {
      return false;
    }
  }

  getServerInfo(serverId: string): MCPInitializeResult['serverInfo'] | undefined {
    return this.connections.get(serverId)?.serverInfo;
  }

  private async initialize(serverId: string): Promise<MCPInitializeResult> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new KCError('tool_execution_failed', `No connection for ${serverId}`, { serverId });

    const result = await conn.transport.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'kc-cli',
        version: VERSION,
      },
    });

    // Send initialized notification
    try {
      await conn.transport.sendRequest('notifications/initialized');
    } catch {
      // Some servers may not expect this
    }

    return result as MCPInitializeResult;
  }

  private async listTools(serverId: string): Promise<MCPTool[]> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new KCError('tool_execution_failed', `No connection for ${serverId}`, { serverId });

    try {
      const result = await conn.transport.sendRequest('tools/list') as MCPListToolsResult;
      return result.tools || [];
    } catch {
      return [];
    }
  }

  /**
   * Invalidate cached tool list and re-fetch from server
   */
  private async invalidateToolList(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== 'connected') return;

    try {
      conn.tools = await this.listTools(serverId);
    } catch {
      // Ignore errors during tool list refresh
    }
  }

  /**
   * Attempt to reconnect to a server with exponential backoff
   */
  private async attemptReconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // O3: final failure was silent — the server's tools simply vanished.
      conn.status = 'error';
      const reason = `reconnect attempts exhausted (${MAX_RECONNECT_ATTEMPTS})`;
      logger.mcp.error('MCP server unavailable', {
        serverId,
        attempt: conn.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        reason,
      });
      this.onServerUnavailable?.(serverId, reason);
      return;
    }

    conn.reconnectAttempts++;
    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, conn.reconnectAttempts - 1);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      // Create new transport
      conn.transport = conn.config.type === 'stdio' ? new StdioTransport() : new HttpTransport();
      await this.establishConnection(serverId, conn);
    } catch (err) {
      // O3: every failed attempt is logged with its backoff context.
      logger.mcp.error('MCP reconnect failed', {
        serverId,
        attempt: conn.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        nextDelayMs: BASE_RECONNECT_DELAY_MS * Math.pow(2, conn.reconnectAttempts),
        reason: redactTruncated(getErrorMessage(err)),
      });
      conn.status = 'error';
    }
  }
}
