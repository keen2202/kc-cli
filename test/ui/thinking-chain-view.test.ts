/**
 * renderThinkingChain two-state rendering (T2, ui-runtime-hardening).
 *
 * Streaming (no endTime): header shows a live timer plus a one-line preview
 * of the latest step so long reasoning phases are visibly alive.
 * Completed (endTime set): folded single-line header with the duration frozen
 * (previously `Date.now()` kept the timer counting after the turn ended).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderThinkingChain } from '../../src/ui/components/ThinkingChainView';
import { getTheme } from '../../src/ui/theme';
import type { ThinkingChain } from '../../src/ui/view-protocol';

const tokens = getTheme('dark').resolve();

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*m/g, '');

function makeChain(overrides: Partial<ThinkingChain> = {}): ThinkingChain {
  return {
    steps: [
      { label: 'analyze', content: 'Analyzing the request structure' },
      { label: 'plan', content: 'Planning the modification strategy' },
    ],
    rawContent: 'Analyzing the request structure Planning the modification strategy',
    folded: true,
    startTime: 10_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('renderThinkingChain', () => {
  it('streaming: shows a live one-line preview of the latest step', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_500); // 2.5s after startTime

    const out = stripAnsi(renderThinkingChain(makeChain(), tokens));
    const lines = out.split('\n');

    expect(lines[0]).toContain('Thinking (2 steps, 2.5s)');
    // The newest step is previewed under the header while streaming.
    expect(lines[1]).toContain('[plan]');
    expect(lines[1]).toContain('Planning the modification strategy');
    expect(lines).toHaveLength(2);
  });

  it('streaming: preview is a single truncated line even for long multi-line content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000);

    const longContent = 'first line\nsecond line ' + 'x'.repeat(200);
    const out = stripAnsi(renderThinkingChain(
      makeChain({ steps: [{ label: 'think', content: longContent }] }),
      tokens,
    ));

    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    // Newlines collapsed, content truncated with an ellipsis marker.
    expect(lines[1]).toContain('first line second line');
    expect(lines[1]).toContain('...');
  });

  it('completed: renders only the folded header with the duration frozen by endTime', () => {
    vi.useFakeTimers();
    // System clock is far past endTime — the duration must not keep counting.
    vi.setSystemTime(999_000);

    const out = stripAnsi(renderThinkingChain(
      makeChain({ endTime: 11_200 }), // 1.2s after startTime
      tokens,
    ));

    expect(out).toContain('Thinking (2 steps, 1.2s)');
    expect(out.split('\n')).toHaveLength(1);
    expect(out).not.toContain('Planning the modification strategy');
  });

  it('streaming with no steps yet: renders just the header', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_400);

    const out = stripAnsi(renderThinkingChain(
      makeChain({ steps: [], rawContent: '' }),
      tokens,
    ));

    expect(out).toContain('Thinking (0 steps, 0.4s)');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('unfolded: still lists every step (legacy expanded view)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000);

    const out = stripAnsi(renderThinkingChain(makeChain({ folded: false }), tokens));
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('[analyze]');
    expect(lines[2]).toContain('[plan]');
  });
});
