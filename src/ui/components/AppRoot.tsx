import React, { useMemo, useState, useCallback, useEffect } from 'react';
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
import { SidebarPanel } from './SidebarPanel';
import { PermissionDialog, type PermissionRequest, type PermissionDecision } from './PermissionDialog';
import { CommandPalette, type CommandItem } from './CommandPalette';
import { FilePicker } from '../dialogs/FilePicker';
import { UIEventBus } from '../event-bus';
import { createDefaultKeybindings } from '../keybinding-manager';
import { isPrintableUnicode, type KeypressEvent } from '../keypress';
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
import type { PermissionMode, UIPermissionRequest } from '../../permissions/protocol';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

const MAX_ATTACHMENTS = 5;

// ── Error Bar ──

interface ErrorBarProps {
  errors: string[];
  onDismiss: (index: number) => void;
}

function ErrorBar({ errors }: ErrorBarProps) {
  const { colors } = useTheme();
  if (errors.length === 0) return null;

  // Show the most recent error
  const latest = errors[errors.length - 1];

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor={colors.error}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <Text color={colors.error}>⚠ Error: </Text>
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
  const { colors } = useTheme();
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
      borderColor={colors.border}
      padding={1}
      backgroundColor={colors.background}
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

// ── Main App ──

interface AppOpenCodeProps {
  queryEngine: QueryEngine;
  provider: string;
  model: string;
  maxTurns: number;
}

/** Normalize an Ink (input, key) pair into a KeypressEvent for the resolver. */
function toKeypressEvent(input: string, key: any): KeypressEvent {
  let name: string;
  if (key.upArrow) name = 'up';
  else if (key.downArrow) name = 'down';
  else if (key.leftArrow) name = 'left';
  else if (key.rightArrow) name = 'right';
  else if (key.escape) name = 'escape';
  else if (key.return) name = 'return';
  else if (key.tab) name = 'tab';
  else if (key.backspace) name = 'backspace';
  else if (key.delete) name = 'delete';
  else name = input;
  return { name, ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift };
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
  const [sidebarHidden, setSidebarHidden] = useState(false);

  // Overlay state
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  // Input history (↑/↓ recall of previously submitted messages)
  const [submittedHistory, setSubmittedHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // Error dismissal
  const [dismissedErrors, setDismissedErrors] = useState<Set<number>>(new Set());
  const dismissError = useCallback((index: number) => {
    setDismissedErrors((prev) => new Set(prev).add(index));
  }, []);

  // Active errors (not dismissed)
  const activeErrors = errors.filter((_, i) => !dismissedErrors.has(i));

  // Get session ID from global state
  const sessionId = getState().sessionId;

  const overlayOpen = permissionRequest !== null || showExitConfirm || showPalette || showFilePicker;

  // Register the interactive authorization handler with the engine. The
  // returned Promise resolves when the user decides; PermissionDialog.onDecide
  // guarantees a resolution on every path (Esc → 'deny') so the awaiting
  // executor generator can never deadlock.
  useEffect(() => {
    queryEngine.setPermissionRequestHandler((req: UIPermissionRequest) =>
      new Promise<PermissionDecision>((resolve) => {
        setPermissionRequest({
          toolName: req.toolName,
          inputSummary: req.inputSummary,
          diffs: req.diffs,
          onDecide: (decision) => {
            resolve(decision);
            setPermissionRequest(null);
          },
        });
      }),
    );
    return () => queryEngine.setPermissionRequestHandler(null);
  }, [queryEngine]);

  // Keep the keybinding resolver's context in sync with UI state so `when`
  // clauses (idle/input/streaming/overlay/delete-mode) resolve correctly.
  useEffect(() => {
    const km = keybindingManager;
    (['idle', 'input', 'streaming', 'overlay', 'delete-mode'] as const).forEach((c) => km.clearContext(c));
    if (isStreaming) km.setContext('streaming');
    if (overlayOpen) km.setContext('overlay');
    if (attachmentState.deleteMode) km.setContext('delete-mode');
    if (!isStreaming && !overlayOpen) {
      km.setContext('idle');
      km.setContext('input');
    }
  }, [keybindingManager, isStreaming, overlayOpen, attachmentState.deleteMode]);

  const addSystemMsg = useCallback((content: string) => {
    addMessage({
      id: `system-${Date.now()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    });
  }, [addMessage]);

  // Slash command handler
  const handleSlashCommand = useCallback(async (command: string) => {
    const parts = command.split(' ');
    const cmd = normalizeSlashCommand(parts[0]!.toLowerCase());

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
          '  /exit          - Exit\n' +
          '\nKeys:\n' + keybindingManager.getHelpText(),
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
        const modeArg = parts[1];
        if (modeArg) {
          updateState({ permissionMode: modeArg as PermissionMode });
          addSystemMsg(`Permission mode set to: ${modeArg}`);
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
  }, [queryEngine, addSystemMsg, setMessages, keybindingManager]);

  const submitMessage = useCallback(async (text: string) => {
    // Record for ↑/↓ history recall.
    setSubmittedHistory((prev) => [...prev, text]);
    setHistoryIndex(null);

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
  }, [queryEngine, eventBus, addMessage, setMessages]);

  const startNewSession = useCallback(() => {
    setMessages(() => []);
    setTurnCount(0);
    setInputState(createInputState());
    setHistoryIndex(null);
  }, [setMessages]);

  const requestExit = useCallback(() => {
    if (messages.length > 0) setShowExitConfirm(true);
    else process.exit(0);
  }, [messages.length]);

  const openFilePicker = useCallback(async () => {
    try {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const cwd = getState().cwd;
      const entries = await fsp.readdir(cwd, { withFileTypes: true });
      const items: FileItem[] = entries
        .map((e) => ({
          name: e.name,
          path: path.join(cwd, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
      setFileItems(items);
      setShowFilePicker(true);
    } catch {
      addSystemMsg('Could not read the current directory for the file picker.');
    }
  }, [addSystemMsg]);

  const onFileSelect = useCallback((filePath: string) => {
    setAttachmentState((prev) => {
      if (prev.attachments.length >= MAX_ATTACHMENTS) return prev;
      if (prev.attachments.some((a) => a.path === filePath)) return prev;
      const name = filePath.split(/[\\/]/).pop() || filePath;
      return { ...prev, attachments: [...prev.attachments, { path: filePath, name }] };
    });
    setShowFilePicker(false);
  }, []);

  const historyPrev = useCallback(() => {
    setSubmittedHistory((hist) => {
      if (hist.length === 0) return hist;
      setHistoryIndex((idx) => {
        const next = idx === null ? hist.length - 1 : Math.max(0, idx - 1);
        const text = hist[next] ?? '';
        setInputState((prev) => ({ ...prev, text, cursorPos: text.length }));
        return next;
      });
      return hist;
    });
  }, []);

  const historyNext = useCallback(() => {
    setSubmittedHistory((hist) => {
      setHistoryIndex((idx) => {
        if (idx === null) return null;
        const next = idx + 1;
        if (next >= hist.length) {
          setInputState((prev) => ({ ...prev, text: '', cursorPos: 0 }));
          return null;
        }
        const text = hist[next] ?? '';
        setInputState((prev) => ({ ...prev, text, cursorPos: text.length }));
        return next;
      });
      return hist;
    });
  }, []);

  // Command palette entries: slash commands + UI actions.
  const paletteCommands = useMemo<CommandItem[]>(() => [
    { id: 'help', label: '/help — Show help', keywords: '帮助', run: () => handleSlashCommand('/help') },
    { id: 'clear', label: '/clear — Clear conversation', keywords: '清空 清除', run: () => handleSlashCommand('/clear') },
    { id: 'mode', label: '/mode — Show permission mode', keywords: '模式 permission', run: () => handleSlashCommand('/mode') },
    { id: 'tools', label: '/tools — List tools', keywords: '工具', run: () => handleSlashCommand('/tools') },
    { id: 'status', label: '/status — Show status', keywords: '状态', run: () => handleSlashCommand('/status') },
    { id: 'level', label: '/level — User level', keywords: '级别', run: () => handleSlashCommand('/level') },
    { id: 'exit', label: '/exit — Exit', keywords: '退出 quit', run: () => handleSlashCommand('/exit') },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', keywords: 'sidebar panel', run: () => setSidebarHidden((h) => !h) },
    { id: 'file-picker', label: 'File Picker', keywords: 'attach file', run: () => { void openFilePicker(); } },
    { id: 'new-session', label: 'New Session', keywords: 'reset', run: startNewSession },
  ], [handleSlashCommand, openFilePicker, startNewSession]);

  // Dispatch a resolved keybinding command. Returns true when consumed.
  const dispatchCommand = useCallback((command: string): boolean => {
    switch (command) {
      case 'palette': setShowPalette(true); return true;
      case 'newSession': startNewSession(); return true;
      case 'clear': setMessages(() => []); return true;
      case 'externalEditor':
        openExternalEditor(inputState.text).then((result) => {
          if (result !== null) {
            setInputState((prev) => ({ ...prev, text: result, cursorPos: result.length }));
          }
        });
        return true;
      case 'filePicker': void openFilePicker(); return true;
      case 'deleteAttachment':
        setAttachmentState((prev) => ({ ...prev, deleteMode: !prev.deleteMode }));
        return true;
      case 'steer':
        setInputState((prev) => toggleSteerMode(prev));
        setMode((m) => (m === 'steer' ? 'idle' : 'steer'));
        return true;
      case 'cancel': setMode('idle'); return true;
      case 'quit':
      case 'exit': requestExit(); return true;
      case 'toggleSidebar': setSidebarHidden((h) => !h); return true;
      case 'toggleAgentMode': setAgentMode((prev) => (prev === 'build' ? 'plan' : 'build')); return true;
      case 'help': addSystemMsg('Keys:\n' + keybindingManager.getHelpText()); return true;
      case 'historyPrev': historyPrev(); return true;
      case 'historyNext': historyNext(); return true;
      case 'cancelMode':
        setAttachmentState((prev) => ({ ...prev, deleteMode: false }));
        return true;
      case 'closeOverlay':
      case 'autocomplete':
        return true;
      default:
        return false;
    }
  }, [startNewSession, setMessages, inputState.text, openFilePicker, requestExit, addSystemMsg, keybindingManager, historyPrev, historyNext]);

  // Keyboard input handling via Ink's useInput.
  useInput((input: string, key: any) => {
    // Overlays own their input; block background handling while one is open.
    if (overlayOpen) return;

    const event = toKeypressEvent(input, key);

    // Consult the keybinding resolver for control/navigation keys only, so
    // plain printable characters are always inserted as text (no double path).
    const isControlKey = key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow;
    if (isControlKey) {
      const command = keybindingManager.resolve(event);
      if (command && dispatchCommand(command)) return;

      if (key.escape) {
        // No binding matched: dismiss the newest active error, if any.
        const lastActive = errors
          .map((_, i) => i)
          .filter((i) => !dismissedErrors.has(i))
          .pop();
        if (lastActive !== undefined) dismissError(lastActive);
        return;
      }
      // Named navigation keys without a binding are swallowed (never text).
      if (key.tab || key.upArrow || key.downArrow) return;
      // Unresolved Ctrl combos fall through to the editing shortcuts below.
    }

    // ── Delete-attachment mode ──
    if (attachmentState.deleteMode) {
      if (input === 'r' || input === 'R') {
        setAttachmentState({ attachments: [], deleteMode: false });
        return;
      }
      if (input >= '0' && input <= '9') {
        const idx = parseInt(input, 10);
        setAttachmentState((prev) => ({
          attachments: prev.attachments.filter((_, i) => i !== idx),
          deleteMode: prev.attachments.length > 1,
        }));
        return;
      }
    }

    // @ opens the file picker to attach a file.
    if (input === '@') {
      void openFilePicker();
      return;
    }

    // Text input — check Shift+Enter before plain Enter.
    if (key.return && key.shift) {
      setInputState((prev) => insertNewline(prev));
      return;
    }

    if (key.return) {
      // \ at end of line = multi-line continuation.
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

    // Editing Ctrl shortcuts (not part of the keybinding schema).
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
    <Layout
      sidebarHidden={sidebarHidden}
      headerBar={<HeaderBar provider={provider} model={model} agentMode={agentMode} />}
      errorBar={
        hasError ? <ErrorBar errors={activeErrors} onDismiss={dismissError} /> : null
      }
      chatPanel={
        <ChatPanel
          messages={messages}
          thinkingChains={thinkingChains}
          isModalOpen={overlayOpen}
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
          sessionId={sessionId}
          tokensUsed={totalTokensUsed}
          tokensMax={200000}
          duration={sessionDuration}
        />
      }
      sidebar={<SidebarPanel data={sidebarData} />}
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
        permissionRequest ? (
          <PermissionDialog request={permissionRequest} />
        ) : showPalette ? (
          <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />
        ) : showFilePicker ? (
          <FilePicker files={fileItems} onSelect={onFileSelect} onCancel={() => setShowFilePicker(false)} />
        ) : showExitConfirm ? (
          <ExitConfirmDialog
            onConfirm={() => { setShowExitConfirm(false); process.exit(0); }}
            onCancel={() => setShowExitConfirm(false)}
          />
        ) : null
      }
    />
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
