// Tests for FileEditTool error handling alignment (Q4)

import { describe, it, expect } from 'vitest';
import { tool } from './index';
import { createMockExecutionEnv } from '../../services/execution-env-mock';

describe('FileEditTool error handling', () => {
  it('returns error for non-existent file path (explicit check)', async () => {
    const env = createMockExecutionEnv('/tmp');
    const result = await tool.call(
      { file_path: 'nonexistent.txt', edits: [{ old_string: 'foo', new_string: 'bar', replace_all: false }], dry_run: false },
      { cwd: '/tmp', env } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.message).toContain('File not found');
  });

  it('returns structured error with stack for path traversal (catch block)', async () => {
    // Absolute path outside workspace triggers assertPathWithinWorkspace throw,
    // exercising the catch block with getErrorMessage + getErrorStack.
    const env = createMockExecutionEnv('/tmp');
    const result = await tool.call(
      { file_path: '/etc/passwd', edits: [{ old_string: 'foo', new_string: 'bar', replace_all: false }], dry_run: false },
      { cwd: '/tmp', env } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.message).toContain('File edit failed');
    expect(result.message).toContain('Path traversal denied');
    // Stack trace should be preserved in metadata
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.stack).toBeDefined();
  });
});
