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
import { SidebarPanel } from './SidebarPanel';
import { PermissionDialog, type PermissionRequest, type PermissionDecision } from './PermissionDialog';
import { OperationSummary, synthesizeOperation, operationsFromTools } from './OperationSummary';
import { CommandPalette, type CommandItem } from './CommandPalette';
import { FilePicker } from '../dialogs/FilePicker';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { getBreakpoint } from '../layout';
import { UIEventBus } from '../event-bus';
import { createDefaultKeybindings } from '../keybinding-manager';
import { getCapabilities } from '../../api/capabilities';
import { isPrintableUnicode, type KeypressEvent } from '../keypress';
import { FocusStack, ESCAPE_HELP_LINE, type FocusLayer } from '../focus-stack';
import { FocusStackProvider, FocusLayerMount, useFocusLayer } from '../hooks/useFocusLayer';
import type { ChatScrollHandle } from './ChatMessagesView.js';
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
import { SessionManager } from '../../services/sessionManager';
import { FileMemoryService } from '../../memory/FileMemoryService';
import { engineMessagesToUiMessages } from '../session-mapper';
import type { AgentState } from '../../state/types';

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

  // Show the most recent error. The bar owns its own height bound: one
  // truncated message row inside the border, so its natural height is fixed
  // and Yoga can measure it (no reserved slot in layout.ts).
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
      <Text wrap="truncate-end">{latest}</Text>
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
  // Modal focus layer: Y confirms, N cancels, everything else is swallowed;
  // ESC cancels via the stack's unified escape semantics.
  useFocusLayer({
    id: 'exit-confirm',
    onKey: (event: KeypressEvent) => {
      if (event.name === 'y' || event.name === 'Y') onConfirm();
      else if (event.name === 'n' || event.name === 'N') onCancel();
      return true;
    },
    onEscape: () => {
      onCancel();
      return true;
    },
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

/** Normalize an Ink (input, key) pair into a KeypressEvent for the focus stack. */
function toKeypressEvent(input: string, key: any): KeypressEvent {
  let name: string;
  let printable = false;
  if (key.upArrow) name = 'up';
  else if (key.downArrow) name = 'down';
  else if (key.leftArrow) name = 'left';
  else if (key.rightArrow) name = 'right';
  else if (key.escape) name = 'escape';
  else if (key.return) name = 'return';
  else if (key.tab) name = 'tab';
  else if (key.backspace) name = 'backspace';
  else if (key.delete) name = 'delete';
  else {
    name = input;
    // Printable text (single char or IME-composed string) — named keys above
    // never qualify, so consumers can trust this flag for text insertion.
    printable = !key.ctrl && !key.meta && isPrintableUnicode(input);
  }
  return { name, ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift, isPrintable: printable };
}

function AppOpenCode({ queryEngine, provider, model: initialModel, maxTurns }: AppOpenCodeProps) {
  // Create event bus and keybinding manager (stable across renders)
  const eventBus = useMemo(() => new UIEventBus(), []);
  const keybindingManager = useMemo(() => createDefaultKeybindings(), []);

  // The single input arbiter: exactly one layer (stack top) owns the keyboard.
  const focusStack = useMemo(() => new FocusStack(), []);
  // Imperative chat scroll handle so the editor base layer can dispatch ↑/↓
  // scrolling without ChatView owning its own useInput.
  const chatScrollRef = useRef<ChatScrollHandle | null>(null);

  // The active model is promotable at runtime via /model, so it lives in state
  // (seeded from the prop) and drives the header/status bars after a switch.
  const [model, setModel] = useState(initialModel);

  // Session persistence + history switching (/session). SessionManager wraps the
  // filesystem-backed memory service; the service is initialized lazily on first
  // use (see ensureSessionInit) so startup stays cheap.
  const memoryService = useMemo(() => new FileMemoryService(), []);
  const sessionManager = useMemo(() => new SessionManager(memoryService), [memoryService]);
  const sessionInitRef = useRef(false);

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
  // Ticks once per second so the session duration timer advances live rather
  // than only re-rendering when other state changes (which froze the clock).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [mode, setMode] = useState<'idle' | 'streaming' | 'overlay' | 'steer'>('idle');
  const [attachmentState, setAttachmentState] = useState<{
    attachments: Array<{ path: string; name: string }>;
    deleteMode: boolean;
  }>({ attachments: [], deleteMode: false });
  const [agentMode, setAgentMode] = useState<'build' | 'plan'>('build');
  const [sidebarHidden, setSidebarHidden] = useState(false);

  // Execution automation level, orthogonal to agentMode (build/plan): the
  // "work mode" (build/plan) is what the agent does; executionMode is how much
  // it does autonomously. A ref mirrors it so the stable permission-handler
  // closure always reads the latest value.
  const [executionMode, setExecutionMode] = useState<'interactive' | 'auto' | 'goal'>('interactive');
  const executionModeRef = useRef<'interactive' | 'auto' | 'goal'>('interactive');
  const [goalState, setGoalState] = useState<{
    goal: string;
    iteration: number;
    maxIterations: number;
    active: boolean;
  } | null>(null);
  const goalCancelledRef = useRef(false);

  // Overlay state
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  // Ctrl+O expands the pending permission request into a full DiffPreview overlay.
  const [showDiffDetail, setShowDiffDetail] = useState(false);

  // Status bar mode is derived live: any open overlay reports 'overlay' so the
  // bar tracks what actually owns the screen, not just the base interaction mode.
  const overlayOpen =
    showExitConfirm || showPalette || showFilePicker || showDiffDetail || permissionRequest !== null;
  const statusMode: 'idle' | 'streaming' | 'overlay' | 'steer' = overlayOpen ? 'overlay' : mode;

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

  // Session ID lives in state so /session new|<id> can swap it and re-render.
  const [sessionId, setSessionId] = useState(() => getState().sessionId);

  // Register the interactive authorization handler with the engine. The
  // returned Promise resolves when the user decides; PermissionDialog.onDecide
  // guarantees a resolution on every path (Esc → 'deny') so the awaiting
  // executor generator can never deadlock.
  useEffect(() => {
    queryEngine.setPermissionRequestHandler((req: UIPermissionRequest) =>
      new Promise<PermissionDecision>((resolve) => {
        // Auto/Goal modes execute autonomously: approve without prompting so the
        // engine loop is never blocked waiting on the UI. The tool still shows
        // up in the live operation summary / sidebar as it runs.
        if (executionModeRef.current !== 'interactive') {
          resolve('allow');
          return;
        }
        setPermissionRequest({
          toolName: req.toolName,
          inputSummary: req.inputSummary,
          diffs: req.diffs,
          onDecide: (decision) => {
            resolve(decision);
            setPermissionRequest(null);
            setShowDiffDetail(false);
          },
        });
      }),
    );
    return () => queryEngine.setPermissionRequestHandler(null);
  }, [queryEngine]);

  // Advance the session clock once per second so SessionInfo's duration timer
  // updates live instead of freezing until the next unrelated re-render.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const addSystemMsg = useCallback((content: string) => {
    addMessage({
      id: `system-${Date.now()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    });
  }, [addMessage]);

  // Switch the execution automation level. Auto/Goal route tool authorization
  // through the classifier (permissionMode 'auto') and auto-approve in the UI;
  // Interactive restores the default ask-based confirmation flow.
  const applyExecutionMode = useCallback((next: 'interactive' | 'auto' | 'goal') => {
    executionModeRef.current = next;
    setExecutionMode(next);
    updateState({ permissionMode: next === 'interactive' ? 'default' : 'auto' });
  }, []);

  // Lazily create the ~/.kc-cli/sessions directory the first time we touch it.
  const ensureSessionInit = useCallback(async () => {
    if (sessionInitRef.current) return;
    await memoryService.initialize();
    sessionInitRef.current = true;
  }, [memoryService]);

  // Persist the current conversation to disk (best-effort). Called after each
  // completed turn so an interrupted session can be resumed via /session.
  const saveCurrentSession = useCallback(async () => {
    const engineMessages = queryEngine.getMessages();
    if (engineMessages.length === 0) return; // never write an empty session
    try {
      await ensureSessionInit();
      const toolsUsed = Array.from(new Set((sidebarData.tools ?? []).map((t) => t.name)));
      // saveSession only reads cwd/model/provider/turnCount/totalTokensUsed/
      // createdAt off the state, so construct just those fields.
      const stateSnapshot = {
        cwd: getState().cwd,
        model,
        provider,
        turnCount,
        totalTokensUsed,
        createdAt: sessionStartTime,
      } as unknown as AgentState;
      await sessionManager.saveSession(getState().sessionId, engineMessages, stateSnapshot, toolsUsed);
    } catch {
      // Persistence is best-effort; a save failure must never break the session.
    }
  }, [queryEngine, sessionManager, ensureSessionInit, sidebarData.tools, model, provider, turnCount, totalTokensUsed, sessionStartTime]);

  // Run one engine invocation: add the user + assistant messages, stream the
  // events onto the bus, and return the assistant's accumulated text so callers
  // (notably the goal loop) can inspect the outcome.
  const runEngineTurn = useCallback(async (text: string): Promise<string> => {
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

    let assistantText = '';
    try {
      for await (const event of queryEngine.submitMessage(text)) {
        eventBus.emit(event);
        const anyEv = event as { type?: string; text?: unknown };
        if (typeof anyEv.text === 'string' && String(anyEv.type).includes('text_delta')) {
          assistantText += anyEv.text;
        }
      }
    } catch (error) {
      const errMsg = `Error: ${getErrorMessage(error)}`;
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: errMsg } : m)),
      );
    } finally {
      setMode('idle');
      void saveCurrentSession();
    }
    return assistantText;
  }, [queryEngine, eventBus, addMessage, setMessages, saveCurrentSession]);

  // Goal mode: iterate the engine toward a high-level goal until the model
  // signals GOAL_ACHIEVED, the iteration cap is hit, or the user cancels (Esc).
  const runGoal = useCallback(async (goal: string) => {
    const maxIterations = 10;
    goalCancelledRef.current = false;
    setGoalState({ goal, iteration: 0, maxIterations, active: true });
    setSubmittedHistory((prev) => [...prev, goal]);
    setHistoryIndex(null);
    addSystemMsg(
      `[Goal mode] Working toward: ${goal}\n` +
      `Iterating up to ${maxIterations} times or until GOAL_ACHIEVED. Press Esc to stop.`,
    );

    let prompt =
      `Goal: ${goal}\n\n` +
      `Work autonomously toward this goal. When it is fully achieved, reply with the ` +
      `token GOAL_ACHIEVED on its own line. Otherwise keep making concrete progress.`;

    let achieved = false;
    for (let i = 0; i < maxIterations; i++) {
      if (goalCancelledRef.current) break;
      setGoalState((g) => (g ? { ...g, iteration: i + 1 } : g));
      const text = await runEngineTurn(prompt);
      if (/\bGOAL_ACHIEVED\b/.test(text)) {
        achieved = true;
        break;
      }
      prompt =
        `The goal is not yet complete: ${goal}\n` +
        `Continue working toward it. Reply GOAL_ACHIEVED when fully done.`;
    }

    setGoalState((g) => (g ? { ...g, active: false } : g));
    if (goalCancelledRef.current) {
      addSystemMsg('[Goal mode] Stopped by user.');
    } else if (achieved) {
      addSystemMsg('[Goal mode] Goal achieved.');
    } else {
      addSystemMsg(`[Goal mode] Reached iteration limit (${maxIterations}) without GOAL_ACHIEVED.`);
    }
  }, [runEngineTurn, addSystemMsg]);

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
          '  /model [name]  - Show or switch the active model\n' +
          '  /session [id]  - List sessions, load one, or /session new\n' +
          '  /mode <mode>   - Set permission mode (default|acceptEdits|plan|bypassPermissions)\n' +
          '  /auto          - Autonomous mode (run tools without confirmation)\n' +
          '  /goal <text>   - Goal mode (iterate autonomously toward a goal)\n' +
          '  /interactive   - Interactive mode (confirm each operation)\n' +
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
          const validationError = queryEngine.setApiKey(key);
          if (validationError) {
            addSystemMsg(`Invalid API key: ${validationError}`);
          } else {
            addSystemMsg('API key updated.');
          }
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
          // isReadOnly is an input-dependent predicate function, not a boolean.
          let readOnly = false;
          try {
            readOnly = t.isReadOnly?.({} as any) === true;
          } catch {
            readOnly = false;
          }
          const ro = readOnly ? ' [read-only]' : '';
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

      case '/auto':
        applyExecutionMode('auto');
        addSystemMsg('Execution mode: auto — tools run without confirmation.');
        break;

      case '/interactive':
        applyExecutionMode('interactive');
        addSystemMsg('Execution mode: interactive — you confirm each operation.');
        break;

      case '/goal': {
        const goal = parts.slice(1).join(' ').trim();
        applyExecutionMode('goal');
        if (goal) {
          void runGoal(goal);
        } else {
          addSystemMsg('Usage: /goal <objective> — describe what to accomplish, then it runs autonomously.');
        }
        break;
      }

      case '/model': {
        const name = parts.slice(1).join(' ').trim();
        if (name) {
          const applied = queryEngine.setModel(name);
          setModel(applied);
          addSystemMsg(`Model switched to: ${applied}`);
        } else {
          addSystemMsg(`Current model: ${model}\nUsage: /model <name>`);
        }
        break;
      }

      case '/session': {
        const sub = (parts[1] || 'list').trim();
        if (sub === 'list') {
          await ensureSessionInit();
          const sessions = await sessionManager.listRecentSessions(10);
          if (sessions.length === 0) {
            addSystemMsg('No saved sessions yet.');
          } else {
            const lines = sessions.map((s) => {
              const when = new Date(s.metadata.lastModified).toLocaleString();
              return `  ${s.sessionId}  \u00b7  ${when}  \u00b7  ${s.messages.length} msg(s)`;
            });
            addSystemMsg(
              `Recent sessions:\n${lines.join('\n')}\n\n` +
              'Use /session <id> to load, or /session new to start fresh.',
            );
          }
        } else if (sub === 'new') {
          const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          queryEngine.clear();
          setMessages(() => []);
          setTurnCount(0);
          setHistoryIndex(null);
          updateState({ sessionId: newId });
          setSessionId(newId);
          addSystemMsg(`Started new session: ${newId}`);
        } else {
          await ensureSessionInit();
          const loaded = await sessionManager.loadSession(sub);
          if (!loaded) {
            addSystemMsg(`Session not found: ${sub}`);
            break;
          }
          try {
            const restoredTurnCount = queryEngine.restoreSession(loaded);
            setMessages(() => engineMessagesToUiMessages(loaded.messages));
            setTurnCount(restoredTurnCount);
            if (loaded.state.model) setModel(loaded.state.model);
            updateState({ sessionId: sub });
            setSessionId(sub);
            setHistoryIndex(null);
            addSystemMsg(`Loaded session: ${sub} (${loaded.messages.length} message(s)).`);
          } catch (err) {
            addSystemMsg(`Failed to restore session: ${err instanceof Error ? err.message : err}. Current session unchanged.`);
          }
        }
        break;
      }

      case '/exit':
        process.exit(0);
        break;

      default:
        addSystemMsg(`Unknown command: ${cmd}. Type /help to see the list of available commands.`);
    }
  }, [queryEngine, addSystemMsg, setMessages, keybindingManager, applyExecutionMode, runGoal, model, sessionManager, ensureSessionInit]);

  const submitMessage = useCallback(async (text: string) => {
    // Record for ↑/↓ history recall.
    setSubmittedHistory((prev) => [...prev, text]);
    setHistoryIndex(null);
    await runEngineTurn(text);
  }, [runEngineTurn]);

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
    { id: 'auto-mode', label: 'Auto Mode — autonomous execution', keywords: 'auto 自动', run: () => handleSlashCommand('/auto') },
    { id: 'goal-mode', label: 'Goal Mode — set a goal', keywords: 'goal 目标', run: () => handleSlashCommand('/goal') },
    { id: 'interactive-mode', label: 'Interactive Mode — confirm operations', keywords: 'interactive 交互', run: () => handleSlashCommand('/interactive') },
    { id: 'tools', label: '/tools — List tools', keywords: '工具', run: () => handleSlashCommand('/tools') },
    { id: 'status', label: '/status — Show status', keywords: '状态', run: () => handleSlashCommand('/status') },
    { id: 'level', label: '/level — User level', keywords: '级别', run: () => handleSlashCommand('/level') },
    { id: 'model', label: '/model — Show/switch model', keywords: 'model 模型', run: () => handleSlashCommand('/model') },
    { id: 'session', label: '/session — List/switch sessions', keywords: 'session 会话', run: () => handleSlashCommand('/session') },
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
      case 'cancel':
        if (goalState?.active) goalCancelledRef.current = true;
        setMode('idle');
        return true;
      case 'quit':
      case 'exit': requestExit(); return true;
      case 'toggleSidebar': setSidebarHidden((h) => !h); return true;
      case 'toggleAgentMode': setAgentMode((prev) => (prev === 'build' ? 'plan' : 'build')); return true;
      case 'cycleExecutionMode': {
        const order = ['interactive', 'auto', 'goal'] as const;
        const idx = order.indexOf(executionModeRef.current);
        const next = order[(idx + 1) % order.length]!;
        applyExecutionMode(next);
        addSystemMsg(
          next === 'goal'
            ? 'Execution mode: goal — type your goal and press Enter.'
            : next === 'auto'
              ? 'Execution mode: auto — tools run without confirmation.'
              : 'Execution mode: interactive — you confirm each operation.',
        );
        return true;
      }
      case 'help': addSystemMsg('Keys:\n' + keybindingManager.getHelpText() + '\n' + ESCAPE_HELP_LINE); return true;
      case 'historyPrev': historyPrev(); return true;
      case 'historyNext': historyNext(); return true;
      // closeOverlay/cancelMode/autocomplete cases removed with their schema
      // bindings: ESC lives in the focus stack, and tab is swallowed by the
      // editor base layer without needing a fake command.
      default:
        return false;
    }
  }, [startNewSession, setMessages, inputState.text, openFilePicker, requestExit, addSystemMsg, keybindingManager, historyPrev, historyNext, applyExecutionMode, goalState]);

  // ── Editor base layer ──
  // Handles everything a key can do when no overlay/mode owns the keyboard:
  // keybinding commands, delete-attachment mode, @-attach, Enter submission,
  // cursor movement, editing shortcuts, and printable insertion.
  const handleEditorKey = useCallback((event: KeypressEvent): boolean => {
    // Derive the resolver's `when` contexts synchronously at dispatch time
    // (the old useEffect sync lagged a render behind — F3). This runs only on
    // the editor path, and the focus stack guarantees no overlay layer is on
    // top of it here, so overlay-style contexts are structurally impossible.
    const km = keybindingManager;
    (['idle', 'input', 'streaming'] as const).forEach((c) => km.clearContext(c));
    if (isStreaming) {
      km.setContext('streaming');
    } else {
      km.setContext('idle');
      km.setContext('input');
    }

    // ↑/↓ scroll the chat and recall input history (both effects fired
    // historically via parallel useInput handlers; preserved on one path).
    if (!event.ctrl && !event.meta && (event.name === 'up' || event.name === 'down')) {
      if (event.name === 'up') chatScrollRef.current?.scrollUp();
      else chatScrollRef.current?.scrollDown();
      const command = keybindingManager.resolve(event);
      if (command) dispatchCommand(command);
      return true;
    }

    // Consult the keybinding resolver for control/navigation keys only, so
    // plain printable characters are always inserted as text (no double path).
    if (event.ctrl || event.meta || event.name === 'tab') {
      const command = keybindingManager.resolve(event);
      if (command && dispatchCommand(command)) return true;
      // Tab without a binding is swallowed (never text).
      if (event.name === 'tab') return true;
      // Unresolved Ctrl combos fall through to the editing shortcuts below.
    }

    // ── Delete-attachment mode ──
    if (attachmentState.deleteMode) {
      if (event.name === 'r' || event.name === 'R') {
        setAttachmentState({ attachments: [], deleteMode: false });
        return true;
      }
      if (event.name.length === 1 && event.name >= '0' && event.name <= '9') {
        const idx = parseInt(event.name, 10);
        setAttachmentState((prev) => ({
          attachments: prev.attachments.filter((_, i) => i !== idx),
          deleteMode: prev.attachments.length > 1,
        }));
        return true;
      }
    }

    // @ opens the file picker to attach a file.
    if (event.name === '@') {
      void openFilePicker();
      return true;
    }

    // Text input — check Shift+Enter before plain Enter.
    if (event.name === 'return' && event.shift) {
      setInputState((prev) => insertNewline(prev));
      return true;
    }

    if (event.name === 'return') {
      // \ at end of line = multi-line continuation.
      if (inputState.text.endsWith('\\')) {
        setInputState((prev) => insertNewline(prev));
        return true;
      }
      const text = inputState.text.trim();
      if (text.startsWith('/')) {
        setInputState(createInputState());
        handleSlashCommand(text);
        return true;
      }
      if (text) {
        setInputState(createInputState());
        if (executionModeRef.current === 'goal' && !goalState?.active) {
          void runGoal(text);
        } else {
          submitMessage(text);
        }
      }
      return true;
    }

    if (event.name === 'backspace' || event.name === 'delete') {
      setInputState((prev) => deleteBefore(prev));
      return true;
    }

    if (event.name === 'left') {
      setInputState((prev) => moveCursorLeft(prev));
      return true;
    }

    if (event.name === 'right') {
      setInputState((prev) => moveCursorRight(prev));
      return true;
    }

    // Editing Ctrl shortcuts (not part of the keybinding schema).
    if (event.ctrl && event.name === 'a') {
      setInputState((prev) => moveToLineStart(prev));
      return true;
    }
    if (event.ctrl && event.name === 'w') {
      setInputState((prev) => deleteWordBefore(prev));
      return true;
    }
    if (event.ctrl && event.name === 'u') {
      setInputState((prev) => deleteToLineStart(prev));
      return true;
    }

    // Printable character (single char or multi-character IME-composed text,
    // e.g. a committed Chinese phrase like "你好"). Reject control characters.
    if (event.isPrintable) {
      setInputState((prev) => insertChar(prev, event.name));
      return true;
    }
    return false;
  }, [keybindingManager, isStreaming, dispatchCommand, attachmentState.deleteMode, openFilePicker, inputState.text, handleSlashCommand, runGoal, submitMessage, goalState]);

  // ── Focus layers ──
  // Plain objects rebuilt each render; FocusLayerMount proxies them through a
  // ref, so stack order stays stable while handlers never go stale.

  // Always-mounted base layer. ESC only leaves delete-attachment mode; the
  // base itself never closes on ESC.
  const editorLayer: FocusLayer = {
    id: 'editor',
    onKey: handleEditorKey,
    onEscape: () => {
      if (attachmentState.deleteMode) {
        setAttachmentState((prev) => ({ ...prev, deleteMode: false }));
        return true;
      }
      return false;
    },
  };

  // Error layer: ESC dismisses the newest active error; typing still reaches
  // the editor. Mounted only when no higher-priority mode is active so the
  // historical ESC priority (permission > goal > error) is preserved.
  const errorLayer: FocusLayer = {
    id: 'error',
    onKey: handleEditorKey,
    onEscape: () => {
      const lastActive = errors
        .map((_, i) => i)
        .filter((i) => !dismissedErrors.has(i))
        .pop();
      if (lastActive !== undefined) dismissError(lastActive);
      return true;
    },
  };

  // Goal layer: ESC requests cancellation after the current step; typing
  // still reaches the editor while the goal loop runs.
  const goalLayer: FocusLayer = {
    id: 'goal',
    onKey: handleEditorKey,
    onEscape: () => {
      goalCancelledRef.current = true;
      addSystemMsg('[Goal mode] Stopping after the current step...');
      return true;
    },
  };

  // Permission layer: the inline confirmation owns the keyboard while a
  // request is pending. Enter=allow, A=always, ESC=deny, Ctrl+O expands the
  // diff; everything else is swallowed so keystrokes never leak into the
  // editor mid-decision. onDispose guarantees the executor's Promise resolves
  // (deny) even if the layer is torn down without a decision.
  const permissionLayer: FocusLayer = {
    id: 'permission',
    onKey: (event) => {
      if (!permissionRequest) return true;
      if (event.ctrl && (event.name === 'o' || event.name === 'O')) {
        if (permissionRequest.diffs && permissionRequest.diffs.length > 0) setShowDiffDetail(true);
        return true;
      }
      if (event.name === 'return') { permissionRequest.onDecide('allow'); return true; }
      if (event.name === 'a' || event.name === 'A') { permissionRequest.onDecide('allow_always'); return true; }
      return true;
    },
    onEscape: () => {
      permissionRequest?.onDecide('deny');
      return true;
    },
    onDispose: () => {
      // Safe even after a normal decision: resolving twice is a no-op.
      permissionRequest?.onDecide('deny');
    },
  };

  // The single top-level useInput: normalize the key and let the focus stack
  // route it to the one layer that currently owns the keyboard.
  useInput((input: string, key: any) => {
    focusStack.handleKey(toKeypressEvent(input, key));
  });

  const sessionDuration = nowTick - sessionStartTime;
  const hasError = activeErrors.length > 0;

  // Token ceiling for the session gauge: the active provider/model's real
  // context window instead of a hardcoded constant.
  const tokensMax = useMemo(
    () => getCapabilities(provider, model).maxContextWindow,
    [provider, model],
  );

  // Operation summary strip above the editor. Interactive mode shows the
  // pending tool as a confirm affordance; auto/goal show what is running live
  // (auto-approved, no confirmation). Steps/expected collapse on compact widths.
  const { width: termWidth } = useTerminalSize();
  const operationCompact = getBreakpoint(termWidth).density === 'compact';
  const operationSummaryNode = useMemo(() => {
    if (permissionRequest && executionMode === 'interactive') {
      const op = synthesizeOperation(
        permissionRequest.toolName,
        permissionRequest.inputSummary,
        permissionRequest.diffs,
      );
      return <OperationSummary operations={[op]} mode="confirm" compact={operationCompact} />;
    }
    if (executionMode !== 'interactive') {
      const ops = operationsFromTools(sidebarData.tools ?? []);
      if (ops.length > 0) {
        return <OperationSummary operations={ops} mode="live" compact={operationCompact} autoApproved />;
      }
    }
    return null;
  }, [permissionRequest, executionMode, sidebarData.tools, operationCompact]);

  // Status-bar live fields: the most recent running tool and overall progress.
  // Progress is iteration-based while a goal is active, otherwise turn-based.
  const currentOperation = useMemo(() => {
    const running = (sidebarData.tools ?? []).filter((t) => t.status === 'running');
    return running.length > 0 ? running[running.length - 1]!.name : undefined;
  }, [sidebarData.tools]);
  const progressPercent = goalState?.active
    ? (goalState.iteration / Math.max(1, goalState.maxIterations)) * 100
    : (turnCount / Math.max(1, maxTurns)) * 100;

  return (
    <FocusStackProvider value={focusStack}>
      {/* Focus layers (bottom → top): sibling order defines stack order for
          layers mounted in the same commit; later state-driven mounts push on
          top. Overlay layers register from within their own components. */}
      <FocusLayerMount layer={editorLayer} />
      {activeErrors.length > 0 && !goalState?.active && !permissionRequest && (
        <FocusLayerMount layer={errorLayer} />
      )}
      {goalState?.active && <FocusLayerMount layer={goalLayer} />}
      {permissionRequest && <FocusLayerMount layer={permissionLayer} />}
      <Layout
        sidebarHidden={sidebarHidden}
        headerBar={<HeaderBar provider={provider} model={model} agentMode={agentMode} executionMode={executionMode} />}
        errorBar={
          hasError ? <ErrorBar errors={activeErrors} onDismiss={dismissError} /> : null
        }
        operationSummary={operationSummaryNode}
        chatPanel={
          <ChatPanel
            messages={messages}
            thinkingChains={thinkingChains}
            scrollRef={chatScrollRef}
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
            tokensMax={tokensMax}
            duration={sessionDuration}
          />
        }
        sidebar={<SidebarPanel data={sidebarData} />}
        statusBar={
          <StatusBar
            mode={statusMode}
            provider={provider}
            model={model}
            turnCount={turnCount}
            maxTurns={maxTurns}
            tokensUsed={totalTokensUsed}
            currentOperation={currentOperation}
            progressPercent={progressPercent}
          />
        }
        overlay={
          showDiffDetail && permissionRequest ? (
            <PermissionDialog request={permissionRequest} onClose={() => setShowDiffDetail(false)} />
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
    </FocusStackProvider>
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
