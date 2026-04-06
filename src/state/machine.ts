// Agent state machine - validates and manages state transitions

import type { AgentStateName } from './types';
import { isValidTransition, VALID_TRANSITIONS } from './types';
import type { ObservableStateStore } from './store';

/**
 * Error thrown when an invalid state transition is attempted
 */
export class InvalidTransitionError extends Error {
  constructor(from: AgentStateName, to: AgentStateName) {
    super(
      `Invalid state transition: ${from} → ${to}. ` +
      `Valid transitions from ${from}: ${VALID_TRANSITIONS[from].join(', ')}`
    );
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Agent state machine that validates and tracks state transitions.
 * Follows the OpenHarness query loop state machine pattern.
 */
export class AgentStateMachine {
  private currentStateName: AgentStateName;
  private store: ObservableStateStore;

  constructor(store: ObservableStateStore, initialState: AgentStateName = 'idle') {
    this.currentStateName = initialState;
    this.store = store;
  }

  /**
   * Get current state name
   */
  get currentState(): AgentStateName {
    return this.currentStateName;
  }

  /**
   * Check if a transition to the given state is valid
   */
  canTransition(to: AgentStateName): boolean {
    return isValidTransition(this.currentStateName, to);
  }

  /**
   * Get valid next states from current state
   */
  getValidNextStates(): AgentStateName[] {
    return VALID_TRANSITIONS[this.currentStateName] || [];
  }

  /**
   * Transition to a new state. Validates the transition first.
   * Throws InvalidTransitionError if transition is not allowed.
   */
  transitionTo(to: AgentStateName): void {
    if (!this.canTransition(to)) {
      throw new InvalidTransitionError(this.currentStateName, to);
    }

    this.currentStateName = to;

    // Update state in the store
    this.store.set({ currentState: to });
  }

  /**
   * Force transition to a state (bypasses validation).
   * Use only for error recovery or initialization.
   */
  forceTransitionTo(to: AgentStateName): void {
    this.currentStateName = to;
    this.store.set({ currentState: to });
  }

  /**
   * Reset state machine to idle
   */
  reset(): void {
    this.currentStateName = 'idle';
    this.store.resetToIdle();
  }

  /**
   * Check if currently in a terminal state (completed or error)
   */
  isTerminal(): boolean {
    return this.currentStateName === 'completed' || this.currentStateName === 'error';
  }

  /**
   * Check if currently in an executing state
   */
  isExecuting(): boolean {
    return this.currentStateName === 'executing';
  }

  /**
   * Check if currently streaming from LLM
   */
  isStreaming(): boolean {
    return this.currentStateName === 'streaming';
  }

  /**
   * Get state history summary (for debugging)
   */
  getStateSummary(): string {
    const fullState = this.store.get();
    return `State: ${this.currentStateName} | Turn: ${fullState.turnCount} | Tokens: ${fullState.totalTokensUsed}`;
  }
}
