// FileEdit / FileWrite concurrency — round4 §3-R1
//
// This is the one place in the project where a missing mutex silently destroys
// user data: two agents read the same file, both write, and the second write
// erases the first edit outright — no error, no log.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { tool as FileEditTool } from '../../src/tools/FileEditTool/index';
import { tool as FileWriteTool } from '../../src/tools/FileWriteTool/index';
import { createLocalExecutionEnv } from '../../src/services/execution-env-local';

let workDir = '';

function makeContext(cwd: string) {
  return {
    cwd,
    abortController: new AbortController(),
    sandbox: undefined,
    env: createLocalExecutionEnv(cwd),
  } as never;
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`).join('\n') + '\n';
}

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kc-edit-conc-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('FileWrite append under concurrency', () => {
  it('keeps both payloads when two writers append at once', async () => {
    const target = path.join(workDir, 'appended.txt');
    fs.writeFileSync(target, '');

    // Two "sub-agents" appending different content simultaneously. Without the
    // per-file lock both read the empty file and one payload is lost.
    await Promise.all([
      FileWriteTool.call(
        { path: target, content: lines('A', 50), append: true },
        makeContext(workDir),
      ),
      FileWriteTool.call(
        { path: target, content: lines('B', 50), append: true },
        makeContext(workDir),
      ),
    ]);

    const content = fs.readFileSync(target, 'utf-8');
    const aLines = content.split('\n').filter((l) => l.startsWith('A-')).length;
    const bLines = content.split('\n').filter((l) => l.startsWith('B-')).length;

    expect(aLines).toBe(50);
    expect(bLines).toBe(50);
  });
});

describe('FileEdit read-modify-write under concurrency', () => {
  it('reports a conflict instead of silently overwriting a concurrent edit', async () => {
    const target = path.join(workDir, 'conflict.txt');
    fs.writeFileSync(target, 'marker\n');

    // Drive the conflict deterministically: hand the tool a FileSystem whose
    // second `stat` call reports that the file changed underneath it. That is
    // exactly the situation the optimistic-concurrency check exists for.
    const base = createLocalExecutionEnv(workDir);
    let statCalls = 0;
    // Prototype-based override: `LocalFileSystem` methods live on the
    // prototype, so a plain spread would drop every one of them.
    const fsProxy = Object.create(base.fs) as typeof base.fs;
    fsProxy.stat = async (p: string) => {
      const stats = await base.fs.stat(p);
      statCalls += 1;
      return statCalls === 1
        ? stats
        : { ...stats, mtime: new Date(stats.mtime.getTime() + 5_000), size: stats.size + 42 };
    };
    const env = { ...base, fs: fsProxy };

    const result = await FileEditTool.call(
      { file_path: target, edits: [{ old_string: 'marker', new_string: 'edited' }] },
      { cwd: workDir, abortController: new AbortController(), sandbox: undefined, env } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/changed while editing/i);
    // Critically, the file must be untouched — no silent overwrite.
    expect(fs.readFileSync(target, 'utf-8')).toBe('marker\n');
  });

  it('applies a normal edit and returns the new content', async () => {
    const target = path.join(workDir, 'plain.txt');
    fs.writeFileSync(target, 'hello world\n');

    const result = await FileEditTool.call(
      { file_path: target, edits: [{ old_string: 'world', new_string: 'kc' }] },
      makeContext(workDir),
    );

    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello kc\n');
  });

  it('errors when the search string is absent', async () => {
    const target = path.join(workDir, 'absent.txt');
    fs.writeFileSync(target, 'nothing here\n');

    const result = await FileEditTool.call(
      { file_path: target, edits: [{ old_string: 'missing', new_string: 'x' }] },
      makeContext(workDir),
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain('String not found');
  });
});
