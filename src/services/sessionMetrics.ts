// Session Metrics Collector - tracks tool usage, commands, and session statistics

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const METRICS_DIR = '.kc-cli/metrics';

export interface ToolMetrics {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgExecutionMs: number;
  lastUsed: number;
}

export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  endTime: number | null;
  turnCount: number;
  toolCalls: number;
  commandsUsed: string[];
  errorCount: number;
  compactCount: number;
}

export interface MetricsSummary {
  session: SessionMetrics;
  tools: Map<string, ToolMetrics>;
}

/**
 * Session metrics collector
 */
export class SessionMetricsCollector {
  private session: SessionMetrics;
  private tools = new Map<string, ToolMetrics>();
  private toolTimers = new Map<string, number>();
  private commandsSet = new Set<string>();

  constructor(sessionId: string) {
    this.session = {
      sessionId,
      startTime: Date.now(),
      endTime: null,
      turnCount: 0,
      toolCalls: 0,
      commandsUsed: [],
      errorCount: 0,
      compactCount: 0,
    };
  }

  /**
   * Record a tool call
   */
  recordToolCall(toolName: string, success: boolean, executionMs: number): void {
    this.session.toolCalls++;

    let metrics = this.tools.get(toolName);
    if (!metrics) {
      metrics = {
        toolName,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionMs: 0,
        lastUsed: Date.now(),
      };
      this.tools.set(toolName, metrics);
    }

    metrics.totalCalls++;
    if (success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }

    // Update rolling average execution time
    const totalMs = metrics.avgExecutionMs * (metrics.totalCalls - 1) + executionMs;
    metrics.avgExecutionMs = totalMs / metrics.totalCalls;
    metrics.lastUsed = Date.now();
  }

  /**
   * Start timing a tool call
   */
  startToolTimer(toolName: string): void {
    this.toolTimers.set(toolName, Date.now());
  }

  /**
   * End timing a tool call and record it
   */
  endToolTimer(toolName: string, success: boolean): void {
    const startTime = this.toolTimers.get(toolName);
    if (startTime) {
      const executionMs = Date.now() - startTime;
      this.recordToolCall(toolName, success, executionMs);
      this.toolTimers.delete(toolName);
    }
  }

  /**
   * Record a command usage (O(1) Set lookup instead of O(n) Array.includes)
   */
  recordCommand(command: string): void {
    if (!this.commandsSet.has(command)) {
      this.commandsSet.add(command);
      this.session.commandsUsed.push(command);
    }
  }

  /**
   * Record a conversation turn
   */
  recordTurn(): void {
    this.session.turnCount++;
  }

  /**
   * Record an error
   */
  recordError(): void {
    this.session.errorCount++;
  }

  /**
   * Record a compaction
   */
  recordCompact(): void {
    this.session.compactCount++;
  }

  /**
   * End the session
   */
  endSession(): void {
    this.session.endTime = Date.now();
  }

  /**
   * Get current metrics
   */
  getMetrics(): MetricsSummary {
    return {
      session: { ...this.session },
      tools: new Map(this.tools),
    };
  }

  /**
   * Get session duration in ms
   */
  getSessionDuration(): number {
    const end = this.session.endTime || Date.now();
    return end - this.session.startTime;
  }

  /**
   * Get tool metrics for a specific tool
   */
  getToolMetrics(toolName: string): ToolMetrics | null {
    return this.tools.get(toolName) || null;
  }

  /**
   * Get all tool metrics
   */
  getAllToolMetrics(): ToolMetrics[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get most used tools
   */
  getMostUsedTools(limit: number = 5): ToolMetrics[] {
    return Array.from(this.tools.values())
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, limit);
  }

  /**
   * Get tools with highest failure rate
   */
  getMostFailingTools(limit: number = 5): ToolMetrics[] {
    return Array.from(this.tools.values())
      .filter(t => t.totalCalls >= 3) // Only tools with enough data
      .sort((a, b) => (b.failureCount / b.totalCalls) - (a.failureCount / a.totalCalls))
      .slice(0, limit);
  }

  /**
   * Persist metrics to disk
   */
  async persist(): Promise<void> {
    const metricsDir = path.join(os.homedir(), METRICS_DIR);
    await fs.mkdir(metricsDir, { recursive: true });

    const filePath = path.join(metricsDir, `${this.session.sessionId}.json`);
    const data = {
      session: this.session,
      tools: Object.fromEntries(this.tools),
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load historical metrics
   */
  static async load(sessionId: string): Promise<MetricsSummary | null> {
    const filePath = path.join(os.homedir(), METRICS_DIR, `${sessionId}.json`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      const tools = new Map<string, ToolMetrics>();
      for (const [key, value] of Object.entries(data.tools || {})) {
        tools.set(key, value as ToolMetrics);
      }

      return {
        session: data.session,
        tools,
      };
    } catch {
      return null;
    }
  }

  /**
   * List all persisted metric sessions
   */
  static async listSessions(): Promise<string[]> {
    const metricsDir = path.join(os.homedir(), METRICS_DIR);

    try {
      const files = await fs.readdir(metricsDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * Reset collector state
   */
  reset(): void {
    this.session = {
      sessionId: this.session.sessionId,
      startTime: Date.now(),
      endTime: null,
      turnCount: 0,
      toolCalls: 0,
      commandsUsed: [],
      errorCount: 0,
      compactCount: 0,
    };
    this.tools.clear();
    this.toolTimers.clear();
    this.commandsSet.clear();
  }
}
