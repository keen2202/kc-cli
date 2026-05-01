// FileWriteTool Tests

import { describe, it, expect } from 'vitest';
import { tool as FileWriteTool } from '../../src/tools/FileWriteTool/index.js';

describe('FileWriteTool', () => {
  it('should have correct name', () => {
    expect(FileWriteTool.name).toBe('FileWrite');
  });

  it('should have description', () => {
    expect(FileWriteTool.description).toBeDefined();
  });

  it('should NOT be marked as read-only', () => {
    expect(FileWriteTool.isReadOnly?.({ path: 'test.txt', content: 'test' })).toBe(false);
  });

  it('should ask for permission', () => {
    const result = FileWriteTool.checkPermissions!(
      { path: 'test.txt', content: 'test' },
      { cwd: process.cwd(), abortController: new AbortController() } as any
    );
    expect(result.behavior).toBe('ask');
  });

  it('should support append mode', () => {
    const schema = FileWriteTool.inputSchema;
    const parsed = schema.safeParse({
      path: 'test.txt',
      content: 'test',
      append: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.append).toBe(true);
    }
  });

  it('should validate required fields', () => {
    const schema = FileWriteTool.inputSchema;
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

