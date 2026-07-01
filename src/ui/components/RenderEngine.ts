import { renderStatusBar } from './StatusBar';
import { renderHeader } from './Header';
import { renderSidebar } from './Sidebar';
import { renderChatViewport } from './ChatViewport';
import { VirtualScroller } from '../virtual-scroll';
import { createThrottle, createDebounce } from '../renderer';
import { getBreakpoint, type Density } from '../layout';
import type { Theme } from '../theme';
import type { ChatMessage } from './ChatView';
import type { SidebarData, SidebarSelection } from './Sidebar';
import type { ThinkingChain } from './ThinkingChainView';
import type { OverlayManager } from '../overlay-manager';
import { renderInputBox, type InputState } from './InputBox';
import { renderAutocompletePopup, type AutocompleteState } from './AutocompletePopup';
import { renderNotification, type Notification } from './NotificationBar';

const VIRTUAL_SCROLL_THRESHOLD = 100;
const RENDER_THROTTLE_MS = 16;
const INPUT_DEBOUNCE_MS = 50;

export interface RenderState {
  terminalWidth: number;
  terminalHeight: number;
  sidebarWidth: number;
  messages: ChatMessage[];
  sidebarData: SidebarData;
  theme: Theme;
  provider: string;
  model: string;
  sessionStartTime: number;
  turnCount: number;
  maxTurns: number;
  thinkingChains: Map<string, ThinkingChain>;
  overlayManager: OverlayManager;
  inputState?: InputState;
  autocompleteState?: AutocompleteState;
  isStreaming?: boolean;
  sidebarSelection?: SidebarSelection;
  notification?: Notification;
}

export type DirtyRegion = 'header' | 'content' | 'separator' | 'overlay' | 'status';

interface LayoutMetrics {
  headerLineCount: number;
  maxLines: number;
  overlayLines: number;
  statusLines: number;
  totalLines: number;
}

export class RenderEngine {
  private virtualScroller: VirtualScroller;
  private throttledRender: ReturnType<typeof createThrottle>;
  private debouncedPrompt: ReturnType<typeof createDebounce>;
  private density: Density = 'normal';

  // Dirty-region tracking
  private dirtyRegions = new Set<DirtyRegion>();
  private forceFullRepaint = true;
  private prevMetrics: LayoutMetrics | null = null;

  constructor() {
    const viewportHeight = (process.stdout.rows || 24) - 8;
    this.virtualScroller = new VirtualScroller({ viewportHeight, overscan: 5 });

    this.throttledRender = createThrottle(() => {
      this._doRender(this._pendingState!);
    }, RENDER_THROTTLE_MS);

    this.debouncedPrompt = createDebounce(() => {
      this._onDebouncedPrompt?.();
    }, INPUT_DEBOUNCE_MS);
  }

  private _pendingState: RenderState | null = null;
  private _onDebouncedPrompt: (() => void) | null = null;

  setDebouncedPromptHandler(handler: () => void): void {
    this._onDebouncedPrompt = handler;
  }

  triggerDebouncedPrompt(): void {
    this.debouncedPrompt();
  }

  clearScreen(): void {
    process.stdout.write('\x1B[2J\x1B[H');
    this.forceFullRepaint = true;
  }

  /** Mark a specific region as needing repaint. */
  markDirty(region: DirtyRegion): void {
    this.dirtyRegions.add(region);
  }

  /** Mark all regions dirty — forces a full repaint on next render. */
  markAllDirty(): void {
    this.dirtyRegions.add('header');
    this.dirtyRegions.add('content');
    this.dirtyRegions.add('separator');
    this.dirtyRegions.add('overlay');
    this.dirtyRegions.add('status');
  }

  render(state: RenderState): void {
    this._pendingState = state;
    this.throttledRender();
  }

  renderImmediate(state: RenderState): void {
    this._pendingState = state;
    this.throttledRender.cancel();
    this.markAllDirty();
    this._doRender(state);
  }

  applyBreakpoint(): { density: Density; sidebarVisible: boolean } {
    const cols = process.stdout.columns || 80;
    const bp = getBreakpoint(cols);
    this.density = bp.density;
    this.forceFullRepaint = true;
    return { density: bp.density, sidebarVisible: bp.sidebarVisible };
  }

  private computeLayout(state: RenderState): {
    metrics: LayoutMetrics;
    headerResult: ReturnType<typeof renderHeader>;
    sidebarLines: string[];
    chatLines: string[];
    inputBoxLines: string[];
    autocompleteLines: string[];
    notificationLine: string;
    status: string;
  } {
    const terminalWidth = state.terminalWidth;
    // Main content area ends at sidebar's left edge with a 2-char gutter
    const mainWidth = terminalWidth - state.sidebarWidth - 2;
    // Input box extends flush to sidebar left edge (no gutter)
    const inputBoxWidth = terminalWidth - state.sidebarWidth;
    const tokens = state.theme.resolve();

    const headerResult = renderHeader({
      provider: state.provider,
      model: state.model,
      sessionId: state.sessionStartTime.toString(36),
      width: terminalWidth,
      theme: state.theme,
    });

    const sidebarLines = renderSidebar(state.sidebarData, state.sidebarWidth, state.theme, state.sidebarSelection).split('\n');

    // Render input box for multi-line input
    const inputBoxLines = state.inputState
      ? renderInputBox(state.inputState, 'kc>', state.theme, inputBoxWidth)
      : [];

    // Render autocomplete popup (aligned with input box)
    const autocompleteLines = state.autocompleteState
      ? renderAutocompletePopup(state.autocompleteState, inputBoxWidth, state.theme)
      : [];

    // Render notification if present
    const notificationLine = state.notification
      ? renderNotification(state.notification, inputBoxWidth, state.theme)
      : '';

    // Adjust chat viewport height for input box, autocomplete, and notification
    const notificationHeight = notificationLine ? 1 : 0;
    const inputAreaHeight = inputBoxLines.length + autocompleteLines.length + notificationHeight;
    const chatHeight = Math.max(5, (process.stdout.rows || 24) - 8 - inputAreaHeight);

    const chatLines = renderChatViewport({
      messages: state.messages,
      scroller: this.virtualScroller,
      width: mainWidth,
      height: chatHeight,
      theme: state.theme,
      virtualScrollThreshold: VIRTUAL_SCROLL_THRESHOLD,
      thinkingChains: state.thinkingChains,
    });

    const maxLines = Math.max(sidebarLines.length, chatLines.length);

    const overlayLines = !state.overlayManager.isEmpty() ? 2 : 0;

    const status = renderStatusBar({
      provider: state.provider,
      model: state.model,
      turnCount: state.turnCount,
      maxTurns: state.maxTurns,
      sessionStartTime: state.sessionStartTime,
      isStreaming: state.isStreaming,
    }, state.theme);

    const statusLines = status ? status.split('\n').length : 0;
    const headerLineCount = headerResult.lines.length;
    const notificationCount = notificationLine ? 1 : 0;
    const totalLines = headerLineCount + maxLines + 1 + overlayLines + inputBoxLines.length + autocompleteLines.length + notificationCount + statusLines;

    return {
      metrics: { headerLineCount, maxLines, overlayLines, statusLines, totalLines },
      headerResult,
      sidebarLines,
      chatLines,
      inputBoxLines,
      autocompleteLines,
      notificationLine,
      status,
    };
  }

  private _doRender(state: RenderState): void {
    const layout = this.computeLayout(state);
    const { metrics, headerResult, sidebarLines, chatLines, status } = layout;

    // Determine if layout shifted (content height changed)
    const layoutShifted = this.prevMetrics !== null && metrics.maxLines !== this.prevMetrics.maxLines;
    if (layoutShifted) {
      this.forceFullRepaint = true;
    }

    // Decide: partial or full repaint
    const needsFullRepaint =
      this.forceFullRepaint ||
      this.dirtyRegions.size === 0 ||
      this.dirtyRegions.has('header') ||
      this.dirtyRegions.has('overlay') ||
      this.dirtyRegions.has('status') ||
      this.dirtyRegions.has('separator') ||
      layoutShifted;

    if (needsFullRepaint) {
      this.fullRepaint(state, layout);
    } else {
      this.contentOnlyRepaint(state, layout);
    }

    // Clear stale lines below the rendered content
    const termHeight = process.stdout.rows || 24;
    for (let i = metrics.totalLines; i < termHeight; i++) {
      process.stdout.write(`\x1B[${i};0H\x1B[2K`);
    }

    this.dirtyRegions.clear();
    this.forceFullRepaint = false;
    this.prevMetrics = metrics;
  }

  /** Full-screen repaint: homes cursor and re-renders everything top-to-bottom. */
  private fullRepaint(
    state: RenderState,
    layout: { metrics: LayoutMetrics; headerResult: ReturnType<typeof renderHeader>; sidebarLines: string[]; chatLines: string[]; inputBoxLines: string[]; autocompleteLines: string[]; notificationLine: string; status: string },
  ): void {
    process.stdout.write('\x1B[H');

    const { metrics, headerResult, sidebarLines, chatLines, inputBoxLines, autocompleteLines, notificationLine, status } = layout;
    const terminalWidth = state.terminalWidth;
    const mainWidth = terminalWidth - state.sidebarWidth - 2;
    const tokens = state.theme.resolve();

    // Header
    for (const line of headerResult.lines) {
      console.log(line);
    }

    // Content: interleaved chat + sidebar
    for (let i = 0; i < metrics.maxLines; i++) {
      const sidebarLine = sidebarLines[i] || ' '.repeat(state.sidebarWidth);
      const chatLine = chatLines[i] || '';

      const plainChat = chatLine.replace(/\x1B\[[0-9;]*m/g, '');
      if (plainChat.length > mainWidth) {
        const truncated = this.truncateAnsi(chatLine, mainWidth);
        process.stdout.write(`${truncated}  ${sidebarLine}\n`);
      } else {
        const padding = ' '.repeat(Math.max(0, mainWidth - plainChat.length));
        process.stdout.write(`${chatLine}${padding}  ${sidebarLine}\n`);
      }
    }

    // Separator
    const sepBorder = tokens['overlay.border'];
    console.log(sepBorder('├' + '─'.repeat(terminalWidth - state.sidebarWidth - 1) + '┼' + '─'.repeat(state.sidebarWidth - 2) + '┤'));

    // Overlay Layer
    if (!state.overlayManager.isEmpty()) {
      console.log('');
      console.log(state.overlayManager.render(terminalWidth, process.stdout.rows || 24, state.theme));
    }

    // Input Box (multi-line)
    for (const line of inputBoxLines) {
      console.log(line);
    }

    // Autocomplete Popup
    for (const line of autocompleteLines) {
      console.log(line);
    }

    // Notification bar (error / warning / success / info)
    if (notificationLine) {
      console.log(notificationLine);
    }

    // Status
    if (status) {
      console.log(status);
    }
  }

  /**
   * Partial repaint: only the content region (chat + sidebar) is dirty.
   * Positions the cursor at the content start row and re-renders only
   * the interleaved chat/sidebar lines. Used during streaming to avoid
   * re-rendering header/status/separator on every text_delta frame.
   */
  private contentOnlyRepaint(
    state: RenderState,
    layout: { metrics: LayoutMetrics; sidebarLines: string[]; chatLines: string[]; inputBoxLines?: string[]; autocompleteLines?: string[]; notificationLine?: string },
  ): void {
    const { metrics, sidebarLines, chatLines } = layout;
    const mainWidth = state.terminalWidth - state.sidebarWidth - 2;
    const contentStartRow = metrics.headerLineCount;

    for (let i = 0; i < metrics.maxLines; i++) {
      process.stdout.write(`\x1B[${contentStartRow + i};0H\x1B[2K`);
      const sidebarLine = sidebarLines[i] || ' '.repeat(state.sidebarWidth);
      const chatLine = chatLines[i] || '';

      const plainChat = chatLine.replace(/\x1B\[[0-9;]*m/g, '');
      if (plainChat.length > mainWidth) {
        const truncated = this.truncateAnsi(chatLine, mainWidth);
        process.stdout.write(`${truncated}  ${sidebarLine}`);
      } else {
        const padding = ' '.repeat(Math.max(0, mainWidth - plainChat.length));
        process.stdout.write(`${chatLine}${padding}  ${sidebarLine}`);
      }
    }
  }

  private truncateAnsi(str: string, maxWidth: number): string {
    const plain = str.replace(/\x1B\[[0-9;]*m/g, '');
    if (plain.length <= maxWidth) return str;
    const codes: string[] = [];
    let plainIdx = 0;
    const re = /\x1B\[([0-9;]*)m/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null && plainIdx < maxWidth - 1) {
      codes.push(m[0]);
    }
    return codes.join('') + plain.slice(0, maxWidth - 1) + '…\x1B[0m';
  }

  cancelThrottle(): void {
    this.throttledRender.cancel();
  }

  cancelDebounce(): void {
    this.debouncedPrompt.cancel();
  }
}
