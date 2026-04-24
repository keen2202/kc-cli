// Bash Tool Tests

import { describe, it, expect, printTestSummary } from '../test-utils';
import { tool as BashTool } from '../../src/tools/BashTool/index.js';
import { isReadOnlyBashCommand, DANGEROUS_BASH_PATTERNS } from '../../src/permissions/readonlyCommands.js';

describe('BashTool', () => {
  it('should have correct name', () => {
    expect(BashTool.name).toBe('Bash');
  });

  it('should have description', () => {
    expect(BashTool.description).toBeDefined();
    expect(typeof BashTool.description).toBe('string');
  });

  it('should have input schema', () => {
    expect(BashTool.inputSchema).toBeDefined();
  });

  it('should be marked as not read-only by default', () => {
    const result = BashTool.isReadOnly?.({ command: 'ls' });
    expect(result).toBe(false);
  });

  it('should mark read-only commands correctly', () => {
    expect(BashTool.isReadOnly?.({ command: 'ls -la' })).toBe(true);
    expect(BashTool.isReadOnly?.({ command: 'cat file.txt' })).toBe(true);
    expect(BashTool.isReadOnly?.({ command: 'pwd' })).toBe(true);
  });

  it('should not mark write commands as read-only', () => {
    expect(BashTool.isReadOnly?.({ command: 'echo "test" > file.txt' })).toBe(false);
    expect(BashTool.isReadOnly?.({ command: 'touch newfile.txt' })).toBe(false);
  });

  it('should have permission check function', () => {
    expect(BashTool.checkPermissions).toBeDefined();
  });

  it('should allow read-only commands in permission check', () => {
    const result = BashTool.checkPermissions!(
      { command: 'ls -la', timeout: 30, background: false },
      { cwd: process.cwd(), abortController: new AbortController() } as any
    );
    expect(result.behavior).toBe('allow');
  });

  it('should ask for non-read-only commands', () => {
    const result = BashTool.checkPermissions!(
      { command: 'echo test', timeout: 30, background: false },
      { cwd: process.cwd(), abortController: new AbortController() } as any
    );
    expect(result.behavior).toBe('ask');
  });
});

describe('Readonly Commands', () => {
  it('should identify ls as read-only', () => {
    expect(isReadOnlyBashCommand('ls -la')).toBe(true);
  });

  it('should identify cat as read-only', () => {
    expect(isReadOnlyBashCommand('cat file.txt')).toBe(true);
  });

  it('should identify grep as read-only', () => {
    expect(isReadOnlyBashCommand('grep pattern file.txt')).toBe(true);
  });

  it('should not identify rm as read-only', () => {
    expect(isReadOnlyBashCommand('rm file.txt')).toBe(false);
  });

  it('should match dangerous command patterns', () => {
    const dangerousCommand = 'rm -rf /';
    const isDangerous = DANGEROUS_BASH_PATTERNS.some(p => p.test(dangerousCommand));
    expect(isDangerous).toBe(true);
  });
});

console.log('\n✅ BashTool tests completed');
