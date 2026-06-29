import { describe, it, expect, beforeEach } from 'vitest';
import { PlanningPhaseHandler } from './QueryEnginePlanning';
import type { AssistantMessage } from './protocol';

function makeMsg(content: string, toolCalls?: Array<{ toolName: string }>): AssistantMessage {
  return {
    id: 'test-id',
    role: 'assistant',
    content,
    toolCalls: toolCalls as any,
    timestamp: Date.now(),
  };
}

describe('PlanningPhaseHandler', () => {
  let handler: PlanningPhaseHandler;

  beforeEach(() => {
    handler = new PlanningPhaseHandler({ maxTurns: 3 });
  });

  it('blocks write and edit tools', () => {
    expect(handler.isToolAllowed('write')).toBe(false);
    expect(handler.isToolAllowed('edit')).toBe(false);
    expect(handler.isToolAllowed('git_commit')).toBe(false);
  });

  it('allows read, grep, glob, bash, lsp tools', () => {
    expect(handler.isToolAllowed('read')).toBe(true);
    expect(handler.isToolAllowed('grep')).toBe(true);
    expect(handler.isToolAllowed('glob')).toBe(true);
    expect(handler.isToolAllowed('bash')).toBe(true);
    expect(handler.isToolAllowed('lsp_diagnostics')).toBe(true);
  });

  it('detects plan completion via "plan complete"', () => {
    const msg = makeMsg('I have analyzed the issue. Plan complete. The fix is in src/foo.py.');
    expect(handler.evaluateComplete(msg)).toBe(true);
  });

  it('detects plan completion via "my hypothesis is"', () => {
    const msg = makeMsg('My hypothesis is that the _cstack function is broken.');
    expect(handler.evaluateComplete(msg)).toBe(true);
  });

  it('detects plan completion via attempted edit tool call', () => {
    const msg = makeMsg('Let me fix this.', [{ toolName: 'edit' }]);
    expect(handler.evaluateComplete(msg)).toBe(true);
  });

  it('does not complete on vague exploration', () => {
    const msg = makeMsg('Let me read some more files to understand this.');
    expect(handler.evaluateComplete(msg)).toBe(false);
  });

  it('tracks turn count and respects max turns', () => {
    expect(handler.recordTurn()).toBe(true);  // turn 1 < 3
    expect(handler.recordTurn()).toBe(true);  // turn 2 < 3
    expect(handler.recordTurn()).toBe(false); // turn 3 >= 3
  });

  it('extracts findings from planning messages', () => {
    const msgs = [
      makeMsg('The hypothesis is: the _cstack function sets wrong values. Error: AssertionError in test_separable.py. Fix in astropy/modeling/separable.py.'),
    ];
    const findings = handler.extractFindings(msgs);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].relevantFiles).toContain('astropy/modeling/separable.py');
  });

  it('resets state correctly', () => {
    handler.recordTurn();
    handler.recordTurn();
    handler.reset();
    expect(handler.currentTurn).toBe(0);
    expect(handler.getFindings().length).toBe(0);
  });
});
