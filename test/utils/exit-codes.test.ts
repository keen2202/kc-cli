// Exit-code semantics — round4 §3-R3

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  EXIT,
  createRunOutcome,
  markFailed,
  exitCodeFor,
  isFailureEvent,
} from '../../src/utils/exit-codes';

describe('EXIT constants', () => {
  it('follows the documented convention', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.FAILURE).toBe(1);
    // 128 + SIGINT(2) / SIGTERM(15)
    expect(EXIT.CANCELLED).toBe(130);
    expect(EXIT.SIGTERM).toBe(143);
  });
});

describe('RunOutcome', () => {
  it('starts clean', () => {
    const outcome = createRunOutcome();
    expect(outcome.failed).toBe(false);
    expect(exitCodeFor(outcome)).toBe(EXIT.OK);
  });

  it('flips to failed and records every reason', () => {
    const outcome = createRunOutcome();
    markFailed(outcome, 'agent:error');
    markFailed(outcome, 'agent:tool_permission_denied');

    expect(outcome.failed).toBe(true);
    expect(outcome.reasons).toEqual(['agent:error', 'agent:tool_permission_denied']);
    expect(exitCodeFor(outcome)).toBe(EXIT.FAILURE);
  });
});

describe('isFailureEvent', () => {
  it('treats agent errors, tool failures, denials and budget stops as failures', () => {
    for (const type of [
      'agent:error',
      'agent:tool_failed',
      'agent:tool_permission_denied',
      'agent:budget_exceeded',
      'error',
    ]) {
      expect(isFailureEvent({ type }), type).toBe(true);
    }
  });

  it('does not treat ordinary progress events as failures', () => {
    for (const type of [
      'agent:text_delta',
      'agent:turn_complete',
      'agent:tool_completed',
      'agent:complete',
      'tool_use_end',
    ]) {
      expect(isFailureEvent({ type }), type).toBe(false);
    }
  });
});

// The SIGTERM handler lives in the ink renderer, which cannot be instantiated
// in a unit test (it needs a real TTY and takes over stdin/stdout). These
// assertions pin the wiring at the source level.
describe('SIGTERM wiring', () => {
  let rendererSource = '';
  let mainSource = '';

  beforeAll(async () => {
    [rendererSource, mainSource] = await Promise.all([
      readFile(new URL('../../src/ui/renderer.tsx', import.meta.url), 'utf-8'),
      readFile(new URL('../../src/main.ts', import.meta.url), 'utf-8'),
    ]);
  });

  it('exits with EXIT.SIGTERM rather than 0', () => {
    expect(rendererSource).toMatch(/process\.exit\(EXIT\.SIGTERM\)/);
    expect(rendererSource).not.toMatch(/process\.exit\(0\)/);
  });

  it('exits with EXIT.FAILURE from the prompt path on failure', () => {
    expect(mainSource).toMatch(/process\.exit\(EXIT\.FAILURE\)/);
  });

  it('sets process.exitCode in JSON mode rather than exiting abruptly', () => {
    // process.exit() would truncate buffered stdout; exitCode is flushed first.
    expect(mainSource).toMatch(/process\.exitCode = exitCodeFor\(outcome\)/);
  });
});
