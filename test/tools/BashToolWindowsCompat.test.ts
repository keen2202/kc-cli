// Windows Unix-command compatibility detection (find-failure fix)

import { describe, it, expect } from 'vitest';
import {
  detectUnixFindOnWindows,
  getWindowsCommandHint,
  isCommandNotFoundOutput,
} from '../../src/tools/BashTool/windows-compat.js';

describe('detectUnixFindOnWindows', () => {
  it('detects Unix find with -name on win32', () => {
    const msg = detectUnixFindOnWindows('find . -name "*.ts"', 'win32');
    expect(msg).toBeTruthy();
    expect(msg).toContain('Glob');
    expect(msg).toContain('Get-ChildItem');
  });

  it('detects find with -type/-maxdepth/-exec flags', () => {
    expect(detectUnixFindOnWindows('find src -type f -maxdepth 2', 'win32')).toBeTruthy();
    expect(detectUnixFindOnWindows('find / -name x -exec rm {} \\;', 'win32')).toBeTruthy();
  });

  it('returns null on non-Windows platforms', () => {
    expect(detectUnixFindOnWindows('find . -name "*.ts"', 'linux')).toBeNull();
    expect(detectUnixFindOnWindows('find . -name "*.ts"', 'darwin')).toBeNull();
  });

  it('does not flag Windows FIND.EXE text-search usage', () => {
    // `find "string" file` is the legitimate Windows syntax.
    expect(detectUnixFindOnWindows('find "TODO" notes.txt', 'win32')).toBeNull();
  });

  it('does not flag unrelated commands', () => {
    expect(detectUnixFindOnWindows('git status', 'win32')).toBeNull();
    expect(detectUnixFindOnWindows('findstr /s pattern *.ts', 'win32')).toBeNull();
  });
});

describe('getWindowsCommandHint', () => {
  it('hints Windows-native replacements for Unix-only commands', () => {
    expect(getWindowsCommandHint('grep -r foo src', 'win32')).toContain('Grep tool');
    expect(getWindowsCommandHint('touch a.txt', 'win32')).toContain('New-Item');
    expect(getWindowsCommandHint('which node', 'win32')).toContain('where');
  });

  it('returns null for native Windows commands and non-win32', () => {
    expect(getWindowsCommandHint('dir /b', 'win32')).toBeNull();
    expect(getWindowsCommandHint('grep -r foo src', 'linux')).toBeNull();
  });
});

describe('isCommandNotFoundOutput', () => {
  it('matches cmd.exe and PowerShell not-found signatures', () => {
    expect(isCommandNotFoundOutput("'grep' is not recognized as an internal or external command")).toBe(true);
    expect(isCommandNotFoundOutput('grep : The term is not recognized as the name of a cmdlet')).toBe(true);
    expect(isCommandNotFoundOutput('bash: foo: command not found')).toBe(true);
  });

  it('does not match ordinary failures', () => {
    expect(isCommandNotFoundOutput('FIND: Parameter format not correct')).toBe(false);
  });
});
