// FileRead partial-preview behaviour — round4 §2-S5
//
// `readLargeFilePreview` opens two independent streams (head + tail). With
// `Promise.all`, a failure in either one discarded the other's result even when
// half the preview was perfectly usable, and the surviving stream's descriptor
// was never released. `Promise.allSettled` degrades to a partial preview and
// still throws only when both halves fail.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Fail only the SECOND stream (the tail reader) by pointing it at a path that
// does not exist. The factory is hoisted, so everything is imported inside it.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  let openCount = 0;
  return {
    ...actual,
    createReadStream: ((p: unknown, o: unknown) => {
      openCount += 1;
      const target = openCount === 2 ? `${String(p)}.tail-missing` : p;
      return (actual.createReadStream as (...args: unknown[]) => unknown)(target, o);
    }) as typeof actual.createReadStream,
  };
});

import { tool as FileReadTool } from '../../src/tools/FileReadTool/index';
import { createLocalExecutionEnv } from '../../src/services/execution-env-local';

function makeContext(cwd: string) {
  return {
    cwd,
    abortController: new AbortController(),
    sandbox: undefined,
    env: createLocalExecutionEnv(cwd),
  } as never;
}

describe('readLargeFilePreview partial failure', () => {
  let workDir = '';
  let bigFile = '';

  beforeAll(async () => {
    workDir = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'kc-preview-'));
    bigFile = path.join(workDir, 'big.txt');
    // Numbered lines so head and tail content are distinguishable: that is what
    // proves the tail half really failed instead of silently succeeding.
    nodeFs.writeFileSync(
      bigFile,
      Array.from({ length: 60_000 }, (_, i) => `line ${i}`).join('\n'),
    );
  });

  afterAll(async () => {
    await nodeFs.promises.rm(workDir, { recursive: true, force: true });
  });

  it('returns a head-only preview when the tail reader fails', async () => {
    const result = await FileReadTool.call(
      { path: bigFile, maxSize: 100 },
      makeContext(workDir),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('--- First 50 lines ---');
    expect(result.output).toContain('--- Last 50 lines ---');
    // The head half survived ...
    expect(result.output).toContain('line 0\n');
    // ... and the failed tail half degraded to an empty section rather than
    // taking the whole read down with it.
    expect(result.output).not.toContain('line 59999');
    expect(result.metadata).toMatchObject({ previewOnly: true });
  });
});
