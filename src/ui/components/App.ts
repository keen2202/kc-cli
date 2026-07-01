import chalk from 'chalk';
import { getErrorMessage } from '../../utils/errors';
import { renderMultiFileDiff, type FileDiff } from '../diff-viewer';
import {
  createPaletteState,
  paletteMoveUp,
  paletteMoveDown,
  paletteGetSelected,
  paletteClose,
  type PaletteState,
} from './CommandPalette';
import {
  createModelSelectorState,
  modelSelectorMoveUp,
  modelSelectorMoveDown,
  modelSelectorGetSelected,
  type ModelSelectorState,
} from './ModelSelector';
import { getTheme, setTheme, THEMES, type Theme } from '../theme';
import { UIEventBus } from '../event-bus';
import { OverlayManager } from '../overlay-manager';
import { CommandPaletteOverlay } from '../overlays/CommandPaletteOverlay';
import { ModelSelectorOverlay } from '../overlays/ModelSelectorOverlay';
import { HelpPanelOverlay } from '../overlays/HelpPanelOverlay';
import { createDefaultKeybindings, type KeybindingManager } from '../keybinding-manager';
import { createLogMiddleware } from '../middleware/log';
import { createBudgetMiddleware } from '../middleware/budget';
import { createBridgeMiddleware } from '../middleware/bridge';
import { InputManager, type InputDelegates } from './InputManager';
import { DiffManager } from './DiffManager';
import { RenderEngine, type RenderState } from './RenderEngine';
import {
  createAutocompleteState,
  filterAutocompleteItems,
  autocompleteMoveUp,
  autocompleteMoveDown,
  autocompleteGetSelected,
  buildAutocompleteItems,
  type AutocompleteState,
} from './AutocompletePopup';
import type { QueryEngine } from '../../query/QueryEngine';
import type { AgentEvent } from '../../state/types';
import type { StreamEvent } from '../../query/protocol';
import { normalizeUIEvent, type CanonicalEventType } from '../event-normalizer';
import type { ChatMessage } from './ChatView';
import type { ThinkingChain } from './ThinkingChainView';
import { classifyThinkingSteps } from './ThinkingChainView';
import {
  createSidebarSelection,
  sidebarMoveUp,
  sidebarMoveDown,
  sidebarMoveLeft,
  sidebarMoveRight,
  type SidebarSelection,
} from './Sidebar';
import type { SidebarData, SidebarTool } from './Sidebar';
import { createSidebarData } from './Sidebar';
import { createInputState, type InputState } from './InputBox';
import { type Notification, buildSendFailedNotification, buildEmptyApiKeyNotification, buildKeyInvalidNotification } from './NotificationBar';

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
  private turnCount: number = 0;
  private sessionStartTime: number;
  private running: boolean = true;
  private _cleanupFn: (() => void) | null = null;
  private sidebarData: SidebarData;
  private sidebarWidth: number = 34;
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
  private autocompleteState: AutocompleteState;
  private sidebarSelection: SidebarSelection;
  private isStreaming: boolean = false;
  private streamingTimer: ReturnType<typeof setInterval> | null = null;
  private notification: Notification | null = null;

  // Extracted managers
  private inputManager: InputManager;
  private diffManager: DiffManager;
  private renderEngine: RenderEngine;

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
    this.autocompleteState = createAutocompleteState();
    this.sidebarSelection = createSidebarSelection();

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

    // Initialize extracted managers
    this.diffManager = new DiffManager();
    this.diffManager.initWorker();

    this.renderEngine = new RenderEngine();
    this.renderEngine.setDebouncedPromptHandler(() => {
      this.prompt();
    });

    this.inputManager = new InputManager(this.createInputDelegates());
  }

  private createInputDelegates(): InputDelegates {
    return {
      onUserInput: async (input: string) => {
        this.addMessage({
          id: `user-${Date.now()}`,
          role: 'user',
          content: input,
          timestamp: Date.now(),
        });
        await this.executeQuery(input);
      },
      onCommand: (command: string) => {
        this.handleCommand(command);
      },
      onRenderRequest: () => {
        this.render();
      },
      onClearScreen: () => {
        this.renderEngine.clearScreen();
      },
      onOverlayKeypress: (event) => {
        if (this.overlayManager.handleKeypress(event)) {
          if (this.overlayManager.isEmpty()) {
            this.inputManager.restoreReadline();
            this.inputManager.prompt();
          }
          this.renderEngine.clearScreen();
          this.render();
          return true;
        }
        return false;
      },
      onKeybindingCommand: (command: string) => {
        this.executeKeybindingCommand(command);
      },
      isRunning: () => this.running,
      getOverlayManager: () => this.overlayManager,
      getKeybindingManager: () => this.keybindingManager,
      getTheme: () => this.theme,
    };
  }

  async start(): Promise<void> {
    this.renderEngine.clearScreen();

    // Show notification if API key is missing (skip for ollama which needs no key)
    if (this.provider !== 'ollama' && this.provider !== 'unknown' && typeof this.queryEngine.getApiKey === 'function') {
      const currentKey = this.queryEngine.getApiKey();
      if (!currentKey) {
        this.notification = buildEmptyApiKeyNotification();
      }
    }

    this.renderImmediate();

    // Terminal resize handling (debounced)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        this.applyBreakpoint();
        this.renderEngine.clearScreen();
        this.renderImmediate();
      }, 100);
    };
    process.stdout.on('resize', onResize);

    // Graceful shutdown
    const cleanup = () => {
      this.dispose();
      console.log(chalk.yellow('\nGoodbye!'));
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Store cleanup references for external teardown
    this._cleanupFn = () => {
      process.stdout.removeListener('resize', onResize);
      process.removeListener('SIGINT', cleanup);
      process.removeListener('SIGTERM', cleanup);
      if (resizeTimer) clearTimeout(resizeTimer);
    };

    this.inputManager.prompt();
  }

  /**
   * Centralized teardown: cancel timers, close readline, detach process listeners,
   * terminate diff worker. Safe to call multiple times (idempotent).
   */
  private dispose(): void {
    this.running = false;

    // Cancel throttled/debounced timers
    this.renderEngine.cancelThrottle();
    this.renderEngine.cancelDebounce();

    // Close input manager (readline + raw mode cleanup)
    this.inputManager.close();

    // Terminate diff worker
    this.diffManager.terminateWorker();

    // Remove process-level listeners registered in start()
    if (this._cleanupFn) {
      this._cleanupFn();
      this._cleanupFn = null;
    }

    // Clear event bus to prevent stale listener callbacks
    this.eventBus.clear();
  }

  // ── Render helpers ──

  private buildRenderState(): RenderState {
    return {
      terminalWidth: process.stdout.columns || 80,
      terminalHeight: process.stdout.rows || 24,
      sidebarWidth: this.sidebarWidth,
      messages: this.messages,
      sidebarData: this.sidebarData,
      theme: this.theme,
      provider: this.provider,
      model: this.model,
      sessionStartTime: this.sessionStartTime,
      turnCount: this.turnCount,
      maxTurns: this.maxTurns,
      thinkingChains: this._thinkingChains,
      overlayManager: this.overlayManager,
      inputState: this.inputManager.getInputState(),
      autocompleteState: this.autocompleteState,
      isStreaming: this.isStreaming,
      sidebarSelection: this.sidebarSelection,
      notification: this.notification ?? undefined,
    };
  }

  private render(): void {
    this.renderEngine.render(this.buildRenderState());
  }

  private renderImmediate(): void {
    this.renderEngine.renderImmediate(this.buildRenderState());
  }

  private applyBreakpoint(): void {
    const { sidebarVisible } = this.renderEngine.applyBreakpoint();
    this.sidebarData.visible = sidebarVisible;
  }

  // ── Input flow ──

  private prompt(): void {
    this.inputManager.prompt();
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

    // Start streaming indicator
    this.isStreaming = true;
    this.streamingTimer = setInterval(() => {
      this.render();
    }, 150);

    try {
      for await (const event of this.queryEngine.submitMessage(prompt)) {
        this.eventBus.emit(event);
      }
    } catch (error) {
      const errTokens = this.theme.resolve();
      const errMsg = getErrorMessage(error);
      assistantMsg.content = errTokens['error.text'](`Error: ${errMsg}`);
      this.notification = buildSendFailedNotification(errMsg);
      // Auto-clear notification after 8 seconds
      setTimeout(() => { this.notification = null; this.render(); }, 8000);
    } finally {
      // Stop streaming indicator
      this.isStreaming = false;
      if (this.streamingTimer) {
        clearInterval(this.streamingTimer);
        this.streamingTimer = null;
      }
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

  // ── Event handling ──

  private handleEvent(event: AgentEvent | StreamEvent, assistantMsg: ChatMessage | null): void {
    if (!assistantMsg) return;
    const normalized = normalizeUIEvent(event);
    const type = normalized.type;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = normalized.raw as any;

    switch (type) {
      case 'text_delta':
        assistantMsg.content = (assistantMsg.content || '') + ev.text;
        this.renderEngine.markDirty('content');
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
        this.renderEngine.markDirty('content');
        this.render();
        break;
      }

      case 'tool_started':
      case 'tool_use_start': {
        const toolCall = {
          toolName: ev.toolCall.toolName,
          status: 'running' as const,
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
          this.diffManager.captureDiff(ev.toolCall.toolName, ev.result?.metadata);
        }
        this.diffManager.showDiffPreview(this.messages, this.sidebarWidth, this.theme);
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
        break;
    }
  }

  // ── Sidebar ──

  private updateSidebarTool(tool: SidebarTool): void {
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

  // ── Keybinding commands ──

  private executeKeybindingCommand(command: string): void {
    switch (command) {
      case 'palette':
        this.openPalette();
        break;
      case 'clear':
        this.messages = [];
        this.turnCount = 0;
        this.sidebarData.tools = [];
        this.diffManager.clear();
        this.renderEngine.clearScreen();
        this.renderImmediate();
        break;
      case 'toggleSidebar':
        this.sidebarData.visible = !this.sidebarData.visible;
        this.renderEngine.clearScreen();
        this.renderImmediate();
        break;
      case 'toggleThinking': {
        const lastChain = this._currentThinkingChain
          || (this._thinkingChains.size > 0
            ? Array.from(this._thinkingChains.values()).pop()
            : null);
        if (lastChain) {
          lastChain.folded = !lastChain.folded;
          this.renderEngine.clearScreen();
          this.renderImmediate();
        }
        break;
      }
      case 'exit':
        this.dispose();
        console.log(chalk.yellow('\nGoodbye!'));
        process.exit(0);
        break;
      case 'closeOverlay':
        if (!this.overlayManager.isEmpty()) {
          this.overlayManager.pop();
          if (this.overlayManager.isEmpty()) {
            this.inputManager.restoreReadline();
            this.inputManager.prompt();
          }
          this.renderEngine.clearScreen();
          this.renderImmediate();
        }
        break;
      case 'sidebarUp':
        sidebarMoveUp(this.sidebarData, this.sidebarSelection);
        this.renderImmediate();
        break;
      case 'sidebarDown':
        sidebarMoveDown(this.sidebarData, this.sidebarSelection);
        this.renderImmediate();
        break;
      case 'sidebarLeft':
        sidebarMoveLeft(this.sidebarData, this.sidebarSelection);
        this.renderImmediate();
        break;
      case 'sidebarRight':
        sidebarMoveRight(this.sidebarData, this.sidebarSelection);
        this.renderImmediate();
        break;
      case 'autocompleteUp':
        autocompleteMoveUp(this.autocompleteState);
        this.renderImmediate();
        break;
      case 'autocompleteDown':
        autocompleteMoveDown(this.autocompleteState);
        this.renderImmediate();
        break;
      case 'autocompleteSelect': {
        const selected = autocompleteGetSelected(this.autocompleteState);
        if (selected) {
          // Insert the selected item into the input text
          const text = this.inputManager.getInputState().text;
          const cursorPos = this.inputManager.getInputState().cursorPos;
          // Find @ prefix and replace with selection
          const lastAt = text.lastIndexOf('@', cursorPos - 1);
          const suffix = text.slice(cursorPos);
          const prefix = lastAt !== -1 ? text.slice(0, lastAt) : text;
          const insertText = selected.type === 'file' || selected.type === 'agent' ? `@${selected.label} ` : selected.label;
          // Close autocomplete
          this.autocompleteState = createAutocompleteState();
          this.renderEngine.clearScreen();
          this.renderImmediate();
        }
        break;
      }
    }
  }

  // ── Overlay lifecycle ──

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
    this.inputManager.enableRawInput();
    this.renderEngine.clearScreen();
    this.renderImmediate();
  }

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
    this.inputManager.enableRawInput();
    this.renderEngine.clearScreen();
    this.renderImmediate();
  }

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
        this.inputManager.restoreReadline();
        this.addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: chalk.cyan.bold('Model changed:') +
            chalk.dim(` ${oldProvider}/${oldModel}`) +
            chalk.white(' → ') +
            chalk.green.bold(`${providerId}/${modelId}`),
          timestamp: Date.now(),
        });
        this.inputManager.prompt();
      },
    );

    this.overlayManager.push(overlay);
    this.inputManager.enableRawInput();
    this.renderEngine.clearScreen();
    this.renderImmediate();
  }

  // ── Palette command execution ──

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
        this.diffManager.clear();
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
        this.dispose();
        console.log(chalk.yellow('\nGoodbye!'));
        process.exit(0);
        break;
    }

    this.renderEngine.clearScreen();
    this.renderImmediate();
  }

  // ── Command handling ──

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
          const validationError = this.queryEngine.setApiKey(key);
          if (validationError) {
            this.notification = buildKeyInvalidNotification(validationError);
            setTimeout(() => { this.notification = null; this.render(); }, 8000);
            this.addMessage({
              id: `sys-${Date.now()}`,
              role: 'system',
              content: chalk.red(`✗ Invalid API key: ${validationError}`),
              timestamp: Date.now(),
            });
          } else {
            this.addMessage({
              id: `sys-${Date.now()}`,
              role: 'system',
              content: chalk.green('✓ API key updated.'),
              timestamp: Date.now(),
            });
          }
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
        this.diffManager.clear();
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
        this.renderEngine.clearScreen();
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
            `Pending diffs: ${this.diffManager.unprocessedCount()}`,
            `Sandbox: N/A`,
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case '/exit':
        this.dispose();
        console.log(chalk.yellow('\nGoodbye!'));
        process.exit(0);
        break;

      case '/diff': {
        const arg = parts[1];
        if (arg !== undefined) {
          const num = parseInt(arg, 10);
          if (!isNaN(num) && num >= 1) {
            this.diffManager.setActiveDiffIndex(num - 1);
          }
        }
        if (this.diffManager.unprocessedCount() > 0) {
          const diffPreview = this.diffManager.renderDiffForDisplay(this.sidebarWidth, this.theme);
          if (diffPreview) {
            this.addMessage({
              id: `diff-${Date.now()}`,
              role: 'system',
              content: diffPreview,
              timestamp: Date.now(),
            });
          }
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

      case '/accept': {
        const result = this.diffManager.acceptCurrent();
        if (result) {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.green(`✓ Accepted changes to ${result.filePath}`),
            timestamp: Date.now(),
          });
        }
        break;
      }

      case '/palette':
        this.openPalette();
        break;

      case '/model':
        this.openModelSelector();
        break;

      case '/permission': {
        const mode = parts[1];
        if (mode && VALID_PERMISSION_MODES_SET.has(mode)) {
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

      case '/theme': {
        const name = parts[1];
        if (name && THEMES[name]) {
          setTheme(name);
          this.theme = getTheme(name);
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.green(`Theme switched to: ${name}`),
            timestamp: Date.now(),
          });
        } else if (name) {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.yellow(`Unknown theme: ${name}. Available: ${Object.keys(THEMES).join(', ')}`),
            timestamp: Date.now(),
          });
        } else {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: [
              chalk.cyan.bold('Available themes:'),
              ...Object.keys(THEMES).map(t => `  ${t}`),
              '',
              chalk.dim('Usage: /theme <name>'),
            ].join('\n'),
            timestamp: Date.now(),
          });
        }
        break;
      }

      case '/reject': {
        const result = this.diffManager.rejectCurrent();
        if (result) {
          this.addMessage({
            id: `sys-${Date.now()}`,
            role: 'system',
            content: chalk.red(`✗ Rejected changes to ${result.filePath}`),
            timestamp: Date.now(),
          });
        }
        break;
      }

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
