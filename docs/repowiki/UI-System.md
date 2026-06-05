# UI System

Terminal UI with multi-panel layout, overlay system, theme engine, and mouse support.

## Architecture

```
src/ui/
├── components/          # UI components
│   ├── App.ts           # Root component
│   ├── ChatViewport.ts  # Virtual-scrolling chat display
│   ├── ChatView.ts      # Individual message rendering
│   ├── InputBox.ts      # User input with history
│   ├── Sidebar.ts       # Tools/Files/Tasks/Memory panels
│   ├── Header.ts        # Top bar with model info
│   ├── StatusBar.ts     # Bottom status (tokens, turns, mode)
│   ├── CommandPalette.ts # Fuzzy-search command launcher
│   ├── ModelSelector.ts # Provider/model switcher
│   ├── PermissionDialog.ts # Permission prompt overlay
│   ├── HelpPanel.ts     # Help overlay
│   ├── ThinkingChainView.ts # Reasoning chain display
│   ├── ThinkingIndicator.ts # Thinking animation
│   └── ToolCallCard.ts  # Tool execution display card
├── overlays/            # Overlay panel system
│   ├── CommandPaletteOverlay.ts
│   ├── DiffPreviewOverlay.ts
│   ├── HelpPanelOverlay.ts
│   ├── ModelSelectorOverlay.ts
│   └── PermissionDialogOverlay.ts
├── middleware/           # Event processing pipeline
│   ├── bridge.ts        # UI ↔ QueryEngine bridge
│   ├── budget.ts        # Budget display
│   ├── log.ts           # Event logging
│   └── plugin.ts        # Plugin UI hooks
├── layout.ts            # Multi-panel layout manager
├── theme.ts             # Theme engine (5 themes)
├── mouse.ts             # SGR mouse event handler
├── overlay-manager.ts   # Overlay lifecycle
├── event-bus.ts         # UI event routing
├── keybinding-manager.ts # Keyboard shortcut management
├── keypress.ts          # Key event parsing
├── spinner.ts           # Loading animations
├── statusline.ts        # Status line rendering
├── virtual-scroll.ts    # Virtual scrolling engine
├── diff-viewer.ts       # Multi-file diff display
├── formatter.ts         # Text formatting utilities
├── bridge-protocol.ts   # UI ↔ Engine protocol types
├── renderer.ts          # Terminal renderer
└── index.ts             # Module entry
```

## Layout System

`src/ui/layout.ts` -- `LayoutManager`:

### Layout Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `sidebar-main` | Sidebar left, chat right | Default wide terminals |
| `main-only` | Chat fills entire width | Narrow terminals |
| `main-bottom` | Chat bottom, panels top | Split workflow |
| `three-column` | Sidebar, chat, detail | Code review |

### Responsive Breakpoints

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| `tiny` | 0+ | Minimal UI, no sidebar |
| `compact` | 60+ | Collapsed sidebar |
| `standard` | 80+ | Full sidebar |
| `wide` | 120+ | Three-column available |

### Panel Management

- Resize: Drag panel borders (mouse) or keyboard shortcuts
- Toggle: `/sidebar [module]` command
- Min/max constraints per panel
- Auto-fold sidebar on narrow terminals

## Theme System

`src/ui/theme.ts` -- 5 built-in themes:

| Theme | Base | Accent |
|-------|------|--------|
| `default` | Dark | Blue |
| `monokai` | Dark | Orange/Green |
| `solarized` | Dark | Cyan/Yellow |
| `dracula` | Dark | Purple/Pink |
| `nord` | Dark | Frost blue |

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

## Overlay System

`src/ui/overlay-manager.ts`:

Overlays are modal panels rendered on top of the main UI:

```
┌────────────────────────────┐
│        Main UI             │
│  ┌──────────────────────┐  │
│  │     Overlay          │  │
│  │  (centered/floating) │  │
│  └──────────────────────┘  │
│                            │
└────────────────────────────┘
```

- **CommandPalette**: Ctrl+P, fuzzy search all commands
- **DiffPreview**: `/diff` command, multi-file diff viewer
- **HelpPanel**: `/help` command, searchable help
- **ModelSelector**: `/model` command, provider/model switcher
- **PermissionDialog**: Automatic on permission decisions

## Mouse Support

`src/ui/mouse.ts` -- `MouseHandler`:

SGR-encoded mouse event parsing:
- **Click**: Select items, focus panels, trigger actions
- **Scroll**: Navigate chat history, scroll overlays
- **Drag**: Resize panels, select text
- **Right-click**: Context menus (where applicable)

Enables via terminal escape sequences: `\x1b[?1000h` (basic), `\x1b[?1006h` (SGR)

## Virtual Scrolling

`src/ui/virtual-scroll.ts`:

For long conversations (>100 messages):
- Only renders visible messages + buffer
- Maintains scroll position during updates
- Smooth scrolling with momentum
- Memory-efficient: off-screen messages are not rendered

## Diff Viewer

`src/ui/diff-viewer.ts`:

Multi-file diff display:
- Color-coded additions (green) / deletions (red)
- Unified diff format
- `/accept` / `/reject` commands for file changes
- Syntax highlighting via highlight.js

## Event Pipeline

Events flow through middleware before reaching components:

```
QueryEngine events
  → bridge.ts (format for UI)
  → budget.ts (add budget info)
  → log.ts (log events)
  → plugin.ts (plugin UI hooks)
  → event-bus.ts (route to components)
  → components (render)
```

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
| `Escape` | Close overlay |
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
