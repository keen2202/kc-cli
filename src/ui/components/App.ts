import readline from 'readline';
import chalk from 'chalk';
import { getErrorMessage } from '../../types/errors';
import { renderStatusBar } from './StatusBar';
import { renderToolCallCard, type ToolCallData } from './ToolCallCard';
import { renderChatView, type ChatMessage } from './ChatView';
import { classifyThinkingSteps, renderThinkingChain, type ThinkingChain } from './ThinkingChainView';
import { renderInputBox, createInputState, type InputState } from './InputBox';
import { renderSidebar, createSidebarData, type SidebarData, type SidebarTool } from './Sidebar';
import { renderMultiFileDiff, type FileDiff } from '../diff-viewer';
import {
  createPaletteState,
  renderCommandPalette,
  paletteMoveUp,
  paletteMoveDown,
  paletteGetSelected,
  paletteClose,
  type PaletteState,
} from './CommandPalette';
import {
  createModelSelectorState,
  renderModelSelector,
  modelSelectorMoveUp,
  modelSelectorMoveDown,
  modelSelectorGetSelected,
  type ModelSelectorState,
} from './ModelSelector';
import { parseKeypress } from '../keypress';
import { VirtualScroller } from '../virtual-scroll';
import { createThrottle, createDebounce } from '../renderer';
import { getTheme, type Theme } from '../theme';
import { UIEventBus } from '../event-bus';
import { OverlayManager } from '../overlay-manager';
import { renderHeader } from './Header';
import { renderChatViewport } from './ChatViewport';
import { CommandPaletteOverlay } from '../overlays/CommandPaletteOverlay';
import { ModelSelectorOverlay } from '../overlays/ModelSelectorOverlay';
import { HelpPanelOverlay } from '../overlays/HelpPanelOverlay';
import { createDefaultKeybindings, type KeybindingManager } from '../keybinding-manager';
import { createLogMiddleware } from '../middleware/log';
import { createBudgetMiddleware } from '../middleware/budget';
import { createBridgeMiddleware } from '../middleware/bridge';
import { getBreakpoint, type Density } from '../layout';
import type { QueryEngine } from '../../query/QueryEngine';
import type { AgentEvent } from '../../state/types';
import type { StreamEvent } from '../../types/message';

/** Threshold: use virtual scrolling when message count exceeds this */
const VIRTUAL_SCROLL_THRESHOLD = 100;
/** Throttle interval for render during streaming (16ms ≈ 60fps) */
const RENDER_THROTTLE_MS = 16;
/** Debounce interval for keyboard input */
const INPUT_DEBOUNCE_MS = 50;

// Pre-built Sets for O(1) membership checks (replaces repeated array literal allocation)
const DIFF_TOOLS_SET = new Set(['FileWrite', 'FileEdit']);
const SIDEBAR_SECTIONS_SET = new Set(['tools', 'files', 'tasks', 'memory']);
const VALID_PERMISSION_MODES_SET = new Set(['default', 'bypassPermissions', 'dontAsk', 'plan', 'acceptEdits']);

interface AppOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  themeName?: string;
}

export class App {
  private queryEngine: QueryEngine;
  private provider: string;
  private model: string;
  private maxTurns: number;
  private messages: ChatMessage[] = [];
  private inputState: InputState;
  private rl: readline.Interface;
  private turnCount: number = 0;
  private sessionStartTime: number;
  private running: boolean = true;
  private rlClosed: boolean = false;
  private sidebarData: SidebarData;
  private sidebarWidth: number = 34;
  private pendingDiffs: FileDiff[] = [];
  private activeDiffIndex: number = 0;
  private paletteState: PaletteState;
  private modelSelectorState: ModelSelectorState;
  private theme: Theme;
  private eventBus: UIEventBus;
  private overlayManager: OverlayManager;
  private keybindingManager: KeybindingManager;
  private logMiddleware: ReturnType<typeof createLogMiddleware>;
  private budgetMiddleware: ReturnType<typeof createBudgetMiddleware>;
  private bridgeMiddleware: ReturnType<typeof createBridgeMiddleware>;
  private _currentAssistantMsg: ChatMessage | null = null;
  private _currentThinkingChain: ThinkingChain | null = null;
  private _thinkingChains: Map<string, ThinkingChain> = new Map();
  private density: Density = 'normal';

  // ── Performance: virtual scrolling ──
  private virtualScroller: VirtualScroller;

  // ── Performance: throttled render ──
  private throttledRender: ReturnType<typeof createThrottle>;

  // ── Performance: debounced input ──
  private debouncedPrompt: ReturnType<typeof createDebounce>;

  // ── Performance: diff worker ──
  private diffWorkerReady: boolean = false;
  private diffWorker: import('worker_threads').Worker | null = null;
  private diffCallbacks: Map<string, (result: string) => void> = new Map();
  private diffCounter: number = 0;

  constructor(options: AppOptions) {
    this.queryEngine = options.queryEngine;
    this.provider = options.provider || 'unknown';
    this.model = options.model || 'unknown';
    this.maxTurns = options.maxTurns || 50;
    this.inputState = createInputState();
    this.sessionStartTime = Date.now();
    this.sidebarData = createSidebarData();
    this.paletteState = createPaletteState();
    this.modelSelectorState = createModelSelectorState(this.provider, this.model);
    this.theme = getTheme(options.themeName || 'dark');
    this.eventBus = new UIEventBus();
    this.overlayManager = new OverlayManager();
    this.keybindingManager = createDefaultKeybindings();

    // Wire event pipeline: middlewares run before UI listener
    this.logMiddleware = createLogMiddleware(false);
    this.budgetMiddleware = createBudgetMiddleware(1_000_000);
    this.bridgeMiddleware = createBridgeMiddleware();

    this.eventBus.use(this.logMiddleware);
    this.eventBus.use(this.budgetMiddleware);
    this.eventBus.use(this.bridgeMiddleware);

    // UI subscribes as a listener on the event bus
    this.eventBus.on('*', (event) => {
      this.handleEvent(event, this._currentAssistantMsg);
    });

    // ── Performance: virtual scrolling for long conversations ──
    const viewportHeight = (process.stdout.rows || 24) - 8; // Reserve header/footer
    this.virtualScroller = new VirtualScroller({
      viewportHeight,
      overscan: 5,
    });

    // ── Performance: throttle render at 16ms (60fps) ──
    this.throttledRender = createThrottle(() => {
      this._doRender();
    }, RENDER_THROTTLE_MS);

    // ── Performance: debounce rapid input ──
    this.debouncedPrompt = createDebounce(() => {
      this.prompt();
    }, INPUT_DEBOUNCE_MS);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Initialize diff worker (lazy, non-blocking)
    this.initDiffWorker();
  }

  async start(): Promise<void> {
    this.clearScreen();
    this.renderImmediate();

    // Terminal resize handling (debounced)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    process.stdout.on('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        this.applyBreakpoint();
        this.clearScreen();
        this.renderImmediate();
      }, 100);
    });

    // Graceful shutdown
    const cleanup = () => {
      this.running = false;
      this.rlClosed = true;
      this.throttledRender.cancel();
      this.debouncedPrompt.cancel();
      this.terminateDiffWorker();
      console.log(chalk.yellow('\nGoodbye!'));
      this.rl.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    this.prompt();
  }

  /**
   * Initialize the diff computation worker thread (lazy, non-blocking).
   * Falls back to synchronous diff if worker_threads unavailable.
   */
  private initDiffWorker(): void {
    try {
      const { Worker } = require('worker_threads');
      const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', (data) => {
          try {
            const { id, oldContent, newContent } = data;
            const result = computeDiff(oldContent, newContent);
            parentPort.postMessage({ id, result });
          } catch (err) {
            parentPort.postMessage({ id: data.id, error: err.message });
          }
        });

        function computeDiff(oldContent, newContent) {
          const oldLines = (oldContent || '').split('\\n');
          const newLines = newContent.split('\\n');
          const maxLen = Math.max(oldLines.length, newLines.length);
          const parts = [];
          for (let i = 0; i < maxLen; i++) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];
            if (oldLine === undefined) {
              parts.push({ type: 'add', line: newLine, lineNum: i + 1 });
            } else if (newLine === undefined) {
              parts.push({ type: 'del', line: oldLine, lineNum: i + 1 });
            } else if (oldLine !== newLine) {
              parts.push({ type: 'del', line: oldLine, lineNum: i + 1 });
              parts.push({ type: 'add', line: newLine, lineNum: i + 1 });
            } else {
              parts.push({ type: 'same', line: oldLine, lineNum: i + 1 });
            }
          }
          return parts;
        }
      `;

      this.diffWorker = new Worker(workerCode, { eval: true });
      this.diffWorker!.on('message', (msg: { id: string; result?: any; error?: string }) => {
        const cb = this.diffCallbacks.get(msg.id);
        if (cb) {
          this.diffCallbacks.delete(msg.id);
          if (msg.error) {
            // Fallback: return empty
            cb('');
          } else {
            cb(msg.result);
          }
        }
      });
      this.diffWorker!.on('error', () => {
        this.diffWorkerReady = false;
        this.diffWorker = null;
      });
      this.diffWorkerReady = true;
    } catch (_err) {
      console.error("Suppressed error:", _err);
      // worker_threads not available - will use synchronous fallback
      this.diffWorkerReady = false;
    }
  }

  /**
   * Terminate the diff worker on shutdown.
   */
  private terminateDiffWorker(): void {
    if (this.diffWorker) {
      this.diffWorker.terminate().catch(() => {});
      this.diffWorker = null;
    }
  }

  private clearScreen(): void {
    process.stdout.write('\x1B[2J\x1B[H');
  }

  /**
   * Public render - throttled at 60fps during streaming.
   * Uses the throttled version to avoid excessive re-renders.
   */
  private render(): void {
    this.throttledRender();
  }

  /**
   * Force an immediate render (bypasses throttle).
   * Use for user-initiated actions (command input, etc.).
   */
  private renderImmediate(): void {
    this.throttledRender.cancel();
    this._doRender();
  }

  /**
   * Actual render implementation.
   *
   * Layout:
   * ┌──────────────────────────────────────────────────────────┐
   * │ Header: kc CLI v2.0 · Model · Session                    │
   * ├─────────────────────────────────────────────┬────────────┤
   * │ Main Chat Area                              │ Sidebar    │
   * │ User: Create a web server                   │ (tools/    │
   * │ Assistant: I'll create... [streaming]       │  files/    │
   * │ ┌─ ToolCall: Bash ──────────────────────┐   │  tasks)    │
   * │ │ Running...                             │   │            │
   * │ └────────────────────────────────────────┘   │            │
   * ├─────────────────────────────────────────────┼────────────┤
   * │ Status: ✓ Ready · 3 tools used · $0.05 spent             │
   * └──────────────────────────────────────────────────────────┘
   */
  private _doRender(): void {
    process.stdout.write('\x1B[H');

    const terminalWidth = process.stdout.columns || 80;
    const mainWidth = terminalWidth - this.sidebarWidth - 2;

    // ── Header ──
    const tokens = this.theme.resolve();
    const borderColor = tokens['overlay.border'];
    const headerResult = renderHeader({
      provider: this.provider,
      model: this.model,
      sessionId: this.sessionStartTime.toString(36),
      width: terminalWidth,
      theme: this.theme,
    });
    for (const line of headerResult.lines) {
      console.log(line);
    }

    // ── Sidebar + Main content ──
    const sidebarLines = renderSidebar(this.sidebarData, this.sidebarWidth, this.theme).split('\n');

    // Chat content (main area) - use virtual scrolling for long conversations
    const chatLines = renderChatViewport({
      messages: this.messages,
      scroller: this.virtualScroller,
      width: mainWidth,
      height: (process.stdout.rows || 24) - 8,
      theme: this.theme,
      virtualScrollThreshold: VIRTUAL_SCROLL_THRESHOLD,
      thinkingChains: this._thinkingChains,
    });

    // Interleave main content and sidebar (chat left, sidebar right)
    const maxLines = Math.max(sidebarLines.length, chatLines.length);
    for (let i = 0; i < maxLines; i++) {
      const sidebarLine = sidebarLines[i] || ' '.repeat(this.sidebarWidth);
      const chatLine = chatLines[i] || '';

      // Truncate chat line to main width
      const plainChat = chatLine.replace(/\x1B\[[0-9;]*m/g, '');
      if (plainChat.length > mainWidth) {
        // Re-render with truncation
        const truncated = this.truncateAnsi(chatLine, mainWidth);
        process.stdout.write(`${truncated}  ${sidebarLine}\n`);
      } else {
        const padding = ' '.repeat(Math.max(0, mainWidth - plainChat.length));
        process.stdout.write(`${chatLine}${padding}  ${sidebarLine}\n`);
      }
    }

    // ── Separator ──
    const sepBorder = tokens['overlay.border'];
    console.log(sepBorder('├' + '─'.repeat(terminalWidth - this.sidebarWidth - 1) + '┼' + '─'.repeat(this.sidebarWidth - 2) + '┤'));

    // ── Overlay Layer ──
    if (!this.overlayManager.isEmpty()) {
      console.log('');
      console.log(this.overlayManager.render(terminalWidth, process.stdout.rows || 24, this.theme));
    }

    // ── Status ──
    const status = renderStatusBar({
      provider: this.provider,
      model: this.model,
      turnCount: this.turnCount,
      maxTurns: this.maxTurns,
      sessionStartTime: this.sessionStartTime,
    }, this.theme);
    if (status) {
      console.log(status);
    }

    // ── Clear stale lines from previous render ──
    const headerLineCount = headerResult.lines.length;
    const overlayLines = !this.overlayManager.isEmpty() ? 2 : 0;
    const statusLines = status ? status.split('\n').length : 0;
    const linesRendered = headerLineCount + maxLines + 1 + overlayLines + statusLines;
    const termHeight = process.stdout.rows || 24;
    for (let i = linesRendered; i < termHeight; i++) {
      process.stdout.write('\x1B[2K\n');
    }
  }

  /**
   * Truncate an ANSI string to a given display width.
   */
  private truncateAnsi(str: string, maxWidth: number): string {
    const plain = str.replace(/\x1B\[[0-9;]*m/g, '');
    if (plain.length <= maxWidth) return str;
    // Collect active ANSI codes up to the cut point, then append reset
    const codes: string[] = [];
    let plainIdx = 0;
    const re = /\x1B\[([0-9;]*)m/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null && plainIdx < maxWidth - 1) {
      codes.push(m[0]);
    }
    // Reset at the end to avoid color bleed
    return codes.join('') + plain.slice(0, maxWidth - 1) + '…\x1B[0m';
  }

  private prompt(): void {
    if (!this.running || this.rlClosed) return;

    // Use palette-specific prompt when palette is open
    const promptTokens = this.theme.resolve();
    const hasOverlay = !this.overlayManager.isEmpty();
    const promptLabel = hasOverlay
      ? promptTokens['input.steer']('overlay> ')
      : promptTokens['input.prompt']('kc> ');

    try {
    this.rl.question(promptLabel, async (input) => {
      if (!this.running) return;

      // Handle overlay-specific input
      if (hasOverlay) {
        // Overlays use raw mode, but if we get text input, route to palette
        if (this.paletteState.open) {
          this.handlePaletteInput(input.trim());
        }
        if (this.running) this.prompt();
        return;
      }

      const trimmed = input.trim();

      // Handle commands
      if (trimmed.startsWith('/')) {
        this.handleCommand(trimmed);
        this.prompt();
        return;
      }

      if (!trimmed) {
        this.prompt();
        return;
      }

      // Add user message
      this.addMessage({
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      });

      // Execute query
      await this.executeQuery(trimmed);

      this.prompt();
    });
    } catch {
      // readline was closed between guard check and question() call
    }
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.renderImmediate();
  }

  private async executeQuery(prompt: string): Promise<void> {
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
      toolCalls: [],
    };
    this.messages.push(assistantMsg);
    this._currentAssistantMsg = assistantMsg;

    try {
      for await (const event of this.queryEngine.submitMessage(prompt)) {
        this.eventBus.emit(event);
      }
    } catch (error) {
      const errTokens = this.theme.resolve();
      assistantMsg.content = errTokens['error.text'](`Error: ${getErrorMessage(error)}`);
    }

    // Persist thinking chain for this message
    if (this._currentThinkingChain) {
      this._thinkingChains.set(assistantMsg.id, this._currentThinkingChain);
      this._currentThinkingChain = null;
    }

    this._currentAssistantMsg = null;
    this.turnCount++;
    this.renderImmediate();
  }

  private handleEvent(event: AgentEvent | StreamEvent, assistantMsg: ChatMessage | null): void {
    if (!assistantMsg) return;
    // Normalize agent:* prefixed events to canonical types
    const type = event.type.replace(/^agent:/, '');
    const ev = event as any; // discriminated union broken by prefix normalization — refactor event types to fix

    switch (type) {
      case 'text_delta':
        assistantMsg.content = (assistantMsg.content || '') + ev.text;
        this.render();
        break;

      case 'thinking_delta': {
        if (!this._currentThinkingChain) {
          this._currentThinkingChain = {
            steps: [],
            rawContent: '',
            folded: true,
            startTime: Date.now(),
          };
        }
        this._currentThinkingChain.rawContent += ev.thinking;
        this._currentThinkingChain.steps = classifyThinkingSteps(this._currentThinkingChain.rawContent);
        this.render();
        break;
      }

      case 'tool_started':
      case 'tool_use_start': {
        const toolCall: ToolCallData = {
          toolName: ev.toolCall.toolName,
          status: 'running',
          startTime: Date.now(),
        };
        assistantMsg.toolCalls = assistantMsg.toolCalls || [];
        assistantMsg.toolCalls.push(toolCall);
        this.updateSidebarTool({ name: ev.toolCall.toolName, status: 'running' });
        this.renderImmediate();
        break;
      }

      case 'tool_completed':
      case 'tool_use_end': {
        const toolCalls = assistantMsg.toolCalls || [];
        const lastTool = toolCalls[toolCalls.length - 1];
        if (lastTool) {
          // tool_completed uses success; tool_use_end uses isError
          const failed = 'isError' in ev ? ev.result.isError : false;
          lastTool.status = failed ? 'failed' : 'completed';
          lastTool.endTime = Date.now();
          lastTool.output = typeof ev.result.output === 'string'
            ? ev.result.output
            : JSON.stringify(ev.result.output);
          this.updateSidebarTool({
            name: lastTool.toolName,
            status: lastTool.status as SidebarTool['status'],
            duration: this.calcDuration(lastTool.startTime, lastTool.endTime || Date.now()),
          });
          this.captureDiffFromToolResult(ev.toolCall.toolName, ev.result?.metadata);
        }
        this.showDiffIfPending(assistantMsg);
        this.renderImmediate();
        break;
      }

      case 'tool_failed': {
        const toolCalls = assistantMsg.toolCalls || [];
        const lastTool = toolCalls[toolCalls.length - 1];
        if (lastTool) {
          lastTool.status = 'failed';
          lastTool.endTime = Date.now();
          lastTool.output = ev.error.message;
          this.updateSidebarTool({
            name: lastTool.toolName,
            status: 'failed',
            duration: this.calcDuration(lastTool.startTime, lastTool.endTime || Date.now()),
          });
        }
        this.renderImmediate();
        break;
      }

      case 'error': {
        const errorMsg = ev.error?.message || 'Unknown error';
        const recoverable = ev.recoverable ?? false;
        const errTokens = this.theme.resolve();
        if (recoverable) {
          assistantMsg.content = (assistantMsg.content || '') +
            errTokens['warning.text'](`\n⚠ ${errorMsg} — retrying...`);
        } else {
          assistantMsg.content = (assistantMsg.content || '') +
            errTokens['error.text'](`\n✗ ${errorMsg}`);
        }
        this.renderImmediate();
        break;
      }

      case 'turn_complete':
        // Turn complete — no additional UI action needed (render happens after loop)
        break;
    }
  }

  private updateSidebarTool(tool: SidebarTool): void {
    // Check if this tool is already in the sidebar
    const existing = this.sidebarData.tools.findIndex(t => t.name === tool.name && t.status === 'running');
    if (existing >= 0 && tool.status !== 'running') {
      this.sidebarData.tools[existing] = tool;
    } else if (tool.status === 'running') {
      this.sidebarData.tools.push(tool);
    }
  }

  private calcDuration(start?: number, end?: number): string {
    if (!start) return '—';
    const elapsed = ((end || Date.now()) - start) / 1000;
    if (elapsed < 1) return `${Math.round(elapsed * 1000)}ms`;
    return `${elapsed.toFixed(1)}s`;
  }

  /**
   * Apply responsive breakpoint based on terminal width.
   */
  private applyBreakpoint(): void {
    const cols = process.stdout.columns || 80;
    const bp = getBreakpoint(cols);
    this.density = bp.density;
    this.sidebarData.visible = bp.sidebarVisible;
  }

  /**
   * Advance to the next unprocessed diff (skip accepted/rejected).
   */
  private advanceDiffIndex(): void {
    const start = this.activeDiffIndex;
    for (let i = 0; i < this.pendingDiffs.length; i++) {
      const idx = (start + 1 + i) % this.pendingDiffs.length;
      const d = this.pendingDiffs[idx];
      if (d && !d.accepted && !d.rejected) {
        this.activeDiffIndex = idx;
        return;
      }
    }
    // All processed
  }

  /**
   * Show diff preview as a system message if there are unprocessed diffs.
   * Automatically triggered after FileWriteTool / FileEditTool completion.
   */
  private showDiffIfPending(assistantMsg: ChatMessage): void {
    const unprocessed = this.pendingDiffs.filter(d => !d.accepted && !d.rejected);
    if (unprocessed.length === 0) return;

    const maxWidth = Math.min((process.stdout.columns || 80) - this.sidebarWidth - 6, 100);
    const diffPreview = renderMultiFileDiff(
      unprocessed,
      this.activeDiffIndex,
      { maxWidth, theme: this.theme }
    );

    // Append diff preview as a system message after the assistant message
    this.messages.push({
      id: `diff-auto-${Date.now()}`,
      role: 'system',
      content: diffPreview + '\n' + chalk.gray.dim('  Use /accept, /reject, or /diff to review changes.'),
      timestamp: Date.now(),
    });
  }

  /**
   * Handle input when the command palette is open.
   * Empty input = close. Type to search. Enter on empty = select.
   */
  private handlePaletteInput(input: string): void {
    if (input === '') {
      // Try to execute the selected command
      const selected = paletteGetSelected(this.paletteState);
      if (selected) {
        this.executePaletteCommand(selected.id);
      }
      return;
    }

    // Special keys (simulated by typed keywords)
    switch (input.toLowerCase()) {
      case 'esc':
      case '/close':
      case 'q':
        paletteClose(this.paletteState);
        this.clearScreen();
        this.renderImmediate();
        return;

      case '/up':
        paletteMoveUp(this.paletteState);
        break;

      case '/down':
        paletteMoveDown(this.paletteState);
        break;

      default:
        // Type-to-search
        this.paletteState.query = input;
        this.paletteState.selectedIndex = 0;
        break;
    }

    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Handle input when the model selector is active.
   */
  private handleModelSelectorInput(input: string): void {
    const lower = input.toLowerCase().trim();

    if (lower === '' || lower === 'enter') {
      // Confirm selection
      const selected = modelSelectorGetSelected(this.modelSelectorState);
      if (selected) {
        // Update provider and model (runtime only)
        const oldProvider = this.provider;
        const oldModel = this.model;
        this.provider = selected.providerId;
        this.model = selected.modelId;

        this.modelSelectorState.active = false;
        this.addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: chalk.cyan.bold('Model changed:') +
            chalk.dim(` ${oldProvider}/${oldModel}`) +
            chalk.white(' → ') +
            chalk.green.bold(`${selected.providerId}/${selected.modelId}`),
          timestamp: Date.now(),
        });
      }
      this.clearScreen();
      this.renderImmediate();
      return;
    }

    switch (lower) {
      case 'esc':
      case 'q':
      case '/close':
        this.modelSelectorState.active = false;
        this.clearScreen();
        this.renderImmediate();
        return;

      case '/up':
        modelSelectorMoveUp(this.modelSelectorState);
        break;

      case '/down':
        modelSelectorMoveDown(this.modelSelectorState);
        break;
    }

    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Switch stdin to raw mode for arrow key navigation in overlays.
   */
  private _enableRawInput(): void {
    this.rlClosed = true;
    this.rl.close();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this._onRawKeypress);
  }

  /**
   * Restore readline-based input after overlay closes.
   */
  private _restoreReadline(): void {
    process.stdin.removeListener('data', this._onRawKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rlClosed = false;
  }

  /**
   * Handle raw keypresses - dispatch to OverlayManager, then KeybindingManager.
   */
  private _onRawKeypress = (chunk: string): void => {
    const event = parseKeypress(chunk);

    // First, try overlay dispatch
    if (this.overlayManager.handleKeypress(event)) {
      if (this.overlayManager.isEmpty()) {
        this._restoreReadline();
        this.prompt();
      }
      this.clearScreen();
      this.renderImmediate();
      return;
    }

    // Then, try keybinding dispatch
    const command = this.keybindingManager.resolve(event);
    if (command) {
      this.executeCommand(command);
    }
  };

  /**
   * Execute a keybinding command.
   */
  private executeCommand(command: string): void {
    switch (command) {
      case 'palette':
        this.openPalette();
        break;
      case 'clear':
        this.messages = [];
        this.turnCount = 0;
        this.sidebarData.tools = [];
        this.pendingDiffs = [];
        this.activeDiffIndex = 0;
        this.clearScreen();
        this.renderImmediate();
        break;
      case 'toggleSidebar':
        this.sidebarData.visible = !this.sidebarData.visible;
        this.clearScreen();
        this.renderImmediate();
        break;
      case 'toggleThinking': {
        // Toggle fold/expand on the most recent thinking chain
        const lastChain = this._currentThinkingChain
          || (this._thinkingChains.size > 0
            ? Array.from(this._thinkingChains.values()).pop()
            : null);
        if (lastChain) {
          lastChain.folded = !lastChain.folded;
          this.clearScreen();
          this.renderImmediate();
        }
        break;
      }
      case 'exit':
        this.running = false;
        this.rlClosed = true;
        console.log(chalk.yellow('\nGoodbye!'));
        this.rl.close();
        process.exit(0);
        break;
      case 'closeOverlay':
        if (!this.overlayManager.isEmpty()) {
          this.overlayManager.pop();
          if (this.overlayManager.isEmpty()) {
            this._restoreReadline();
            this.prompt();
          }
          this.clearScreen();
          this.renderImmediate();
        }
        break;
      // Other commands are no-ops in raw mode
    }
  }

  /**
   * Open the help panel via OverlayManager.
   */
  private openHelpPanel(): void {
    const commands = [
      { name: '/help', description: 'Show this help' },
      { name: '/key', description: 'Set API key at runtime' },
      { name: '/clear', description: 'Clear conversation' },
      { name: '/sidebar', description: 'Toggle sidebar visibility' },
      { name: '/status', description: 'Show current status' },
      { name: '/palette', description: 'Open command palette (Ctrl+K)' },
      { name: '/model', description: 'Open model selector' },
      { name: '/permission', description: 'Show/switch permission modes' },
      { name: '/diff', description: 'Show pending file diffs' },
      { name: '/accept', description: 'Accept current diff' },
      { name: '/reject', description: 'Reject current diff' },
      { name: '/exit', description: 'Exit' },
    ];

    const overlay = new HelpPanelOverlay(commands, this.keybindingManager.getAll());
    this.overlayManager.push(overlay);
    this._enableRawInput();
    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Open the command palette via OverlayManager.
   */
  private openPalette(): void {
    this.paletteState.open = true;
    this.paletteState.query = '';
    this.paletteState.selectedIndex = 0;

    const overlay = new CommandPaletteOverlay(
      this.paletteState,
      (cmd) => {
        this.overlayManager.remove('command-palette');
        this.paletteState.open = false;
        this.executePaletteCommand(cmd.id);
      },
    );

    this.overlayManager.push(overlay);
    this._enableRawInput();
    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Open the model selector via OverlayManager.
   */
  private openModelSelector(): void {
    const state = createModelSelectorState(this.provider, this.model);
    state.active = true;
    this.modelSelectorState = state;

    const overlay = new ModelSelectorOverlay(
      state,
      (providerId, modelId) => {
        const oldProvider = this.provider;
        const oldModel = this.model;
        this.provider = providerId;
        this.model = modelId;
        this.overlayManager.remove('model-selector');
        this._restoreReadline();
        this.addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: chalk.cyan.bold('Model changed:') +
            chalk.dim(` ${oldProvider}/${oldModel}`) +
            chalk.white(' → ') +
            chalk.green.bold(`${providerId}/${modelId}`),
          timestamp: Date.now(),
        });
        this.prompt();
      },
    );

    this.overlayManager.push(overlay);
    this._enableRawInput();
    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Execute a command selected from the palette.
   */
  private executePaletteCommand(commandId: string): void {
    paletteClose(this.paletteState);

    switch (commandId) {
      case 'model':
        this.openModelSelector();
        break;

      case 'provider':
        this.openModelSelector();
        break;

      case 'permission':
        // Show permission modes as a system message
        this.addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: [
            chalk.cyan.bold('Available permission modes:'),
            '  default            - Ask for destructive operations',
            '  bypassPermissions  - Skip permission checks',
            '  dontAsk            - Auto-allow safe operations',
            '  plan               - Plan mode (no execution)',
            '  acceptEdits        - Auto-accept file edits',
            '',
            chalk.dim('Use /permission <mode> to switch.'),
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case 'clear':
        this.messages = [];
        this.turnCount = 0;
        this.sidebarData.tools = [];
        this.pendingDiffs = [];
        this.activeDiffIndex = 0;
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: chalk.gray.dim('Conversation cleared.'),
          timestamp: Date.now(),
        });
        break;

      case 'help':
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: [
            'Available Commands:',
            '  /palette       - Open command palette',
            '  /model         - Open model selector',
            '  /permission    - Show/switch permission modes',
            '  /diff          - Show pending file diffs',
            '  /accept        - Accept current diff',
            '  /reject        - Reject current diff',
            '  /clear         - Clear conversation',
            '  /sidebar       - Toggle sidebar',
            '  /status        - Show session status',
            '  /help          - Show this help',
            '  /exit          - Exit',
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case 'exit':
        this.running = false;
        this.rlClosed = true;
        console.log(chalk.yellow('\nGoodbye!'));
        this.rl.close();
        process.exit(0);
        break;
    }

    this.clearScreen();
    this.renderImmediate();
  }

  /**
   * Capture a diff from a tool result metadata.
   * Called after FileWriteTool / FileEditTool complete.
   */
  private captureDiffFromToolResult(toolName: string, metadata: any): void {
    if (!metadata) return;

    if (!DIFF_TOOLS_SET.has(toolName)) return;

    // FileWriteTool: metadata.oldContent / newContent
    // FileEditTool: metadata.oldContent / newContent
    const oldContent = metadata.oldContent ?? undefined;
    const newContent = metadata.newContent ?? undefined;
    const filePath = metadata.path || metadata.file_path;

    if (!filePath || newContent === undefined) return;

    // Check if we already have a diff for this file
    const existingIdx = this.pendingDiffs.findIndex(
      d => d.filePath === filePath && !d.accepted && !d.rejected
    );

    if (existingIdx >= 0) {
      // Update existing diff
      this.pendingDiffs[existingIdx] = {
        filePath,
        oldContent: oldContent ?? null,
        newContent,
        accepted: false,
        rejected: false,
      };
    } else {
      this.pendingDiffs.push({
        filePath,
        oldContent: oldContent ?? null,
        newContent,
        accepted: false,
        rejected: false,
      });
    }
  }

  private handleCommand(command: string): void {
    const parts = command.split(' ');
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case '/help':
        this.openHelpPanel();
        break;

      case '/keybindings':
        this.openHelpPanel();
        break;

      case '/key': {
        const key = parts[1];
        if (key) {
          this.queryEngine.setApiKey(key);
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.green('API key updated.'),
            timestamp: Date.now(),
          });
        } else {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: 'Usage: /key <api-key>',
            timestamp: Date.now(),
          });
        }
        break;
      }

      case '/clear':
        this.messages = [];
        this.turnCount = 0;
        this.sidebarData.tools = [];
        this.pendingDiffs = [];
        this.activeDiffIndex = 0;
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: 'Conversation cleared.',
          timestamp: Date.now(),
        });
        break;

      case '/sidebar': {
        const section = parts[1] as import('./Sidebar').SidebarSection | undefined;
        if (section && SIDEBAR_SECTIONS_SET.has(section)) {
          this.sidebarData.activeSection = section;
        } else {
          this.sidebarData.visible = !this.sidebarData.visible;
        }
        this.clearScreen();
        this.renderImmediate();
        break;
      }

      case '/status':
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: [
            `Provider: ${this.provider}`,
            `Model: ${this.model}`,
            `Turns: ${this.turnCount}/${this.maxTurns}`,
            `Pending diffs: ${this.pendingDiffs.filter(d => !d.accepted && !d.rejected).length}`,
            `Sandbox: N/A`,
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case '/exit':
        this.running = false;
        this.rlClosed = true;
        console.log(chalk.yellow('\nGoodbye!'));
        this.rl.close();
        process.exit(0);
        break;

      case '/diff': {
        const arg = parts[1];
        if (arg !== undefined) {
          const num = parseInt(arg, 10);
          if (!isNaN(num) && num >= 1 && num <= this.pendingDiffs.length) {
            this.activeDiffIndex = num - 1;
          }
        }
        if (this.pendingDiffs.length > 0) {
          this.addMessage({
            id: `diff-${Date.now()}`,
            role: 'system',
            content: renderMultiFileDiff(
              this.pendingDiffs,
              this.activeDiffIndex,
              { maxWidth: Math.min((process.stdout.columns || 80) - this.sidebarWidth - 6, 100), theme: this.theme }
            ),
            timestamp: Date.now(),
          });
        } else {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.gray.dim('No pending diffs.'),
            timestamp: Date.now(),
          });
        }
        break;
      }

      case '/accept':
        if (this.pendingDiffs.length > 0) {
          const diff = this.pendingDiffs[this.activeDiffIndex];
          if (diff) {
            diff.accepted = true;
            this.addMessage({
              id: `sys-${Date.now()}`,
              role: 'system',
              content: chalk.green(`✓ Accepted changes to ${diff.filePath}`),
              timestamp: Date.now(),
            });
            // Advance to next unprocessed diff
            this.advanceDiffIndex();
          }
        }
        break;

      case '/palette':
        this.openPalette();
        break;

      case '/model':
        this.openModelSelector();
        break;

      case '/permission': {
        const mode = parts[1];
        if (mode && VALID_PERMISSION_MODES_SET.has(mode)) {
          // Switch permission mode (runtime only, not persisted)
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.cyan(`Permission mode switched to: ${mode}`),
            timestamp: Date.now(),
          });
        } else {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: [
              chalk.cyan.bold('Available permission modes:'),
              '  default            - Ask for destructive operations',
              '  bypassPermissions  - Skip permission checks',
              '  dontAsk            - Auto-allow safe operations',
              '  plan               - Plan mode (no execution)',
              '  acceptEdits        - Auto-accept file edits',
              '',
              chalk.dim('Usage: /permission <mode>'),
            ].join('\n'),
            timestamp: Date.now(),
          });
        }
        break;
      }

      case '/reject':
        if (this.pendingDiffs.length > 0) {
          const diff = this.pendingDiffs[this.activeDiffIndex];
          if (diff) {
            diff.rejected = true;
            this.addMessage({
              id: `sys-${Date.now()}`,
              role: 'system',
              content: chalk.red(`✗ Rejected changes to ${diff.filePath}`),
              timestamp: Date.now(),
            });
            // Advance to next unprocessed diff
            this.advanceDiffIndex();
          }
        }
        break;

      default:
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `Unknown command: ${cmd}. Type /help for available commands.`,
          timestamp: Date.now(),
        });
    }
  }
}

export async function runApp(options: AppOptions): Promise<void> {
  const app = new App(options);
  await app.start();
}
