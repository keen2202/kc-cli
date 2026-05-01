// GrepTool Tests

import { describe, it, expect } from 'vitest';
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
});

