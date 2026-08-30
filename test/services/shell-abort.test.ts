// AbortError propagation through LocalShell — round4 §3-R7
//
// Cancellation used to be swallowed by the generic "command failed" branch, so
// Ctrl+C looked to the model exactly like a crashed command.

import { describe, it, expect } from 'vitest';
import { LocalShell } from '../../src/services/execution-env-local';
import { isAbortError } from '../../src/utils/errors';

const sleepCommand =
  process.platform === 'win32'
    ? '"' + process.execPath + '" -e "setTimeout(() => {}, 20000)"'
    : 'sleep 20';

describe('LocalShell cancellation', () => {
  it('rejects with an AbortError instead of returning exitCode 1', async () => {
    const shell = new LocalShell();
    const controller = new AbortController();
    // Abort almost immediately: the command needs far longer than that.
    setTimeout(() => controller.abort(), 50);

    const outcome = await shell
      .exec(sleepCommand, { cwd: process.cwd(), signal: controller.signal })
      .then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(isAbortError(outcome.error)).toBe(true);
  });

  it('throws when the signal is already aborted', async () => {
    const shell = new LocalShell();
    const controller = new AbortController();
    controller.abort();

    await expect(
      shell.exec(sleepCommand, { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
  });

  it('still reports a genuine non-zero exit as a failure, not a cancellation', async () => {
    const shell = new LocalShell();
    const result = await shell.exec(
      process.platform === 'win32' ? 'exit /b 3' : 'exit 3',
      { cwd: process.cwd() },
    );

    expect(result.exitCode).toBe(3);
  });
});

describe('isAbortError', () => {
  it('recognises an AbortError by name', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('recognises the ABORT_ERR code', () => {
    expect(isAbortError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(true);
  });

  it('does not mistake ordinary failures for cancellations', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(Object.assign(new Error('nope'), { code: 1 }))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
