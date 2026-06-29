import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentStateMachine, InvalidTransitionError } from '../../src/state/machine';
import { ObservableStateStore, createInitialState } from '../../src/state/store';

function createStore() {
  return new ObservableStateStore(createInitialState());
}

describe('AgentStateMachine', () => {
  it('should start in idle state', () => {
    const machine = new AgentStateMachine(createStore());
    expect(machine.currentState).toBe('idle');
  });

  it('should transition from idle to compacting', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('should transition through valid sequence: idle→compacting→streaming→deciding→executing→streaming', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.transitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('should throw InvalidTransitionError on invalid transition', () => {
    const machine = new AgentStateMachine(createStore());
    expect(() => machine.transitionTo('streaming')).toThrow(InvalidTransitionError);
  });

  it('should throw InvalidTransitionError for idle→executing', () => {
    const machine = new AgentStateMachine(createStore());
    expect(() => machine.transitionTo('executing')).toThrow(InvalidTransitionError);
  });

  it('should detect terminal state: completed', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('completed');
    expect(machine.isTerminal()).toBe(true);
  });

  it('should detect terminal state: error', () => {
    const machine = new AgentStateMachine(createStore());
    machine.forceTransitionTo('error');
    expect(machine.isTerminal()).toBe(true);
  });

  it('should not be terminal in idle', () => {
    const machine = new AgentStateMachine(createStore());
    expect(machine.isTerminal()).toBe(false);
  });

  it('should reset to idle', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
    machine.reset();
    expect(machine.currentState).toBe('idle');
  });

  it('should report canTransition correctly', () => {
    const machine = new AgentStateMachine(createStore());
    expect(machine.canTransition('compacting')).toBe(true);
    expect(machine.canTransition('streaming')).toBe(false);
    expect(machine.canTransition('executing')).toBe(false);
  });

  it('should return valid next states', () => {
    const machine = new AgentStateMachine(createStore());
    const nextStates = machine.getValidNextStates();
    expect(nextStates).toContain('planning');
    expect(nextStates).toContain('compacting');
    expect(nextStates).not.toContain('executing');
  });

  it('should support forceTransitionTo', () => {
    const machine = new AgentStateMachine(createStore());
    machine.forceTransitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('should detect executing state', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    expect(machine.isExecuting()).toBe(true);
  });

  it('should detect streaming state', () => {
    const machine = new AgentStateMachine(createStore());
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    expect(machine.isStreaming()).toBe(true);
  });
});
