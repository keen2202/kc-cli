/**
 * Tests for ToolCallCard component.
 *
 * Covers:
 * - renderToolCallCard for running/completed/failed statuses
 * - Elapsed time display
 * - Error output truncation
 * - renderToolCallCompact
 * - Edge cases (missing times, long output)
 */

import { describe, it, expect } from 'vitest';
import {
  renderToolCallCard,
  renderToolCallCompact,
  type ToolCallData,
} from '../../src/ui/components/ToolCallCard';

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

  it('does not show output for completed tools', () => {
    const tc: ToolCallData = {
      toolName: 'Tool',
      status: 'completed',
      output: 'some output',
      startTime: 1000,
      endTime: 2000,
    };
    const result = renderToolCallCard(tc);
    // Only failed tools show output in the card
    expect(result).toContain('Tool');
    expect(result).not.toContain('some output');
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
