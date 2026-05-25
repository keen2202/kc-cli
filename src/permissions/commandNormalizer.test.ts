import { describe, it, expect } from 'vitest';
import {
  normalizeCommand,
  splitSubCommands,
  detectBypassAttempts,
  prepareCommandForPermissionCheck,
} from './commandNormalizer';

describe('normalizeCommand', () => {
  it('normalizes multi-spaces to single space', () => {
    expect(normalizeCommand('ls   /etc')).toBe('ls /etc');
  });

  it('normalizes tabs to spaces', () => {
    expect(normalizeCommand('ls\t-la\t/etc')).toBe('ls -la /etc');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeCommand('  ls -la  ')).toBe('ls -la');
  });

  it('removes escape characters', () => {
    expect(normalizeCommand('r\\m -rf /tmp')).toBe('rm -rf /tmp');
  });

  it('removes zero-width characters', () => {
    const withZWSP = 'ls​ -la'; // Zero-width space after 'ls'
    expect(normalizeCommand(withZWSP)).toBe('ls -la');
  });

  it('handles empty command', () => {
    expect(normalizeCommand('')).toBe('');
  });

  it('handles undefined/null gracefully', () => {
    expect(normalizeCommand(undefined as unknown as string)).toBe('');
    expect(normalizeCommand(null as unknown as string)).toBe('');
  });

  it('normalizes command but keeps safe commands safe', () => {
    expect(normalizeCommand('ls -la')).toBe('ls -la');
    expect(normalizeCommand('cat file.txt')).toBe('cat file.txt');
  });

  it('multi-space bypass is normalized away', () => {
    const bypassCmd = 'r\\m     -rf      /';
    const normalized = normalizeCommand(bypassCmd);
    expect(normalized).toBe('rm -rf /');
  });
});

describe('splitSubCommands', () => {
  it('returns single command unchanged', () => {
    expect(splitSubCommands('ls -la')).toEqual(['ls -la']);
  });

  it('splits pipe-separated commands', () => {
    const result = splitSubCommands('cat file | grep pattern');
    expect(result).toContain('cat file');
    expect(result).toContain('grep pattern');
  });

  it('splits semicolon-separated commands', () => {
    const result = splitSubCommands('ls; rm -rf /');
    expect(result).toContain('ls');
    expect(result).toContain('rm -rf /');
  });

  it('splits && chained commands', () => {
    const result = splitSubCommands('ls && rm -rf /');
    expect(result).toContain('ls');
    expect(result).toContain('rm -rf /');
  });

  it('splits || chained commands', () => {
    const result = splitSubCommands('ls || echo fail');
    expect(result).toContain('ls');
    expect(result).toContain('echo fail');
  });

  it('handles empty command', () => {
    expect(splitSubCommands('')).toEqual([]);
  });
});

describe('detectBypassAttempts', () => {
  it('detects multi-space bypass', () => {
    const result = detectBypassAttempts('ls   /etc');
    expect(result.hasBypass).toBe(true);
    expect(result.vectors).toContain('multi-space');
  });

  it('detects escape character bypass', () => {
    const result = detectBypassAttempts('r\\m file');
    expect(result.hasBypass).toBe(true);
    expect(result.vectors).toContain('escape-chars');
  });

  it('detects command chaining', () => {
    const result = detectBypassAttempts('ls; rm -rf /');
    expect(result.hasBypass).toBe(true);
    expect(result.vectors).toContain('command-chaining');
  });

  it('returns no bypass for normal commands', () => {
    const result = detectBypassAttempts('ls -la');
    expect(result.hasBypass).toBe(false);
  });
});

describe('prepareCommandForPermissionCheck', () => {
  it('normalizes and detects bypass attempts', () => {
    const result = prepareCommandForPermissionCheck('r\\m     -rf  /tmp');
    expect(result.normalized).toBe('rm -rf /tmp');
    expect(result.hasBypassAttempt).toBe(true);
  });

  it('splits sub-commands for compound commands', () => {
    const result = prepareCommandForPermissionCheck('cat file | grep pattern');
    expect(result.subCommands.length).toBe(2);
    expect(result.normalized).toBe('cat file | grep pattern');
  });

  it('handles normal commands correctly', () => {
    const result = prepareCommandForPermissionCheck('ls -la');
    expect(result.normalized).toBe('ls -la');
    expect(result.subCommands).toEqual(['ls -la']);
    expect(result.hasBypassAttempt).toBe(false);
  });
});
