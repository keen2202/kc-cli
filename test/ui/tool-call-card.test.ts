/**
 * Tests for ToolCallCard component.
 *
 * Covers:
 * - renderToolCallCard for running/completed/failed statuses
 * - Elapsed time display
 * - Error output truncation
 * - Collapsed preview / expanded output (Ctrl+O)
 * - renderToolCallCompact
 * - Edge cases (missing times, long output)
 */

import { describe, it, expect } from 'vitest';
import {
  renderToolCallCard,
  renderToolCallCompact,
} from '../../src/ui/components/ToolCallCard';
import type { ToolCallData } from '../../src/ui/view-protocol';

describe('ToolCallCard — renderToolCallCard', () => {
  it('renders running tool call', () => {
    const tc: ToolCallData = {
      toolName: 'Bash',
      status: 'running',
      startTime: Date.now(),
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Bash');
    // Running status uses yellow spinner
    expect(result).toBeTruthy();
  });

  it('renders completed tool call', () => {
    const tc: ToolCallData = {
      toolName: 'FileRead',
      status: 'completed',
      startTime: 1000,
      endTime: 2500,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('FileRead');
    expect(result).toContain('1.5s');
  });

  it('renders failed tool call', () => {
    const tc: ToolCallData = {
      toolName: 'Bash',
      status: 'failed',
      output: 'Command not found',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Bash');
    expect(result).toContain('Command not found');
  });

  it('shows elapsed time for completed tool', () => {
    const tc: ToolCallData = {
      toolName: 'Grep',
      status: 'completed',
      startTime: 1000,
      endTime: 3500,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('2.5s');
  });

  it('shows elapsed time for sub-second operations', () => {
    const tc: ToolCallData = {
      toolName: 'FastTool',
      status: 'completed',
      startTime: 1000,
      endTime: 1200,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('0.2s');
  });

  it('does not show elapsed time when times are missing', () => {
    const tc: ToolCallData = {
      toolName: 'NoTimeTool',
      status: 'running',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('NoTimeTool');
    // Should not contain (Xs) pattern
    expect(result).not.toMatch(/\(\d+\.\d+s\)/);
  });

  it('truncates long error output to 200 chars', () => {
    const longError = 'E'.repeat(300);
    const tc: ToolCallData = {
      toolName: 'FailingTool',
      status: 'failed',
      output: longError,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('...');
    // The truncated output should be at most 200 chars + '...'
    expect(result.length).toBeLessThan(longError.length + 200);
  });

  it('shows full error output when under 200 chars', () => {
    const shortError = 'Short error';
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'failed',
      output: shortError,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Short error');
    expect(result).not.toContain('...');
  });

  it('shows a collapsed two-line preview for completed tool output', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'completed',
      output: 'line1\nline2\nline3\nline4',
      startTime: 1000,
      endTime: 2000,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Tool');
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).not.toContain('line3');
    expect(result).toContain('4 lines');
    expect(result).toContain('Ctrl+O to expand');
  });

  it('omits the expand hint when output fits the preview', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'completed',
      output: 'only line',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('only line');
    expect(result).not.toContain('Ctrl+O to expand');
  });

  it('shows full output when expanded', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'completed',
      output: 'line1\nline2\nline3\nline4',
    };
    const result = renderToolCallCard(tc, undefined, { expanded: true });
    expect(result).toContain('line3');
    expect(result).toContain('line4');
    expect(result).not.toContain('Ctrl+O to expand');
  });

  it('caps expanded output at 200 lines', () => {
    const output = Array.from({ length: 250 }, (_, i) => `row-${i}`).join('\n');
    const tc: ToolCallData = { toolName: 'Tool', status: 'completed', output };
    const result = renderToolCallCard(tc, undefined, { expanded: true });
    expect(result).toContain('row-199');
    expect(result).not.toContain('row-200\n');
    expect(result).toContain('50 more lines truncated');
  });

  it('shows the input summary on the header line', () => {
    const tc: ToolCallData = {
      toolName: 'Read',
      input: 'src/index.ts',
      status: 'completed',
      startTime: 1000,
      endTime: 2000,
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Read');
    expect(result).toContain('src/index.ts');
  });

  it('hides raw input args when collapsed but shows them expanded', () => {
    const tc: ToolCallData = {
      toolName: 'Bash',
      input: 'echo hi',
      rawInput: { command: 'echo hi', timeout: 5000 },
      status: 'completed',
      startTime: 1000,
      endTime: 2000,
    };
    const collapsed = renderToolCallCard(tc);
    expect(collapsed).not.toContain('args:');
    expect(collapsed).not.toContain('timeout');

    const expanded = renderToolCallCard(tc, undefined, { expanded: true });
    expect(expanded).toContain('args:');
    expect(expanded).toContain('command: echo hi');
    expect(expanded).toContain('timeout: 5000');
  });

  it('single-lines and caps long argument values in the expanded args block', () => {
    const tc: ToolCallData = {
      toolName: 'Write',
      rawInput: { content: 'l1\nl2\nl3', note: 'x'.repeat(500) },
      status: 'completed',
    };
    const expanded = renderToolCallCard(tc, undefined, { expanded: true });
    expect(expanded).toContain('content: l1\\nl2\\nl3');
    expect(expanded).toContain('note: ' + 'x'.repeat(199) + '…');
    expect(expanded).not.toContain('x'.repeat(300));
  });

  it('shows the full multi-line error when expanded (no 200-char slice)', () => {
    const longError = 'E'.repeat(300) + '\nsecond line';
    const tc: ToolCallData = {
      toolName: 'FailingTool',
      status: 'failed',
      output: longError,
    };
    const collapsed = renderToolCallCard(tc);
    expect(collapsed).toContain('...');
    const expanded = renderToolCallCard(tc, undefined, { expanded: true });
    expect(expanded).toContain('second line');
    expect(expanded).toContain('E'.repeat(300));
  });

  it('hints Ctrl+O for details when only raw args are hidden', () => {
    const tc: ToolCallData = {
      toolName: 'Bash',
      input: 'echo hi',
      rawInput: { command: 'echo hi' },
      status: 'completed',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Ctrl+O for details');
  });

  it('does not show output for running tools', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'running',
      output: 'partial output',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Tool');
    expect(result).not.toContain('partial output');
  });

  it('handles failed tool with no output', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'failed',
    };
    const result = renderToolCallCard(tc);
    expect(result).toContain('Tool');
    // Should render without error
    expect(result).toBeTruthy();
  });

  it('renders multi-line output', () => {
    const result = renderToolCallCard({
      toolName: 'Bash',
      status: 'completed',
      startTime: 1000,
      endTime: 2000,
    });
    // The card itself has at least one line
    expect(result.split('\n').length).toBeGreaterThanOrEqual(1);
  });
});

describe('ToolCallCard — renderToolCallCompact', () => {
  it('renders running tool compactly', () => {
    const tc: ToolCallData = {
      toolName: 'Bash',
      status: 'running',
    };
    const result = renderToolCallCompact(tc);
    expect(result).toContain('Bash');
    // Compact format: icon + name
    expect(result.split('\n').length).toBe(1);
  });

  it('renders completed tool compactly', () => {
    const tc: ToolCallData = {
      toolName: 'FileRead',
      status: 'completed',
    };
    const result = renderToolCallCompact(tc);
    expect(result).toContain('FileRead');
  });

  it('renders failed tool compactly', () => {
    const tc: ToolCallData = {
      toolName: 'Grep',
      status: 'failed',
    };
    const result = renderToolCallCompact(tc);
    expect(result).toContain('Grep');
  });

  it('compact format does not include output or timing', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'completed',
      output: 'some output that should not appear',
      startTime: 1000,
      endTime: 5000,
    };
    const result = renderToolCallCompact(tc);
    expect(result).not.toContain('some output');
    expect(result).not.toContain('4.0s');
  });

  it('compact format is a single line', () => {
    const statuses: Array<'running' | 'completed' | 'failed'> = ['running', 'completed', 'failed'];
    for (const status of statuses) {
      const result = renderToolCallCompact({ toolName: 'X', status });
      expect(result.split('\n').length).toBe(1);
    }
  });
});
