import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { ThemeProvider, useTheme } from '../hooks/useTheme';
import { DEFAULT_THEME } from '../theme';
import { useStreamingEvents } from '../hooks/useStreamingEvents';
import { Layout } from './Layout';
import { HeaderBar } from './HeaderBar';
import { ChatPanel } from './ChatPanel';
import { SessionInfo } from './SessionInfo';
import { Editor, openExternalEditor } from './Editor';
import { StatusBar } from './StatusBarView.js';
import { UIEventBus } from '../event-bus';
import { createDefaultKeybindings } from '../keybinding-manager';
import { isPrintableUnicode } from '../keypress';
import { normalizeSlashCommand } from './slash-commands';
import {
  createInputState,
  insertChar,
  deleteBefore,
  insertNewline,
  moveCursorLeft,
  moveCursorRight,
  moveToLineStart,
  deleteWordBefore,
  deleteToLineStart,
  toggleSteerMode,
  type InputState,
} from './InputBox';
import { getErrorMessage } from '../../utils/errors';
import type { QueryEngine } from '../../query/QueryEngine';
import { getState, updateState } from '../../bootstrap/state';
import { toolRegistry } from '../../tools';
import { UserProfileService } from '../../services/userProfile';
import type { UserLevel } from '../../services/userProfile';
import type { PermissionMode } from '../../permissions/protocol';

// ── Error Bar ──

interface ErrorBarProps {
  errors: string[];
  onDismiss: (index: number) => void;
}

function ErrorBar({ errors, onDismiss }: ErrorBarProps) {
  if (errors.length === 0) return null;

  // Show the most recent error
  const latest = errors[errors.length - 1];

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor="red"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <Text color="red">⚠ Error: </Text>
      <Text>{latest}</Text>
      <Text dimColor>  [Esc to dismiss]</Text>
    </Box>
  );
}

// ── Exit Confirmation Dialog ──

interface ExitConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function ExitConfirmDialog({ onConfirm, onCancel }: ExitConfirmDialogProps) {
  useInput((input: string, key: any) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
    }
    if (key.escape || input === 'n' || input === 'N') {
      onCancel();
    }
  });

  return (
    <Box
      position="absolute"
      top="50%"
      left="50%"
      flexDirection="column"
      borderStyle="single"
      padding={1}
      backgroundColor="#1a1b26"
    >
      <Box marginBottom={1}>
        <Text bold>Exit kc-cli?</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>Any active session will be terminated.</Text>
      </Box>
      <Box flexDirection="row">
        <Text>[Y] Yes, exit  </Text>
        <Text dimColor>[N/Esc] Cancel</Text>
      </Box>
    </Box>
  );
}

// ── Sidebar placeholder ──

function SidebarPlaceholder() {
  const { tokens } = useTheme();
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Tools</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>Files</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>Tasks</Text>
      </Box>
      <Box>
        <Text bold>Memory</Text>
      </Box>
    </Box>
  );
}

// ── Main App ──

interface AppOpenCodeProps {
  queryEngine: QueryEngine;
  provider: string;
  model: string;
  maxTurns: number;
}

function AppOpenCode({ queryEngine, provider, model, maxTurns }: AppOpenCodeProps) {
  // Create event bus and keybinding manager (stable across renders)
  const eventBus = useMemo(() => new UIEventBus(), []);
  const keybindingManager = useMemo(() => createDefaultKeybindings(), []);

  // Streaming state from the event bus
  const {
    messages,
    thinkingChains,
    sidebarData,
    isStreaming,
    errors,
    totalTokensUsed,
    addMessage,
    setMessages,
  } = useStreamingEvents(eventBus);

  // Input state
  const [inputState, setInputState] = useState<InputState>(createInputState());
  const [turnCount, setTurnCount] = useState(0);
  const [sessionStartTime] = useState(() => Date.now());
  const [mode, setMode] = useState<'idle' | 'streaming' | 'overlay' | 'steer'>('idle');
  const [attachmentState, setAttachmentState] = useState<{
    attachments: Array<{ path: string; name: string }>;
    deleteMode: boolean;
  }>({ attachments: [], deleteMode: false });
  const [agentMode, setAgentMode] = useState<'build' | 'plan'>('build');

  // Exit confirmation state
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const exitConfirmHandledRef = useRef(false);

  // Error dismissal
  const [dismissedErrors, setDismissedErrors] = useState<Set<number>>(new Set());
  const dismissError = useCallback((index: number) => {
    setDismissedErrors((prev) => new Set(prev).add(index));
  }, []);

  // Active errors (not dismissed)
  const activeErrors = errors.filter((_, i) => !dismissedErrors.has(i));

  // Get session ID from global state
  const sessionId = getState().sessionId;

  // Slash command handler
  const handleSlashCommand = useCallback(async (command: string) => {
    const parts = command.split(' ');
    const cmd = normalizeSlashCommand(parts[0]!.toLowerCase());

    const addSystemMsg = (content: string) => {
      addMessage({
        id: `system-${Date.now()}`,
        role: 'system',
        content,
        timestamp: Date.now(),
      });
    };

    switch (cmd) {
      case '/help':
        addSystemMsg(
          'Commands:\n' +
          '  /help          - Show help\n' +
          '  /key <api-key> - Set API key\n' +
          '  /clear         - Clear conversation\n' +
          '  /mode <mode>   - Set permission mode (default|acceptEdits|plan|bypassPermissions)\n' +
          '  /tools         - List tools\n' +
          '  /level [level] - Show/set user level (beginner|intermediate|advanced)\n' +
          '  /status        - Show status\n' +
          '  /exit          - Exit',
        );
        break;

      case '/key': {
        const key = parts[1];
        if (key) {
          queryEngine.setApiKey(key);
          addSystemMsg('API key updated.');
        } else {
          addSystemMsg('Usage: /key <api-key>');
        }
        break;
      }

      case '/clear':
        setMessages(() => []);
        queryEngine.clear();
        addSystemMsg('Conversation cleared.');
        break;

      case '/mode': {
        const mode = parts[1];
        if (mode) {
          updateState({ permissionMode: mode as PermissionMode });
          addSystemMsg(`Permission mode set to: ${mode}`);
        } else {
          addSystemMsg(`Current mode: ${getState().permissionMode}`);
        }
        break;
      }

      case '/tools': {
        const tools = toolRegistry.getAllTools();
        const lines = tools.map((t) => {
          const ro = t.isReadOnly ? ' [read-only]' : '';
          return `  - ${t.name}${ro}`;
        });
        addSystemMsg(`Tools:\n${lines.join('\n')}`);
        break;
      }

      case '/status': {
        const state = getState();
        const profileService = new UserProfileService();
        await profileService.load();
        addSystemMsg(
          `CWD: ${state.cwd}\n` +
          `Mode: ${state.permissionMode}\n` +
          `Level: ${profileService.getLevel()}\n` +
          `Session: ${state.sessionId}`,
        );
        break;
      }

      case '/level': {
        const profileService = new UserProfileService();
        await profileService.load();
        const levelArg = parts[1];
        if (levelArg && ['beginner', 'intermediate', 'advanced'].includes(levelArg)) {
          profileService.updateLevel(levelArg as UserLevel);
          await profileService.persist();
          addSystemMsg(`Level set to: ${levelArg}`);
        } else {
          addSystemMsg(`Current level: ${profileService.getLevel()}\nUsage: /level beginner|intermediate|advanced`);
        }
        break;
      }

      case '/exit':
        process.exit(0);
        break;

      default:
        addSystemMsg(`Unknown command: ${cmd}. Type /help to see the list of available commands.`);
    }
  }, [queryEngine, addMessage, setMessages]);

  const submitMessage = useCallback(async (text: string) => {
    addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    const assistantId = `assistant-${Date.now()}`;
    addMessage({
      id: assistantId,
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
      toolCalls: [],
    });

    setMode('streaming');
    setTurnCount((prev) => prev + 1);

    try {
      for await (const event of queryEngine.submitMessage(text)) {
        eventBus.emit(event);
      }
    } catch (error) {
      const errMsg = `Error: ${getErrorMessage(error)}`;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: errMsg } : m,
        ),
      );
    } finally {
      setMode('idle');
    }
  }, [queryEngine, eventBus, addMessage]);

  // Keyboard input handling via Ink's useInput
  useInput((input: string, key: any) => {
    // When exit confirmation is showing, block all other input
    if (showExitConfirm) {
      exitConfirmHandledRef.current = true;
      if (input === 'y' || input === 'Y') {
        setShowExitConfirm(false);
        process.exit(0);
      }
      if (key.escape || input === 'n' || input === 'N') {
        setShowExitConfirm(false);
      }
      return;
    }

    if (isStreaming) {
      if (key.ctrl && input === 'x') {
        // Cancel
        setMode('idle');
      }
      return;
    }

    // Global hotkeys
    if (key.ctrl && input === 'k') {
      // Command palette — not yet wired in skeleton
      return;
    }
    if (key.ctrl && input === 'l') {
      // Clear
      setMessages(() => []);
      return;
    }
    if (key.ctrl && input === 'i') {
      setInputState((prev) => toggleSteerMode(prev));
      setMode((m) => (m === 'steer' ? 'idle' : 'steer'));
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      // Exit with confirmation if there's an active session
      if (messages.length > 0) {
        setShowExitConfirm(true);
      } else {
        process.exit(0);
      }
      return;
    }
    if (key.ctrl && input === 'e') {
      // External editor
      openExternalEditor(inputState.text).then((result) => {
        if (result !== null) {
          setInputState((prev) => ({ ...prev, text: result, cursorPos: result.length }));
        }
      });
      return;
    }
    if (key.ctrl && input === 'r') {
      // Toggle delete attachment mode
      setAttachmentState((prev) => ({ ...prev, deleteMode: !prev.deleteMode }));
      return;
    }
    if (key.ctrl && input === 'n') {
      // New session
      setMessages(() => []);
      setTurnCount(0);
      setInputState(createInputState());
      return;
    }
    if (key.tab) {
      // Toggle build/plan mode
      setAgentMode((prev) => (prev === 'build' ? 'plan' : 'build'));
      return;
    }

    // Dismiss error bar on Escape
    if (key.escape && activeErrors.length > 0) {
      dismissError(errors.length - 1);
      return;
    }

    // Delete attachment mode
    if (attachmentState.deleteMode && input >= '0' && input <= '9') {
      const idx = parseInt(input, 10);
      if (input === 'r' || input === 'R') {
        setAttachmentState({ attachments: [], deleteMode: false });
        return;
      }
      setAttachmentState((prev) => ({
        attachments: prev.attachments.filter((_, i) => i !== idx),
        deleteMode: prev.attachments.length > 1,
      }));
      return;
    }

    // Escape to exit delete mode or cancel
    if (key.escape) {
      if (attachmentState.deleteMode) {
        setAttachmentState((prev) => ({ ...prev, deleteMode: false }));
        return;
      }
      return;
    }

    // @ file autocomplete trigger
    if (input === '@') {
      setInputState((prev) => insertChar(prev, '@'));
      // Autocomplete will be triggered in Phase 6
      return;
    }

    // Text input — check Shift+Enter before plain Enter
    if (key.return && key.shift) {
      setInputState((prev) => insertNewline(prev));
      return;
    }

    if (key.return) {
      // \ at end of line = multi-line continuation
      if (inputState.text.endsWith('\\')) {
        setInputState((prev) => insertNewline(prev));
        return;
      }
      const text = inputState.text.trim();
      if (text.startsWith('/')) {
        setInputState(createInputState());
        handleSlashCommand(text);
        return;
      }
      if (text) {
        setInputState(createInputState());
        submitMessage(text);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInputState((prev) => deleteBefore(prev));
      return;
    }

    if (key.leftArrow) {
      setInputState((prev) => moveCursorLeft(prev));
      return;
    }

    if (key.rightArrow) {
      setInputState((prev) => moveCursorRight(prev));
      return;
    }

    if (key.upArrow) {
      // History — not wired yet
      return;
    }

    if (key.downArrow) {
      return;
    }

    // Ctrl shortcuts
    if (key.ctrl && input === 'a') {
      setInputState((prev) => moveToLineStart(prev));
      return;
    }
    if (key.ctrl && input === 'w') {
      setInputState((prev) => deleteWordBefore(prev));
      return;
    }
    if (key.ctrl && input === 'u') {
      setInputState((prev) => deleteToLineStart(prev));
      return;
    }

    // Printable character (single char or multi-character IME-composed text,
    // e.g. a committed Chinese phrase like "你好"). Reject control characters.
    if (!key.ctrl && !key.meta && isPrintableUnicode(input)) {
      setInputState((prev) => insertChar(prev, input));
    }
  });

  const sessionDuration = Date.now() - sessionStartTime;

  const hasError = activeErrors.length > 0;

  return (
    <Box flexDirection="column" width="100%">
      {hasError && (
        <ErrorBar errors={activeErrors} onDismiss={dismissError} />
      )}
      <Layout
        headerBar={<HeaderBar provider={provider} model={model} agentMode={agentMode} />}
        chatPanel={
        <ChatPanel
          messages={messages}
          thinkingChains={thinkingChains}
          isModalOpen={showExitConfirm}
        />
      }
      editor={
        <Editor
          text={inputState.text}
          cursorPos={inputState.cursorPos}
          isSteerMode={inputState.steerMode}
          attachments={attachmentState.attachments}
          deleteMode={attachmentState.deleteMode}
        />
      }
      sessionInfo={
        <SessionInfo
          provider={provider}
          model={model}
          sessionId={sessionId}
          tokensUsed={totalTokensUsed}
          tokensMax={200000}
          duration={sessionDuration}
        />
      }
      sidebar={<SidebarPlaceholder />}
      statusBar={
        <StatusBar
          mode={mode}
          provider={provider}
          model={model}
          turnCount={turnCount}
          maxTurns={maxTurns}
          tokensUsed={totalTokensUsed}
        />
      }
      overlay={
        showExitConfirm ? <ExitConfirmDialog
          onConfirm={() => { setShowExitConfirm(false); process.exit(0); }}
          onCancel={() => setShowExitConfirm(false)}
        /> : null
      }
    />
    </Box>
  );
}

// ── Root ──

interface AppRootProps {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  themeName?: string;
}

export function AppRoot({ queryEngine, provider, model, maxTurns, themeName }: AppRootProps) {
  return (
    <ThemeProvider initialTheme={themeName || DEFAULT_THEME}>
      <AppOpenCode
        queryEngine={queryEngine}
        provider={provider || 'unknown'}
        model={model || 'unknown'}
        maxTurns={maxTurns || 50}
      />
    </ThemeProvider>
  );
}
