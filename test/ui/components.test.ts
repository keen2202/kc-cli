import { describe, it, expect } from 'vitest';
import { getTheme, type Theme } from '../../src/ui/theme';
import { renderChatMessage, type ChatMessage } from '../../src/ui/components/ChatView';
import { renderToolCallCard, type ToolCallData } from '../../src/ui/components/ToolCallCard';
import { renderStatusBar } from '../../src/ui/components/StatusBar';
import { renderInputBox, createInputState } from '../../src/ui/components/InputBox';
import { renderSidebar, createSidebarData } from '../../src/ui/components/Sidebar';
import { renderHeader } from '../../src/ui/components/Header';
import { renderThinkingIndicator } from '../../src/ui/components/ThinkingIndicator';
import { renderPermissionDialog } from '../../src/ui/components/PermissionDialog';
import { renderHelpPanel } from '../../src/ui/components/HelpPanel';
import { createDefaultKeybindings } from '../../src/ui/keybinding-manager';

const themes = ['dark', 'light'] as const;

describe('ChatView', () => {
  for (const themeName of themes) {
    it(`renders user message with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const msg: ChatMessage = { id: '1', role: 'user', content: 'Hello', timestamp: Date.now() };
      const output = renderChatMessage(msg, theme);
      expect(output).toContain('Hello');
      expect(output).toContain('> ');
    });

    it(`renders assistant message with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const msg: ChatMessage = { id: '2', role: 'assistant', content: 'Hi there', timestamp: Date.now() };
      const output = renderChatMessage(msg, theme);
      expect(output).toContain('Hi there');
    });

    it(`renders system message with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const msg: ChatMessage = { id: '3', role: 'system', content: 'System note', timestamp: Date.now() };
      const output = renderChatMessage(msg, theme);
      expect(output).toContain('System note');
    });
  }
});

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
      expect(output).toContain('3/50 turns');
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
      const output = renderInputBox(state, 'kc>', theme);
      expect(output).toContain('kc>');
      expect(output).toContain('hello world');
    });

    it(`renders steer mode with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const state = createInputState();
      state.steerMode = true;
      state.text = 'adjust output';
      const output = renderInputBox(state, 'kc>', theme);
      expect(output).toContain('steer>');
    });
  }
});

describe('Sidebar', () => {
  for (const themeName of themes) {
    it(`renders tools section with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const data = createSidebarData();
      data.tools = [
        { name: 'Bash', status: 'completed', duration: '1.2s' },
        { name: 'FileWrite', status: 'running' },
      ];
      const output = renderSidebar(data, 30, theme);
      expect(output).toContain('Tools');
      expect(output).toContain('Bash');
    });

    it(`returns empty when not visible with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const data = createSidebarData();
      data.visible = false;
      const output = renderSidebar(data, 30, theme);
      expect(output).toBe('');
    });
  }
});

describe('Header', () => {
  for (const themeName of themes) {
    it(`renders with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const result = renderHeader({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        sessionId: 'abc123',
        width: 80,
        theme,
      });
      expect(result.lines.length).toBe(2);
      expect(result.lines[0]).toContain('┌');
      expect(result.lines[1]).toContain('kc');
    });
  }
});

describe('ThinkingIndicator', () => {
  it('renders elapsed time', () => {
    const theme = getTheme('dark');
    const output = renderThinkingIndicator({ startTime: Date.now() - 2300, theme });
    expect(output).toContain('Thinking');
    expect(output).toContain('2.3s');
  });
});

describe('PermissionDialog', () => {
  for (const themeName of themes) {
    it(`renders with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const output = renderPermissionDialog({ toolName: 'Bash', inputSummary: 'rm -rf /tmp/test', theme });
      expect(output).toContain('Permission Required');
      expect(output).toContain('Bash');
      expect(output).toContain('[Y]');
    });
  }
});

describe('HelpPanel', () => {
  for (const themeName of themes) {
    it(`renders with ${themeName} theme`, () => {
      const theme = getTheme(themeName);
      const kb = createDefaultKeybindings();
      const output = renderHelpPanel({
        commands: [{ name: '/help', description: 'Show help' }],
        keybindings: kb.getAll(),
        theme,
      });
      expect(output).toContain('Help');
      expect(output).toContain('/help');
      expect(output).toContain('ctrl+k');
    });
  }
});
