// GrepTool Tests

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool as GrepTool } from '../../src/tools/GrepTool/index.js';

describe('GrepTool', () => {
  it('should have correct name', () => {
    expect(GrepTool.name).toBe('Grep');
  });

  it('should have description', () => {
    expect(GrepTool.description).toBeDefined();
  });

  it('should be marked as read-only', () => {
    expect(GrepTool.isReadOnly?.({ pattern: 'test', path: '.' })).toBe(true);
  });

  it('should be concurrency safe', () => {
    expect(GrepTool.isConcurrencySafe?.({ pattern: 'test', path: '.' })).toBe(true);
  });

  it('should support case insensitive search', () => {
    const schema = GrepTool.inputSchema;
    const parsed = schema.safeParse({
      pattern: 'test',
      case_sensitive: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.case_sensitive).toBe(false);
    }
  });

  it('should support file pattern filter', () => {
    const schema = GrepTool.inputSchema;
    const parsed = schema.safeParse({
      pattern: 'test',
      file_pattern: '*.ts',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file_pattern).toBe('*.ts');
    }
  });

  it('should support context lines', () => {
    const schema = GrepTool.inputSchema;
    const parsed = schema.safeParse({
      pattern: 'test',
      context_lines: 2,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.context_lines).toBe(2);
    }
  });

  it('should use default max results', () => {
    const schema = GrepTool.inputSchema;
    const parsed = schema.safeParse({
      pattern: 'test',
    });
    if (parsed.success) {
      expect(parsed.data.max_results).toBe(100);
    }
  });

  it('should default output_mode to content', () => {
    const parsed = GrepTool.inputSchema.safeParse({ pattern: 'x' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.output_mode).toBe('content');
    }
  });

  it('should reject input without pattern or patterns', () => {
    const parsed = GrepTool.inputSchema.safeParse({ path: '.' });
    expect(parsed.success).toBe(false);
  });

  it('should accept multi-pattern input', () => {
    const parsed = GrepTool.inputSchema.safeParse({
      patterns: ['alpha', 'beta'],
      output_mode: 'files_with_matches',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.patterns).toEqual(['alpha', 'beta']);
    }
  });
});

describe('GrepTool — call behavior (tmp tree)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kc-grep-'));
    await writeFile(join(dir, 'a.ts'), 'const alpha = 1;\nconst beta = 2;\nconst alphaBeta = alpha + beta;\n');
    await writeFile(join(dir, 'b.md'), '# alpha doc\nsome text\n');
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x4b, 0x43, 0x00, 0x01, 0x02]));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'c.ts'), 'alpha here\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeContext = (cwd: string) =>
    ({ cwd, env: {} }) as unknown as Parameters<typeof GrepTool.call>[1];

  it('finds matches in content mode (default)', async () => {
    const result = await GrepTool.call({ pattern: 'alpha', path: dir }, makeContext(dir));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('a.ts:1');
    expect(result.output).toContain('a.ts:3');
    expect(result.output).toContain(join('sub', 'c.ts') + ':1');
    expect(result.output).not.toContain('bin.dat');
  });

  it('OR-matches multiple patterns in one traversal', async () => {
    const result = await GrepTool.call(
      { patterns: ['alpha', 'some text'], path: dir, output_mode: 'files_with_matches' },
      makeContext(dir),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.md');
    expect(result.output).toContain('c.ts');
  });

  it('files_with_matches lists unique files only', async () => {
    const result = await GrepTool.call(
      { pattern: 'alpha', path: dir, output_mode: 'files_with_matches' },
      makeContext(dir),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('3 file(s)');
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.md');
    expect(result.output).toContain('c.ts');
  });

  it('count mode reports per-file counts', async () => {
    const result = await GrepTool.call(
      { pattern: 'alpha', path: dir, output_mode: 'count' },
      makeContext(dir),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('a.ts: 2');
    expect(result.output).toContain('c.ts: 1');
  });

  it('skips binary files via null-byte sniff', async () => {
    const result = await GrepTool.call(
      { patterns: ['KC', '.'], path: dir, output_mode: 'files_with_matches' },
      makeContext(dir),
    );
    expect(result.isError).toBe(false);
    expect(result.output).not.toContain('bin.dat');
  });
});

