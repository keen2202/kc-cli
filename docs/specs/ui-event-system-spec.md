# KC-CLI UI & Event Response System Spec

> Based on analysis of Claude Code's React+Ink architecture (~140 components, 512K LOC) and kc-cli's current chalk-based implementation.

## 1. Problem Statement

kc-cli's current UI is a monolithic `App` class (1118 lines) that directly composes chalk strings and writes ANSI escapes. While functional, it has:

- **No component isolation** -- all rendering logic lives in `App.ts`, making it hard to test, extend, or reuse
- **Theme system is dead code** -- `theme.ts` defines 5 themes but nothing uses them (hardcoded chalk everywhere)
- **Event handling is coupled** -- `handleEvent()` in App.ts directly mutates UI state with no middleware or plugin hooks
- **No structured output mode** -- Claude Code supports JSON/streaming-JSON for IDE bridge; kc-cli has no equivalent
- **Overlay system is ad-hoc** -- CommandPalette and ModelSelector switch stdin modes independently with duplicated logic

The goal is to bring kc-cli's UI to parity with Claude Code's interactive experience while staying on chalk (no Ink migration), and to build a proper event pipeline that supports middleware, plugins, and structured output.

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   App Shell                      │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Header  │ │ Sidebar  │ │   ChatViewport   │  │
│  └─────────┘ └──────────┘ └──────────────────┘  │
│  ┌─────────────────────────────────────────────┐ │
│  │              InputBox + SteerMode           │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │              StatusBar                       │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │  OverlayLayer (CommandPalette, ModelSelector│ │
│  │  PermissionDialog, DiffPreview, HelpPanel)  │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
         │                    ▲
         ▼                    │
┌─────────────────────────────────────────────────┐
│              EventBus + Middleware                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ │
│  │ Log    │ │ Budget │ │ Plugin │ │ Bridge   │ │
│  │ Middle │ │ Middle │ │ Hooks  │ │ Forward  │ │
│  └────────┘ └────────┘ └────────┘ └──────────┘ │
└─────────────────────────────────────────────────┘
         │                    ▲
         ▼                    │
┌─────────────────────────────────────────────────┐
│              QueryEngine (unchanged)             │
│  AsyncGenerator<StreamEvent | AgentEvent>        │
└─────────────────────────────────────────────────┘
```

## 3. Component Model

### 3.1 Component Interface

Every UI component becomes a pure function with explicit inputs and a render contract:

```typescript
interface ComponentProps {
  width: number;
  height: number;
  theme: Theme;
}

interface RenderResult {
  lines: string[];       // Pre-formatted lines ready to write
  cursorX?: number;      // Cursor position hint
  cursorY?: number;
  needsInput?: boolean;  // Whether this component captures keyboard
}

type Component<P extends ComponentProps> = (props: P) => RenderResult;
```

### 3.2 Components to Extract

| Component | Source | Props | Notes |
|-----------|--------|-------|-------|
| `Header` | App.renderHeader() | `model, provider, theme` | Brand + model info |
| `ChatViewport` | App.renderMessages() | `messages, scroller, theme` | VirtualScroller integration |
| `ChatMessage` | ChatView.render() | `message, width, theme` | Single message render |
| `ToolCallCard` | ToolCallCard.render() | `data, width, theme` | Already standalone, add theme |
| `InputBox` | InputBox.render() | `state, mode, theme` | Add multi-line support |
| `StatusBar` | StatusBar.render() | `model, tokens, duration, theme` | Already standalone, add theme |
| `Sidebar` | Sidebar.render() | `data, width, activeTab, theme` | Tabbed panel |
| `CommandPalette` | CommandPalette.render() | `state, theme` | Overlay, already standalone |
| `ModelSelector` | ModelSelector.render() | `state, theme` | Overlay, already standalone |
| `DiffPreview` | diff-viewer.render() | `diffs, activeIndex, theme` | File diff overlay |
| `PermissionDialog` | NEW | `toolCall, rule, theme` | Y/N/Always prompt |
| `HelpPanel` | NEW | `commands, keybindings, theme` | `/help` overlay |
| `ThinkingIndicator` | NEW | `elapsed, theme` | Shows "thinking..." with timer |

### 3.3 Overlay Manager

Unified overlay system replacing the ad-hoc stdin switching:

```typescript
interface Overlay {
  id: string;
  zIndex: number;
  render(width: number, height: number, theme: Theme): RenderResult;
  onKeypress(key: KeypressEvent): boolean; // true = consumed
  onClose?(): void;
}

class OverlayManager {
  private stack: Overlay[] = [];

  push(overlay: Overlay): void;
  pop(): void;
  has(id: string): boolean;
  handleKeypress(key: KeypressEvent): boolean; // top-down dispatch
  render(width: number, height: number, theme: Theme): string;
}
```

## 4. Event Pipeline

### 4.1 Event Bus Architecture

Replace the direct `QueryEngine → App.handleEvent()` coupling with a middleware-capable event bus:

```typescript
type EventMiddleware = (
  event: AgentEvent | StreamEvent,
  next: () => void
) => void;

class UIEventBus {
  private middlewares: EventMiddleware[] = [];
  private listeners: Map<string, Set<(event: AgentEvent | StreamEvent) => void>> = new Map();

  use(middleware: EventMiddleware): void;

  on(type: string, handler: (event: AgentEvent | StreamEvent) => void): () => void;

  emit(event: AgentEvent | StreamEvent): void;
  // Runs middlewares in order, then dispatches to listeners
}
```

### 4.2 Built-in Middleware

| Middleware | Purpose |
|-----------|---------|
| `LogMiddleware` | Debug logging of all events |
| `BudgetMiddleware` | Track token usage, emit warnings |
| `ThemeMiddleware` | Inject theme context into render-triggering events |
| `BridgeMiddleware` | Forward events to IDE bridge (JSON output) |
| `PluginMiddleware` | Route events to plugin hooks |
| `AnalyticsMiddleware` | Track tool usage, latency, error rates |

### 4.3 Plugin Event Hooks

Plugins can register event hooks via the contribution system:

```typescript
interface PluginEventHooks {
  onToolStart?(toolCall: ToolCall): void;
  onToolComplete?(toolCall: ToolCall, result: ToolResult): void;
  onTurnComplete?(message: ChatMessage, usage: TokenUsage): void;
  onError?(error: Error, recoverable: boolean): void;
  onTextDelta?(text: string): void;
}
```

## 5. Theme System Integration

### 5.1 Wire existing theme.ts into all components

The theme system at `src/ui/theme.ts` already defines 5 themes. The task is to:

1. Add `theme: Theme` parameter to every component render function
2. Replace hardcoded `chalk.cyan`, `chalk.green`, etc. with `theme.color('chat.user')`, `theme.color('status.model')` etc.
3. Add a `/theme` command to switch themes at runtime
4. Persist theme preference in user config

### 5.2 Theme Token Map

```typescript
interface ThemeTokens {
  'header.brand': ChalkFunction;
  'header.model': ChalkFunction;
  'chat.user': ChalkFunction;
  'chat.assistant': ChalkFunction;
  'chat.system': ChalkFunction;
  'chat.timestamp': ChalkFunction;
  'tool.running': ChalkFunction;
  'tool.success': ChalkFunction;
  'tool.failed': ChalkFunction;
  'tool.name': ChalkFunction;
  'sidebar.background': ChalkFunction;
  'sidebar.tab.active': ChalkFunction;
  'sidebar.tab.inactive': ChalkFunction;
  'status.model': ChalkFunction;
  'status.tokens': ChalkFunction;
  'status.duration': ChalkFunction;
  'input.prompt': ChalkFunction;
  'input.text': ChalkFunction;
  'input.steer': ChalkFunction;
  'diff.added': ChalkFunction;
  'diff.removed': ChalkFunction;
  'diff.context': ChalkFunction;
  'overlay.background': ChalkFunction;
  'overlay.border': ChalkFunction;
  'overlay.selected': ChalkFunction;
  'error.text': ChalkFunction;
  'warning.text': ChalkFunction;
}
```

## 6. Keyboard & Input System

### 6.1 Unified Keybinding Manager

```typescript
interface Keybinding {
  key: string;          // e.g. 'ctrl+k', 'ctrl+shift+d'
  command: string;      // e.g. 'palette', 'toggleSidebar'
  when?: string;        // Context condition, e.g. 'inputFocused', 'overlayOpen'
  description: string;
}

class KeybindingManager {
  private bindings: Keybinding[] = [];
  private context: Set<string> = new Set();

  register(binding: Keybinding): void;
  resolve(key: KeypressEvent): string | null;
  setContext(ctx: string): void;
  clearContext(ctx: string): void;
  getHelpText(): string; // For /help display
}
```

### 6.2 Default Keybindings

| Key | Command | Context |
|-----|---------|---------|
| `Ctrl+K` | `palette` | always |
| `Ctrl+I` | `steer` | idle/streaming |
| `Ctrl+L` | `clear` | always |
| `Ctrl+C` | `cancel` | streaming |
| `Ctrl+D` | `exit` | idle (empty input) |
| `Ctrl+T` | `toggleSidebar` | always |
| `Ctrl+Shift+D` | `toggleDiff` | has pending diffs |
| `Escape` | `closeOverlay` | overlay open |
| `Up/Down` | `history/inputNav` | input focused |
| `Tab` | `autocomplete` | input focused |

## 7. Structured Output Mode

### 7.1 JSON Event Stream

For IDE integration and testing, support `--json` mode:

```typescript
interface JSONEventStream {
  write(event: AgentEvent | StreamEvent): void;
  // Each event is a single JSON line (NDJSON)
  // Format: {"type":"agent:text_delta","text":"hello","timestamp":1234}
}

// In main.ts:
// --json flag enables JSONEventStream instead of App
// --json-pretty enables formatted JSON for debugging
```

### 7.2 Bridge Protocol

```typescript
interface BridgeMessage {
  type: 'event' | 'command' | 'response';
  payload: AgentEvent | StreamEvent | BridgeCommand | BridgeResponse;
  sessionId: string;
  sequence: number;
}
```

## 8. Accessibility & Responsive Design

### 8.1 Terminal Size Handling

- `< 60 cols`: Minimal mode -- input + output only, no sidebar, no header
- `60-79 cols`: Compact mode -- collapsed sidebar (icon-only), condensed status
- `80-119 cols`: Standard mode -- sidebar + main, full status bar
- `120+ cols`: Wide mode -- three-column layout option

### 8.2 Non-TTY Mode

- `--bare` flag: Plain text output, no ANSI, no cursor control
- Pipe detection: Auto-detect `!isTTY` and switch to streaming line-by-line output
- JSON mode: NDJSON event stream (see 7.1)

## 9. Performance Requirements

| Metric | Target | Current |
|--------|--------|---------|
| Render latency (idle) | < 5ms | ~2ms |
| Render latency (streaming) | < 16ms (60fps) | ~16ms (throttled) |
| First paint after startup | < 200ms | ~300ms |
| Memory (1000 messages) | < 50MB | ~30MB (VirtualScroller) |
| Event dispatch latency | < 1ms | ~0.5ms |

## 10. Testing Strategy

- **Component tests**: Each component renders to string snapshot, verified against expected output
- **Event pipeline tests**: Mock events through middleware chain, verify transformations
- **Overlay tests**: Simulate keypress sequences, verify overlay stack behavior
- **Theme tests**: Render each component with each theme, verify no hardcoded colors leak
- **Integration tests**: Full render cycle with MockLLMClient, verify end-to-end output
- **Visual regression**: Capture terminal output as text snapshots, diff on change
