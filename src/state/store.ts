// Observable state store - immutable state updates with listener notifications

import type { AgentState, AgentStateName, ToolExecutionState } from './types';

type StateListener = (state: AgentState) => void;

/**
 * Observable state store that provides immutable updates with listener notifications.
 * Follows the OpenHarness AppStateStore pattern.
 *
 * Optimization: Tool execution tracking has a maximum size limit to prevent
 * unbounded memory growth in long-running sessions.
 */
export class ObservableStateStore {
  private state: AgentState;
  private listeners: Set<StateListener> = new Set();

  // Constants
  private static readonly MAX_TRACKED_TOOLS = 500; // Max tool executions to track
  private static readonly TOOL_CLEANUP_AGE_MS = 5 * 60 * 1000; // 5 minutes

  constructor(initialState: AgentState) {
    this.state = initialState;
  }

  /**
   * Get current immutable state snapshot
   */
  get(): AgentState {
    return { ...this.state };
  }

  /**
   * Update state with partial updates and notify all listeners.
   * Creates a new state object (immutable update pattern).
   */
  set(updates: Partial<AgentState>): AgentState {
    const oldState = this.state;
    this.state = {
      ...oldState,
      ...updates,
      lastActivityAt: Date.now(),
    };

    // Notify all listeners (copy array to prevent mutation during iteration)
    const listenersArray = Array.from(this.listeners);
    for (const listener of listenersArray) {
      try {
        listener(this.state);
      } catch (error) {
        // Don't let listener errors break state updates
        console.error('State listener error:', error);
      }
    }

    return this.state;
  }

  /**
   * Subscribe to state changes. Returns unsubscribe function.
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Update a specific field in the state
   */
  updateField<K extends keyof AgentState>(field: K, value: AgentState[K]): AgentState {
    return this.set({ [field]: value } as Partial<AgentState>);
  }

  /**
   * Increment turn counter
   */
  incrementTurn(): AgentState {
    return this.set({ turnCount: this.state.turnCount + 1 });
  }

  /**
   * Add token usage to total
   */
  addTokenUsage(tokens: number): AgentState {
    return this.set({
      totalTokensUsed: this.state.totalTokensUsed + tokens,
    });
  }

  /**
   * Update tool execution state
   * Optimization: Automatically cleans up old completed executions when limit is reached.
   */
  updateToolExecution(id: string, executionState: Partial<ToolExecutionState>): AgentState {
    const activeTools = new Map(this.state.activeToolExecutions);
    const existing = activeTools.get(id);

    if (existing) {
      activeTools.set(id, { ...existing, ...executionState });
    } else {
      activeTools.set(id, executionState as ToolExecutionState);
    }

    // Cleanup: remove old completed executions if limit exceeded
    if (activeTools.size > ObservableStateStore.MAX_TRACKED_TOOLS) {
      this.cleanupOldToolExecutions(activeTools);
    }

    return this.set({ activeToolExecutions: activeTools });
  }

  /**
   * Remove old completed tool executions to prevent memory accumulation
   */
  private cleanupOldToolExecutions(activeTools: Map<string, ToolExecutionState>): void {
    const now = Date.now();
    const toRemove: string[] = [];

    // Find completed/failed executions older than threshold
    for (const [id, exec] of activeTools.entries()) {
      if (
        (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'killed') &&
        exec.completedAt &&
        (now - exec.completedAt) > ObservableStateStore.TOOL_CLEANUP_AGE_MS
      ) {
        toRemove.push(id);
      }
    }

    // Remove oldest entries first
    for (const id of toRemove.slice(0, Math.min(toRemove.length, 100))) {
      activeTools.delete(id);
    }

    // If still over limit, remove any completed entries regardless of age
    if (activeTools.size > ObservableStateStore.MAX_TRACKED_TOOLS) {
      let removed = 0;
      for (const [id, exec] of activeTools.entries()) {
        if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'killed') {
          activeTools.delete(id);
          removed++;
          if (activeTools.size <= ObservableStateStore.MAX_TRACKED_TOOLS) break;
        }
      }
    }
  }

  /**
   * Remove tool execution from tracking
   */
  removeToolExecution(id: string): AgentState {
    const activeTools = new Map(this.state.activeToolExecutions);
    activeTools.delete(id);
    return this.set({ activeToolExecutions: activeTools });
  }

  /**
   * Reset state to idle
   */
  resetToIdle(): AgentState {
    return this.set({
      currentState: 'idle' as AgentStateName,
      activeToolExecutions: new Map(),
    });
  }

  /**
   * Get number of active listeners (for testing)
   */
  getListenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Clear all listeners (for cleanup)
   */
  clearListeners(): void {
    this.listeners.clear();
  }
}

/**
 * Create initial agent state
 */
export function createInitialState(overrides: Partial<AgentState> = {}): AgentState {
  const now = Date.now();
  return {
    cwd: process.cwd(),
    sessionId: `session_${now}_${Math.random().toString(36).slice(2, 9)}`,
    verbose: false,
    printMode: false,
    bareMode: false,
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    maxTokens: 4096,
    permissionMode: 'default',
    currentState: 'idle',
    turnCount: 0,
    maxTurns: 50,
    maxBudgetUsd: null,
    totalTokensUsed: 0,
    compactFailureCount: 0,
    lastCompactedAt: null,
    activeToolExecutions: new Map(),
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}
