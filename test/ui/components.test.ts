import { describe, it, expect } from 'vitest';
import { getTheme, type Theme } from '../../src/ui/theme';
import { renderToolCallCard, type ToolCallData } from '../../src/ui/components/ToolCallCard';
import { renderStatusBar } from '../../src/ui/components/StatusBar';
import { renderInputBox, createInputState } from '../../src/ui/components/InputBox';

const themes = ['dark', 'light'] as const;

describe('ToolCallCard', () => {
  for (const themeName of themes) {
    it(`renders running tool with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const tc: ToolCallData = { toolName: 'Bash', status: 'running', startTime: Date.now() };
      const output = renderToolCallCard(tc, theme);
      expect(output).toContain('Bash');
    });

    it(`renders completed tool with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const tc: ToolCallData = { toolName: 'FileWrite', status: 'completed', startTime: Date.now() - 1000, endTime: Date.now() };
      const output = renderToolCallCard(tc, theme);
      expect(output).toContain('FileWrite');
      expect(output).toContain('✓');
    });

    it(`renders failed tool with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const tc: ToolCallData = { toolName: 'Bash', status: 'failed', output: 'Command not found' };
      const output = renderToolCallCard(tc, theme);
      expect(output).toContain('✗');
      expect(output).toContain('Command not found');
    });
  }
});

describe('StatusBar', () => {
  for (const themeName of themes) {
    it(`renders with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const output = renderStatusBar({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        turnCount: 3,
        maxTurns: 50,
        sessionStartTime: Date.now() - 60000,
      }, theme);
      expect(output).toContain('anthropic/claude-sonnet-4-20250514');
      expect(output).toContain('3/50');
      expect(output).toContain('idle');
    });

    it(`returns empty when no data with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const output = renderStatusBar({}, theme);
      expect(output).toBe('');
    });
  }
});

describe('InputBox', () => {
  for (const themeName of themes) {
    it(`renders with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const state = createInputState();
      state.text = 'hello world';
      const lines = renderInputBox(state, 'kc>', theme);
      expect(Array.isArray(lines)).toBe(true);
      const joined = lines.join('');
      expect(joined).toContain('kc>');
      expect(joined).toContain('hello world');
    });

    it(`renders steer mode with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const state = createInputState();
      state.steerMode = true;
      state.text = 'adjust output';
      const lines = renderInputBox(state, 'kc>', theme);
      const joined = lines.join('');
      expect(joined).toContain('steer>');
    });
  }
});
