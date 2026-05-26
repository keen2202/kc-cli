// FileReadTool Tests

import { describe, it, expect } from 'vitest';
import { tool as FileReadTool } from '../../src/tools/FileReadTool/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createTempFile(content: string): string {
  const tmpPath = path.join(os.tmpdir(), `kc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

describe('FileReadTool', () => {
  it('should have correct name', () => {
    expect(FileReadTool.name).toBe('FileRead');
  });

  it('should have description', () => {
    expect(FileReadTool.description).toBeDefined();
    expect(typeof FileReadTool.description).toBe('string');
  });

  it('should have input schema', () => {
    expect(FileReadTool.inputSchema).toBeDefined();
  });

  it('should be marked as read-only', () => {
    expect(FileReadTool.isReadOnly?.({ path: 'test.txt' })).toBe(true);
  });

  it('should be concurrency safe', () => {
    expect(FileReadTool.isConcurrencySafe?.({ path: 'test.txt' })).toBe(true);
  });

  it('should allow reads in permission check', () => {
    const result = FileReadTool.checkPermissions!(
      { path: 'test.txt' },
      { cwd: process.cwd(), abortController: new AbortController() } as any
    );
    expect(result.behavior).toBe('allow');
  });

  it('should support range input', () => {
    const schema = FileReadTool.inputSchema;
    const parsed = schema.safeParse({
      path: 'test.txt',
      range: { start: 0, end: 10 },
    });
    expect(parsed.success).toBe(true);
  });

  it('should use default max size', () => {
    const schema = FileReadTool.inputSchema;
    const parsed = schema.safeParse({
      path: 'test.txt',
    });
    if (parsed.success) {
      expect(parsed.data.maxSize).toBe(100000);
    }
  });
});

describe('FileReadTool streaming', () => {
  it('reads a file within maxSize completely', async () => {
    const tmpPath = createTempFile('line1\nline2\nline3\n');
    try {
      const result = await FileReadTool.call!(
        { path: tmpPath, maxSize: 100 },
        { cwd: '/', abortController: new AbortController(), sandbox: undefined }
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('line1');
      expect(result.output).toContain('line3');
      expect(result.metadata?.lines).toBe(4);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('returns preview for files exceeding maxSize', async () => {
    // Create a file with 200 lines (~2000 bytes)
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i.toString().padStart(5, '0')}`);
    const tmpPath = createTempFile(lines.join('\n'));
    try {
      const result = await FileReadTool.call!(
        { path: tmpPath, maxSize: 100 },
        { cwd: '/', abortController: new AbortController(), sandbox: undefined }
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('File is');
      expect(result.output).toContain('First 50 lines');
      expect(result.output).toContain('Last 50 lines');
      expect(result.metadata?.previewOnly).toBe(true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('returns error for non-existent files', async () => {
    const result = await FileReadTool.call!(
      { path: '/nonexistent/file/path.txt' },
      { cwd: '/', abortController: new AbortController(), sandbox: undefined }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBeFalsy();
    expect(result.message).toContain('File not found');
  });

  it('applies range to small files', async () => {
    const tmpPath = createTempFile('a\nb\nc\nd\ne\n');
    try {
      const result = await FileReadTool.call!(
        { path: tmpPath, maxSize: 100, range: { start: 1, end: 3 } },
        { cwd: '/', abortController: new AbortController(), sandbox: undefined }
      );
      expect(result.isError).toBe(false);
      expect(result.output).toBe('b\nc');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

