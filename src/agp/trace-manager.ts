/**
 * AGP Trace Manager
 *
 * Captures fine-grained execution traces for interpretability, debugging,
 * and as training signals for the SEPL self-evolution loop.
 *
 * Traces include: inputs, outputs, intermediate decisions, tool interactions,
 * failures, latencies, and progress signals.
 *
 * Corresponds to the "Trace manager" infrastructure service in the
 * Autogenesis paper (§E.2.4).
 */

// ─── Trace Types ─────────────────────────────────────────────────────────────

/** Categories of trace events */
export type TraceEventCategory =
  | 'tool_call'         // External tool invocation
  | 'llm_request'       // LLM API call
  | 'permission_check'  // Permission decision
  | 'state_transition'  // State machine transition
  | 'error'             // Error/failure event
  | 'decision'          // Agent decision point
  | 'sub_agent'         // Sub-agent spawn/complete
  | 'evolution'         // SEPL evolution event
  | 'custom';           // Application-specific

/** Severity level of a trace event */
export type TraceSeverity = 'debug' | 'info' | 'warn' | 'error';

/**
 * A single trace event captured during execution.
 */
export interface TraceEvent {
  /** Unique event ID */
  id: string;
  /** Event category */
  category: TraceEventCategory;
  /** Severity level */
  severity: TraceSeverity;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Session ID for grouping */
  sessionId: string;
  /** Turn number within the session */
  turnNumber?: number;
  /** Name of the resource or component that generated this event */
  source: string;
  /** Short human-readable description */
  message: string;
  /** Structured data payload */
  data?: Record<string, unknown>;
  /** Duration in ms (for timed operations) */
  durationMs?: number;
  /** Whether this event represents a failure */
  isError?: boolean;
  /** Error message if applicable */
  errorMessage?: string;
}

/**
 * A trace session groups related events from a single execution cycle.
 */
export interface TraceSession {
  sessionId: string;
  startTime: number;
  endTime?: number;
  events: TraceEvent[];
  /** Summary statistics */
  stats: {
    totalEvents: number;
    errorCount: number;
    toolCallCount: number;
    llmCallCount: number;
    totalDurationMs: number;
  };
}

/**
 * Filter options for querying traces.
 */
export interface TraceFilter {
  sessionId?: string;
  category?: TraceEventCategory;
  severity?: TraceSeverity;
  source?: string;
  isError?: boolean;
  since?: number; // timestamp
  limit?: number;
}

// ─── Trace Manager Implementation ────────────────────────────────────────────

let eventCounter = 0;

function generateTraceId(): string {
  return `trace_${Date.now().toString(36)}_${(eventCounter++).toString(36)}`;
}

/**
 * TraceManager captures and manages execution traces.
 *
 * Features:
 * - In-memory ring buffer with configurable max size
 * - Session-based grouping
 * - Query/filter capabilities
 * - Serialization for persistence
 */
export class TraceManager {
  /** Maximum number of events to retain in memory */
  private maxEvents: number;
  /** Ring buffer of trace events */
  private events: TraceEvent[] = [];
  /** Active sessions */
  private sessions = new Map<string, TraceSession>();
  /** Current session ID */
  private currentSessionId: string | null = null;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 10000;
  }

  // ─── Session Management ──────────────────────────────────────────────────

  /**
   * Start a new trace session.
   */
  startSession(sessionId: string): TraceSession {
    const session: TraceSession = {
      sessionId,
      startTime: Date.now(),
      events: [],
      stats: {
        totalEvents: 0,
        errorCount: 0,
        toolCallCount: 0,
        llmCallCount: 0,
        totalDurationMs: 0,
      },
    };
    this.sessions.set(sessionId, session);
    this.currentSessionId = sessionId;
    return session;
  }

  /**
   * End the current session.
   */
  endSession(sessionId?: string): void {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return;

    const session = this.sessions.get(id);
    if (session) {
      session.endTime = Date.now();
      session.stats.totalDurationMs = session.endTime - session.startTime;
    }

    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }
  }

  // ─── Event Recording ─────────────────────────────────────────────────────

  /**
   * Record a trace event.
   */
  record(event: Omit<TraceEvent, 'id' | 'timestamp' | 'sessionId'> & { sessionId?: string }): TraceEvent {
    const fullEvent: TraceEvent = {
      ...event,
      id: generateTraceId(),
      timestamp: Date.now(),
      sessionId: event.sessionId || this.currentSessionId || 'default',
    };

    // Add to ring buffer
    this.events.push(fullEvent);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // Add to session
    const session = this.sessions.get(fullEvent.sessionId);
    if (session) {
      session.events.push(fullEvent);
      session.stats.totalEvents++;
      if (fullEvent.isError) session.stats.errorCount++;
      if (fullEvent.category === 'tool_call') session.stats.toolCallCount++;
      if (fullEvent.category === 'llm_request') session.stats.llmCallCount++;
    }

    return fullEvent;
  }

  // ─── Convenience Recording Methods ───────────────────────────────────────

  /**
   * Record a tool call trace.
   */
  recordToolCall(
    toolName: string,
    input: unknown,
    output: unknown,
    options: { durationMs?: number; isError?: boolean; errorMessage?: string } = {}
  ): TraceEvent {
    return this.record({
      category: 'tool_call',
      severity: options.isError ? 'error' : 'info',
      source: toolName,
      message: `Tool call: ${toolName}`,
      data: { input, output },
      durationMs: options.durationMs,
      isError: options.isError,
      errorMessage: options.errorMessage,
    });
  }

  /**
   * Record an LLM request trace.
   */
  recordLLMRequest(
    model: string,
    options: {
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
      isError?: boolean;
    } = {}
  ): TraceEvent {
    return this.record({
      category: 'llm_request',
      severity: options.isError ? 'error' : 'info',
      source: model,
      message: `LLM request: ${model}`,
      data: {
        inputTokens: options.inputTokens,
        outputTokens: options.outputTokens,
      },
      durationMs: options.durationMs,
      isError: options.isError,
    });
  }

  /**
   * Record an error event.
   */
  recordError(
    source: string,
    error: Error | string,
    data?: Record<string, unknown>
  ): TraceEvent {
    const message = error instanceof Error ? error.message : error;
    return this.record({
      category: 'error',
      severity: 'error',
      source,
      message,
      data,
      isError: true,
      errorMessage: message,
    });
  }

  /**
   * Record a state transition.
   */
  recordStateTransition(
    from: string,
    to: string,
    source = 'state-machine'
  ): TraceEvent {
    return this.record({
      category: 'state_transition',
      severity: 'info',
      source,
      message: `State: ${from} → ${to}`,
      data: { from, to },
    });
  }

  // ─── Query & Filter ──────────────────────────────────────────────────────

  /**
   * Query trace events with filters.
   */
  query(filter: TraceFilter = {}): TraceEvent[] {
    let results = this.events;

    if (filter.sessionId) {
      results = results.filter(e => e.sessionId === filter.sessionId);
    }
    if (filter.category) {
      results = results.filter(e => e.category === filter.category);
    }
    if (filter.severity) {
      results = results.filter(e => e.severity === filter.severity);
    }
    if (filter.source) {
      results = results.filter(e => e.source === filter.source);
    }
    if (filter.isError !== undefined) {
      results = results.filter(e => e.isError === filter.isError);
    }
    if (filter.since) {
      results = results.filter(e => e.timestamp >= filter.since!);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get all error events.
   */
  getErrors(limit = 100): TraceEvent[] {
    return this.query({ isError: true, limit });
  }

  /**
   * Get the most recent trace events.
   */
  getRecent(limit = 50): TraceEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): TraceSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get all session IDs.
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  /**
   * Generate a summary of recent execution for the Reflect operator.
   * Returns structured data about failures, latencies, and patterns.
   */
  generateExecutionSummary(sessionId?: string): {
    totalEvents: number;
    errorEvents: TraceEvent[];
    toolCalls: Array<{ name: string; durationMs?: number; isError?: boolean }>;
    llmCalls: Array<{ model: string; durationMs?: number; inputTokens?: number; outputTokens?: number }>;
    failurePatterns: Map<string, number>;
    averageLatencyMs: number;
  } {
    const events = sessionId
      ? this.query({ sessionId })
      : this.getRecent(500);

    const errorEvents = events.filter(e => e.isError);
    const toolCalls = events
      .filter(e => e.category === 'tool_call')
      .map(e => ({
        name: e.source,
        durationMs: e.durationMs,
        isError: e.isError,
      }));

    const llmCalls = events
      .filter(e => e.category === 'llm_request')
      .map(e => ({
        model: e.source,
        durationMs: e.durationMs,
        inputTokens: e.data?.inputTokens as number | undefined,
        outputTokens: e.data?.outputTokens as number | undefined,
      }));

    // Identify failure patterns
    const failurePatterns = new Map<string, number>();
    for (const err of errorEvents) {
      const pattern = err.errorMessage ?? err.message;
      failurePatterns.set(pattern, (failurePatterns.get(pattern) ?? 0) + 1);
    }

    // Average latency of timed operations
    const timedEvents = events.filter(e => e.durationMs !== undefined);
    const avgLatency = timedEvents.length > 0
      ? timedEvents.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / timedEvents.length
      : 0;

    return {
      totalEvents: events.length,
      errorEvents,
      toolCalls,
      llmCalls,
      failurePatterns,
      averageLatencyMs: Math.round(avgLatency),
    };
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Clear all trace data.
   */
  clear(): void {
    this.events = [];
    this.sessions.clear();
    this.currentSessionId = null;
  }

  /**
   * Get total event count.
   */
  get size(): number {
    return this.events.length;
  }

  // ─── Serialization ───────────────────────────────────────────────────────

  /**
   * Serialize trace data for persistence.
   */
  serialize(): Record<string, unknown> {
    return {
      events: this.events,
      sessions: Object.fromEntries(this.sessions),
      currentSessionId: this.currentSessionId,
    };
  }

  /**
   * Restore trace data from serialized form.
   */
  deserialize(data: Record<string, unknown>): void {
    if (Array.isArray(data.events)) {
      this.events = data.events as TraceEvent[];
    }
    if (data.sessions && typeof data.sessions === 'object') {
      this.sessions = new Map(Object.entries(data.sessions as Record<string, TraceSession>));
    }
    this.currentSessionId = data.currentSessionId as string | null;
  }
}

/**
 * Global TraceManager singleton.
 */
let globalTraceManager: TraceManager | null = null;

export function getTraceManager(): TraceManager {
  if (!globalTraceManager) {
    globalTraceManager = new TraceManager();
  }
  return globalTraceManager;
}

export function resetTraceManager(): void {
  globalTraceManager?.clear();
  globalTraceManager = null;
}
