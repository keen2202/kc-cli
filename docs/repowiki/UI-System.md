# UI System

Terminal UI built on ink (React) with Yoga flexbox layout, a focus-stack dialog system, theme engine, and keyboard-first interaction.

## Architecture

```
src/ui/
├── components/          # ink/React components
│   ├── AppRoot.tsx      # Root application component
│   ├── Layout.tsx       # Yoga (flexbox) layout composition
│   ├── ChatPanel.tsx    # Chat panel (messages + input)
│   ├── ChatMessagesView.tsx # Message list rendering
│   ├── Editor.tsx       # Input editor
│   ├── HeaderBar.tsx    # Top bar with model info
│   ├── StatusBarView.tsx # Bottom status (tokens, turns, mode)
│   ├── SidebarPanel.tsx # Tools/Files/Tasks/Memory panels
│   ├── CommandPalette.tsx # Fuzzy-search command launcher
│   ├── DiffPreview.tsx  # Pending file diff preview
│   ├── PermissionDialog.tsx # Permission prompt dialog
│   ├── ThinkingChainView.ts # Reasoning chain display
│   ├── ToolCallCard.ts  # Tool execution display card
│   └── slash-commands.ts # Slash command normalization (incl. Chinese aliases)
├── dialogs/
│   └── FilePicker.tsx   # File picker dialog
├── hooks/               # useKeybindings, useFocusLayer, useVirtualScroll, useStreamingEvents, …
├── focus-stack.ts       # Focus layer stack — single arbiter of ESC semantics
├── keybinding-manager.ts # Keyboard shortcut schema and dispatch
├── keypress.ts          # Key event parsing
├── event-bus.ts         # UI event routing
├── event-normalizer.ts  # Agent event → view event normalization
├── session-mapper.ts    # Session state → view model mapping
├── view-protocol.ts     # UI data contracts (single source of truth)
├── bridge-protocol.ts   # UI ↔ Engine protocol types
├── layout.ts            # Layout policy (breakpoints; Yoga owns measurement)
├── theme.ts             # Theme engine (8 themes)
├── spinner.ts           # Loading animations
├── statusline.ts        # Status line rendering
├── diff-viewer.ts       # Multi-file diff display
├── formatter.ts         # Text formatting utilities
├── format-duration.ts   # Duration formatting
├── renderer.tsx         # ink renderer entry
└── index.ts             # Module entry
```

## Layout System

`src/ui/layout.ts` is policy-only: it defines responsive breakpoints and text-fitting helpers, while Yoga (ink flexbox) owns all measurement — no reserved-height constants or parent-computed child heights.

### Responsive Breakpoints

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| `tiny` | 0+ | No sidebar, no header |
| `compact` | 60+ | Header visible, no sidebar |
| `standard` | 80+ | Sidebar + header visible |
| `wide` | 120+ | Wide density, sidebar + header |

### Panel Management

- Toggle: `/sidebar [module]` command
- Auto-fold sidebar on narrow terminals (breakpoint-driven)

## Theme System

`src/ui/theme.ts` -- 8 built-in themes (default: `tokyonight`):

| Theme | Base |
|-------|------|
| `dark` | Dark |
| `light` | Light |
| `solarized-dark` | Dark |
| `monokai` | Dark |
| `dracula` | Dark |
| `catppuccin` | Dark |
| `gruvbox` | Dark |
| `tokyonight` | Dark (default) |

Theme structure:
```typescript
interface Theme {
  name: string;
  colors: {
    background: string;
    foreground: string;
    accent: string;
    error: string;
    warning: string;
    success: string;
    muted: string;
    border: string;
  };
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
  };
}
```

## Focus & Dialog System

`src/ui/focus-stack.ts`:

Dialogs (command palette, diff preview, permission dialog, file picker) are rendered on top of the main UI and managed by a focus layer stack. The focus stack is the **single arbiter of ESC semantics** — pressing ESC pops the top layer; components register layers via `useFocusLayer` and never bind `escape` in the keybinding schema.

```
┌────────────────────────────┐
│        Main UI             │
│  ┌──────────────────────┐  │
│  │     Dialog           │  │
│  │  (top focus layer)   │  │
│  └──────────────────────┘  │
│                            │
└────────────────────────────┘
```

- **CommandPalette**: fuzzy search all commands
- **DiffPreview**: `/diff` command, multi-file diff viewer
- **PermissionDialog**: automatic on permission decisions
- **FilePicker**: file selection dialog

## Virtual Scrolling

`src/ui/hooks/useVirtualScroll.ts`:

For long conversations:
- Only renders visible messages + buffer
- Maintains scroll position during updates
- Memory-efficient: off-screen messages are not rendered

## Diff Viewer

`src/ui/diff-viewer.ts`:

Multi-file diff display:
- Color-coded additions (green) / deletions (red)
- Unified diff format
- `/accept` / `/reject` commands for file changes
- Syntax highlighting via highlight.js

## Event Pipeline

Agent events are normalized into view events before reaching components:

```
QueryEngine events
  → event-normalizer.ts (agent event → view event)
  → session-mapper.ts (session state → view model)
  → event-bus.ts (route to components)
  → components (render via ink)
```

Data contracts live in `src/ui/view-protocol.ts` only — components never define their own contracts.

## Keybindings

`src/ui/keybinding-manager.ts`:

| Key | Action |
|-----|--------|
| `Ctrl+C` | Cancel current operation |
| `Ctrl+I` | Toggle steer mode |
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Clear screen |
| `Up/Down` | History navigation |
| `Tab` | Autocomplete |
| `Escape` | Close top focus layer (handled by focus-stack, never bound in keybinding schema) |
| `Enter` | Submit input |
| `Shift+Enter` | Newline in input |

## Status Line

`src/ui/statusline.ts`:

Displays:
- Current model and provider
- Token usage (session / budget)
- Turn count
- Permission mode
- Active tools
- Sandbox status
