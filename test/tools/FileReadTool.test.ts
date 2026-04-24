// FileReadTool Tests

import { describe, it, expect } from '../test-utils';
import { tool as FileReadTool } from '../../src/tools/FileReadTool/index.js';

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

console.log('\n✅ FileReadTool tests completed');
