// Tests for RuntimeControlHandler (harness-evolution T2 / H2)
// Covers: default-off equivalence, soft/hard retry discipline, exploration-loop
// breaking, tool-message cap redirect, and switch-independent failure context.

import { describe, it, expect } from 'vitest';
import { RuntimeControlHandler } from '../../src/query/QueryEngineRuntimeControl';

const INPUT_A = { command: 'npm test', cwd: '/repo' };
const INPUT_B = { command: 'npm run build', cwd: '/repo' };

describe('RuntimeControlHandler (T2)', () => {
  describe('default (disabled) behavior', () => {
    it('is disabled by default', () => {
      const handler = new RuntimeControlHandler();
      expect(handler.enabled).toBe(false);
    });

    it('never hard-rejects when disabled', () => {
      const handler = new RuntimeControlHandler({ retryIntervention: 'hard', maxSameCallRetries: 1 });
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordToolResult('Bash', INPUT_A, true);
      expect(handler.checkHardReject('Bash', INPUT_A)).toBeNull();
    });

    it('never queues injections when disabled', () => {
      const handler = new RuntimeControlHandler({ maxSameCallRetries: 1, maxReadOnlyStreak: 1, maxTotalToolMessages: 1 });
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordTurn(['FileRead']);
      expect(handler.drainPendingInjections()).toBe('');
      expect(handler.getInterventions()).toHaveLength(0);
    });

    it('repeated-failure context works INDEPENDENTLY of the switch', () => {
      const handler = new RuntimeControlHandler(); // disabled
      expect(handler.getRepeatedFailureContext('Bash', INPUT_A)).toBeNull();
      handler.recordToolResult('Bash', INPUT_A, true);
      const context = handler.getRepeatedFailureContext('Bash', INPUT_A);
      expect(context).toContain('Bash');
      expect(context).toContain('1 consecutive failure');
      // Different input → no context
      expect(handler.getRepeatedFailureContext('Bash', INPUT_B)).toBeNull();
    });
  });

  describe('soft retry discipline', () => {
    it('queues a retry-discipline instruction after N consecutive identical failures', () => {
      const handler = new RuntimeControlHandler({ enabled: true, retryIntervention: 'soft', maxSameCallRetries: 2 });
      handler.recordToolResult('Bash', INPUT_A, true);
      expect(handler.drainPendingInjections()).toBe('');
      handler.recordToolResult('Bash', INPUT_A, true);
      const injection = handler.drainPendingInjections();
      expect(injection).toContain('Retry Discipline');
      // Drained — second read is empty
      expect(handler.drainPendingInjections()).toBe('');
      const interventions = handler.getInterventions();
      expect(interventions.some(i => i.kind === 'retry_discipline' && i.mode === 'soft')).toBe(true);
    });

    it('success resets the consecutive-failure counter', () => {
      const handler = new RuntimeControlHandler({ enabled: true, retryIntervention: 'soft', maxSameCallRetries: 2 });
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordToolResult('Bash', INPUT_A, false); // success resets
      handler.recordToolResult('Bash', INPUT_A, true);
      expect(handler.drainPendingInjections()).toBe('');
    });

    it('different inputs are tracked independently', () => {
      const handler = new RuntimeControlHandler({ enabled: true, retryIntervention: 'soft', maxSameCallRetries: 2 });
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordToolResult('Bash', INPUT_B, true);
      expect(handler.drainPendingInjections()).toBe('');
    });
  });

  describe('hard retry discipline', () => {
    it('rejects the identical call once the failure budget is exhausted', () => {
      const handler = new RuntimeControlHandler({ enabled: true, retryIntervention: 'hard', maxSameCallRetries: 2 });
      expect(handler.checkHardReject('Bash', INPUT_A)).toBeNull();
      handler.recordToolResult('Bash', INPUT_A, true);
      expect(handler.checkHardReject('Bash', INPUT_A)).toBeNull();
      handler.recordToolResult('Bash', INPUT_A, true);
      const rejection = handler.checkHardReject('Bash', INPUT_A);
      expect(rejection).toContain('Bash');
      expect(rejection).toContain('2 consecutive');
      // Other calls still pass
      expect(handler.checkHardReject('Bash', INPUT_B)).toBeNull();
      const interventions = handler.getInterventions();
      expect(interventions.some(i => i.kind === 'retry_discipline' && i.mode === 'hard')).toBe(true);
    });

    it('soft mode never hard-rejects', () => {
      const handler = new RuntimeControlHandler({ enabled: true, retryIntervention: 'soft', maxSameCallRetries: 1 });
      handler.recordToolResult('Bash', INPUT_A, true);
      handler.recordToolResult('Bash', INPUT_A, true);
      expect(handler.checkHardReject('Bash', INPUT_A)).toBeNull();
    });
  });

  describe('exploration-loop breaking', () => {
    it('fires after N consecutive read-only turns', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxReadOnlyStreak: 3 });
      handler.recordTurn(['FileRead', 'Grep']);
      handler.recordTurn(['Glob']);
      expect(handler.drainPendingInjections()).toBe('');
      handler.recordTurn(['FileRead']);
      const injection = handler.drainPendingInjections();
      expect(injection).toContain('Exploration Loop Breaker');
      expect(handler.getInterventions().some(i => i.kind === 'exploration_break')).toBe(true);
    });

    it('a write tool resets the streak', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxReadOnlyStreak: 2 });
      handler.recordTurn(['FileRead']);
      handler.recordTurn(['FileWrite']); // write resets
      handler.recordTurn(['Grep']);
      expect(handler.drainPendingInjections()).toBe('');
    });

    it('a turn without tool calls resets the streak', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxReadOnlyStreak: 2 });
      handler.recordTurn(['FileRead']);
      handler.recordTurn([]);
      handler.recordTurn(['Grep']);
      expect(handler.drainPendingInjections()).toBe('');
    });

    it('fires only once per streak', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxReadOnlyStreak: 2 });
      handler.recordTurn(['FileRead']);
      handler.recordTurn(['Grep']);
      expect(handler.drainPendingInjections()).toContain('Exploration Loop Breaker');
      handler.recordTurn(['Glob']); // streak continues but already fired
      expect(handler.drainPendingInjections()).toBe('');
    });
  });

  describe('tool-message cap redirect', () => {
    it('fires the redirect once when the cap is reached', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxTotalToolMessages: 3, maxSameCallRetries: 99 });
      handler.recordToolResult('FileRead', { path: 'a' }, false);
      handler.recordToolResult('FileRead', { path: 'b' }, false);
      expect(handler.drainPendingInjections()).toBe('');
      handler.recordToolResult('FileRead', { path: 'c' }, false);
      expect(handler.drainPendingInjections()).toContain('Tool Budget Redirect');
      // Fires only once
      handler.recordToolResult('FileRead', { path: 'd' }, false);
      expect(handler.drainPendingInjections()).toBe('');
      expect(handler.getInterventions().some(i => i.kind === 'tool_message_redirect')).toBe(true);
    });

    it('supports a custom redirect instruction', () => {
      const handler = new RuntimeControlHandler({
        enabled: true,
        maxTotalToolMessages: 1,
        maxSameCallRetries: 99,
        redirectInstruction: 'CUSTOM REDIRECT TEXT',
      });
      handler.recordToolResult('FileRead', { path: 'a' }, false);
      expect(handler.drainPendingInjections()).toBe('CUSTOM REDIRECT TEXT');
    });

    it('cap of 0 disables the redirect', () => {
      const handler = new RuntimeControlHandler({ enabled: true, maxTotalToolMessages: 0, maxSameCallRetries: 99 });
      for (let i = 0; i < 10; i++) {
        handler.recordToolResult('FileRead', { path: `f${i}` }, false);
      }
      expect(handler.drainPendingInjections()).toBe('');
    });
  });
});
