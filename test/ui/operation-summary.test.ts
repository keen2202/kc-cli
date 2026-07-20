/**
 * Tests for the OperationSummary pure helpers that derive human-readable
 * steps/expected results from tool authorization requests and the sidebar.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeOperation, operationsFromTools } from '../../src/ui/components/OperationSummary';

describe('synthesizeOperation', () => {
  it('summarizes file edits from diffs', () => {
    const op = synthesizeOperation('write_file', 'edit a.ts', [
      { filePath: 'a.ts', oldContent: 'x', newContent: 'y' },
      { filePath: 'b.ts', oldContent: '', newContent: 'z' },
    ]);
    expect(op.toolName).toBe('write_file');
    expect(op.summary).toBe('edit a.ts');
    expect(op.steps).toEqual(['Edit a.ts', 'Edit b.ts']);
    expect(op.expected).toBe('Modify 2 file(s): a.ts, b.ts');
  });

  it('truncates the file list with an ellipsis beyond three files', () => {
    const op = synthesizeOperation('write_file', undefined, [
      { filePath: 'a.ts', oldContent: '', newContent: '' },
      { filePath: 'b.ts', oldContent: '', newContent: '' },
      { filePath: 'c.ts', oldContent: '', newContent: '' },
      { filePath: 'd.ts', oldContent: '', newContent: '' },
    ]);
    expect(op.expected).toBe('Modify 4 file(s): a.ts, b.ts, c.ts, …');
  });

  it('derives steps for write/edit, bash and git tools without diffs', () => {
    expect(synthesizeOperation('edit_file').expected).toBe('File contents updated');
    expect(synthesizeOperation('bash').expected).toBe('Command output captured');
    expect(synthesizeOperation('git_commit').expected).toBe('Repository state updated');
  });

  it('falls back to a generic step for unknown tools', () => {
    const op = synthesizeOperation('search_web');
    expect(op.steps).toEqual(['Invoke search_web']);
    expect(op.expected).toBe('Tool result returned');
  });
});

describe('operationsFromTools', () => {
  it('keeps only running and pending tools', () => {
    const ops = operationsFromTools([
      { name: 'read', status: 'completed' },
      { name: 'edit', status: 'running' },
      { name: 'bash', status: 'pending' },
      { name: 'grep', status: 'failed' },
    ]);
    expect(ops.map((o) => o.toolName)).toEqual(['edit', 'bash']);
    expect(ops[0]!.status).toBe('running');
  });

  it('returns an empty list when nothing is active', () => {
    expect(operationsFromTools([{ name: 'x', status: 'completed' }])).toEqual([]);
    expect(operationsFromTools([])).toEqual([]);
  });
});
