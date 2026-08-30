// FileRead descriptor-leak tests — round4 §2-S5
//
// Before the fix, `readHeadLines` / `readTailLines` only destroyed their stream
// on the success path: any error thrown out of the `for await` (EISDIR,
// EACCES, concurrent delete) leaked a file descriptor. Repeated across a long
// session that ends in `EMFILE: too many open files`, which then breaks every
// file tool, config load and log write in the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// Intercept only `createReadStream`, before the tool module binds it.
// The factory is hoisted, so every dependency is imported inside it.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { wrapCreateReadStream } = await import('../helpers/fd-count');
  return {
    ...actual,
    createReadStream: wrapCreateReadStream(
      actual.createReadStream as unknown as (...args: unknown[]) => NodeJS.ReadableStream,
    ),
  };
});

import { readStreamStats } from '../helpers/fd-count';
import { tool as FileReadTool } from '../../src/tools/FileReadTool/index';
import { createLocalExecutionEnv } from '../../src/services/execution-env-local';

const ITERATIONS = 12;

/** `stream.destroy()` emits 'close' asynchronously — let the loop settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function makeContext(cwd: string) {
  return {
    cwd,
    abortController: new AbortController(),
    sandbox: undefined,
    env: createLocalExecutionEnv(cwd),
  } as never;
}

describe('FileRead preview stream cleanup', () => {
  let workDir = '';

  beforeAll(async () => {
    workDir = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'kc-fd-test-'));
    // A file comfortably larger than maxSize so the streaming preview path runs.
    nodeFs.writeFileSync(path.join(workDir, 'big.txt'), 'line\n'.repeat(60_000));
  });

  afterAll(async () => {
    await nodeFs.promises.rm(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    readStreamStats.reset();
  });

  it('closes both streams when both readers fail (directory path)', async () => {
    // A negative maxSize always forces the preview branch (a directory's
    // reported size is 0 on Windows), and a directory makes both streams fail
    // with EISDIR — exactly the path that used to leak.
    for (let i = 0; i < ITERATIONS; i++) {
      await FileReadTool.call({ path: workDir, maxSize: -1 }, makeContext(workDir));
    }
    await settle();

    expect(readStreamStats.created).toBe(ITERATIONS * 2);
    expect(readStreamStats.leaked()).toBe(0);
  });

  it('closes both streams on the happy path', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await FileReadTool.call(
        { path: path.join(workDir, 'big.txt'), maxSize: 100 },
        makeContext(workDir),
      );
    }
    await settle();

    expect(readStreamStats.created).toBe(ITERATIONS * 2);
    expect(readStreamStats.leaked()).toBe(0);
  });

  it('still returns a head+tail preview for an oversized file', async () => {
    const result = await FileReadTool.call(
      { path: path.join(workDir, 'big.txt'), maxSize: 100 },
      makeContext(workDir),
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('--- First 50 lines ---');
    expect(result.output).toContain('--- Last 50 lines ---');
  });
});
