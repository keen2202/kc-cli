// Global crash guard tests — round4 §2-S3

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { installGlobalCrashGuards } from '../../src/utils/crash-guards';

type Handle = ReturnType<typeof installGlobalCrashGuards>;

/** Flush the promise chain inside the fatal handler (.catch → .finally). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('installGlobalCrashGuards', () => {
  let handle: Handle | null = null;

  afterEach(() => {
    handle?.uninstall();
    handle = null;
    vi.restoreAllMocks();
  });

  it('registers handlers for both fatal events', () => {
    handle = installGlobalCrashGuards();
    expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(1);
  });

  it('detaches both handlers on uninstall (no listener leak)', () => {
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeRejection = process.listenerCount('unhandledRejection');

    handle = installGlobalCrashGuards();
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);

    handle.uninstall();
    handle = null;
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection);
  });

  it('saves the session and exits with EXIT.FAILURE on uncaughtException', async () => {
    const saver = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handle = installGlobalCrashGuards();
    handle.setSnapshotSaver(saver);
    process.emit('uncaughtException', new Error('boom'));
    await flush();

    expect(saver).toHaveBeenCalledWith('uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError.mock.calls.flat().join(' ')).toContain('boom');
  });

  it('saves the session and exits non-zero on unhandledRejection', async () => {
    const saver = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handle = installGlobalCrashGuards();
    handle.setSnapshotSaver(saver);
    process.emit('unhandledRejection', new Error('floating promise'));
    await flush();

    expect(saver).toHaveBeenCalledWith('unhandledRejection');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits non-zero when the emergency save itself fails', async () => {
    const saver = vi.fn().mockRejectedValue(new Error('disk full'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handle = installGlobalCrashGuards();
    handle.setSnapshotSaver(saver);
    process.emit('uncaughtException', new Error('boom'));
    await flush();

    expect(saver).toHaveBeenCalled();
    // The guard must not crash-loop: a failed save still ends in a clean exit.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('degrades to a no-op save when no entry path registered one', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handle = installGlobalCrashGuards();
    process.emit('uncaughtException', new Error('before any engine exists'));
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });
});

// The CLI entry point cannot be imported from a test — merely loading it runs
// the CLI. These assertions inspect the source instead so the property the
// audit flagged (guards registered inside runREPL, leaving the default ink-UI
// path unprotected) cannot silently come back.
describe('main entry point coverage', () => {
  let source = '';

  beforeAll(async () => {
    source = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf-8');
  });

  it('installs the crash guards at module scope', () => {
    expect(source).toMatch(/^const crashGuards = installGlobalCrashGuards\(\);$/m);
  });

  it('no longer registers duplicate handlers inside runREPL', () => {
    const replBody = source.slice(source.indexOf('async function runREPL'));
    const untilNextTopLevelFn = replBody.slice(0, replBody.indexOf('\n// ──'));
    expect(untilNextTopLevelFn).not.toContain("process.on('uncaughtException'");
    expect(untilNextTopLevelFn).not.toContain("process.on('unhandledRejection'");
  });

  it('registers a crash snapshot saver for the ink UI path', () => {
    const block = source.slice(source.indexOf('onInteractiveUI'));
    expect(block.slice(0, 400)).toContain('registerCrashSnapshot(queryEngine)');
  });
});
