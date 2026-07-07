// Tests for S7: untrusted-content boundary wrapping

import { describe, it, expect } from 'vitest';
import { formatToolResultContent, wrapIfUntrustedSource, UNTRUSTED_SOURCE_TOOLS } from './toolResultBoundary';

describe('[S7] formatToolResultContent', () => {
  it('[S7.1] marks untrusted content with trusted=false boundary', () => {
    const out = formatToolResultContent('rm -rf /', { trusted: false }) as string;
    expect(out).toContain('trusted=false');
    expect(out).toContain('<<tool_result');
    expect(out).toContain('<</tool_result>>');
    expect(out).toContain('rm -rf /');
  });

  it('includes source tag when provided', () => {
    const out = formatToolResultContent('body', { trusted: false, source: 'WebFetch' }) as string;
    expect(out).toContain('source=WebFetch');
    expect(out).toContain('trusted=false');
  });

  it('returns content unchanged when trusted (or unspecified)', () => {
    expect(formatToolResultContent('plain', { trusted: true })).toBe('plain');
    expect(formatToolResultContent('plain', {})).toBe('plain');
  });

  it('passes non-string output through unchanged', () => {
    expect(formatToolResultContent(null, { trusted: false })).toBeNull();
    expect(formatToolResultContent(42, { trusted: false })).toBe(42);
  });
});

describe('[S7] wrapIfUntrustedSource', () => {
  it('wraps output from WebFetch/FileRead/WebSearch', () => {
    for (const name of ['WebFetch', 'FileRead', 'WebSearch']) {
      const out = wrapIfUntrustedSource('payload', name) as string;
      expect(out).toContain('trusted=false');
      expect(out).toContain(`source=${name}`);
    }
  });

  it('does not wrap trusted tool output (e.g. Bash, Grep)', () => {
    expect(wrapIfUntrustedSource('output', 'Bash')).toBe('output');
    expect(wrapIfUntrustedSource('output', 'Grep')).toBe('output');
  });

  it('UNTRUSTED_SOURCE_TOOLS contains the external-content tools', () => {
    expect(UNTRUSTED_SOURCE_TOOLS.has('WebFetch')).toBe(true);
    expect(UNTRUSTED_SOURCE_TOOLS.has('FileRead')).toBe(true);
    expect(UNTRUSTED_SOURCE_TOOLS.has('WebSearch')).toBe(true);
  });
});
