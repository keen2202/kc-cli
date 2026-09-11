import { describe, it, expect } from 'vitest';
import {
  createExecutionTrace,
  createTracedExecutionEnv,
  runWithExecutionTrace,
  TRACE_OUTPUT_MAX_BYTES,
} from '../../src/services/execution-env';
import { createMockExecutionEnv, MockShell } from '../../src/services/execution-env-mock';

describe('ExecutionEnv trace capture (RI-SPEC §3.3)', () => {
  it('records command summaries and file writes inside the ALS scope', async () => {
    const env = createMockExecutionEnv('/repo');
    (env.shell as MockShell).setDefault({ stdout: 'Tests 23 passed', stderr: '', exitCode: 0 });

    const trace = createExecutionTrace('/repo');
    await runWithExecutionTrace(trace, async () => {
      await env.shell.exec('npm test', { cwd: '/repo' });
      await env.fs.writeFile('/repo/src/a.ts', 'a');
      await env.fs.writeFileAtomic('/repo/src/b.ts', 'b');
      await env.fs.writeFile('/repo/src/b.ts', 'b2');
    });

    expect(trace.commands).toHaveLength(1);
    expect(trace.commands[0]).toMatchObject({
      command: 'npm test',
      exitCode: 0,
      stdout: 'Tests 23 passed',
      cwd: '/repo',
    });
    expect(trace.fileWrites.map((w) => `${w.path}:${w.kind}`)).toEqual([
      '/repo/src/a.ts:created',
      '/repo/src/b.ts:created',
      '/repo/src/b.ts:modified',
    ]);
  });

  it('is a zero-overhead no-op outside an active trace', async () => {
    const env = createMockExecutionEnv('/repo');
    (env.shell as MockShell).setDefault({ stdout: 'ok', stderr: '', exitCode: 0 });

    await expect(env.shell.exec('echo ok', {})).resolves.toMatchObject({ stdout: 'ok' });
    await expect(env.fs.writeFile('/repo/a.ts', 'a')).resolves.toBeUndefined();
  });

  it('truncates traced stdout to 4KB', async () => {
    const env = createMockExecutionEnv('/repo');
    (env.shell as MockShell).setDefault({
      stdout: '测试-'.repeat(4000),
      stderr: '',
      exitCode: 0,
    });

    const trace = createExecutionTrace('/repo');
    await runWithExecutionTrace(trace, async () => {
      await env.shell.exec('long-output', {});
    });

    expect(Buffer.byteLength(trace.commands[0]!.stdout, 'utf-8')).toBeLessThanOrEqual(TRACE_OUTPUT_MAX_BYTES);
  });

  it('wrapping an already-traced env is idempotent', async () => {
    const env = createMockExecutionEnv('/repo');
    const wrapped = createTracedExecutionEnv(env);
    expect(wrapped).toBe(env);
  });
});
