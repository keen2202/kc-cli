# UI Guide

KC-CLI v2 features a redesigned terminal UI with sidebar, diff preview, command palette, and model selector.

## Layout

```
┌────────────┬──────────────────────────────────────────┐
│            │                                          │
│  Sidebar   │          Main Chat Area                 │
│            │                                          │
│  [Tools]   │  User: Find all TODO comments           │
│  [Files]   │                                          │
│  [Tasks]   │  Agent: I'll search for TODO comments   │
│  [Memory]  │  using GrepTool...                       │
│            │                                          │
│            │  > GrepTool: pattern="TODO"              │
│            │  Found 12 matches in 5 files             │
│            │                                          │
│            │  Here are the results...                 │
│            │                                          │
├────────────┴──────────────────────────────────────────┤
│ Input: _                                              │
└───────────────────────────────────────────────────────┘
```

## Slash Commands

### Existing Commands (v1)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation |
| `/mode <mode>` | Set permission mode |
| `/tools` | List available tools |
| `/status` | Show current status |
| `/exit` | Exit KC-CLI |

### New in v2

| Command | Description |
|---------|-------------|
| `/palette` | Open command palette with fuzzy search |
| `/model` | Open interactive model selector |
| `/sidebar` | Toggle sidebar visibility |
| `/sidebar <module>` | Switch sidebar module (tools/files/tasks/memory) |
| `/diff` | Show pending file diffs |
| `/accept` | Accept pending file changes |
| `/reject` | Reject pending file changes |
| `/permission` | Show current permission mode |
| `/permission <mode>` | Switch permission mode |

## Sidebar

The sidebar has four modules, switchable with `/sidebar <module>`:

### Tools Module
Lists all available tools with their status (enabled/disabled).

### Files Module
File tree of the current working directory:
- Recursive expand/collapse
- LSP diagnostic markers:
  - 🔴 Red ⚠ — errors
  - 🟡 Yellow — warnings
- Keyboard navigation: ↑↓ to move, Enter to open preview
- Respects `.gitignore` exclusions

### Tasks Module
Shows active tasks and their progress.

### Memory Module
Browses persistent memory files with type indicators.

## Diff Preview

When a tool modifies a file (FileWrite, FileEdit), a diff preview automatically appears:

```
┌─── Diff: src/main.ts ───────────────────────────────┐
│  @@ -10,5 +10,8 @@                                  │
│   function greet(name: string) {                     │
│ -   console.log("Hello " + name);                    │
│ +   console.log(`Hello, ${name}!`);                  │
│ +   return true;                                     │
│   }                                                  │
│                                                      │
│  [Tab 1/2] src/main.ts  src/utils.ts                │
│                                                      │
│  /accept — Apply changes   /reject — Discard changes │
└──────────────────────────────────────────────────────┘
```

Features:
- **Color-coded**: Green for additions, red for deletions, gray for context
- **Multi-file tabs**: Tab through multiple changed files
- **Accept/Reject**: `/accept` applies changes, `/reject` discards them
- **Auto-popup**: Appears automatically after file modifications

## Command Palette

Open with `/palette` or Ctrl+P:

```
┌─── Command Palette ──────────────────────────────────┐
│  > mod                                              │
│                                                      │
│  📋 model    — Switch LLM model                     │
│  📋 mode     — Set permission mode                  │
│  📋 clear    — Clear conversation                   │
│                                                      │
│  ↑↓ Navigate   Enter Select   Esc Cancel            │
└──────────────────────────────────────────────────────┘
```

Features:
- **Fuzzy search**: Type to filter commands
- **Keyboard navigation**: ↑↓ to move, Enter to select, Esc to cancel
- **Command execution**: Selected commands execute immediately

## Model Selector

Open with `/model`:

```
┌─── Select Provider ──────────────────────────────────┐
│                                                      │
│  ▸ DeepSeek                                          │
│    Anthropic                                         │
│    OpenAI                                            │
│    Qwen (DashScope)                                  │
│    GLM (Zhipu AI)                                    │
│    OpenAI Compatible                                 │
│    Ollama (local)                                    │
│                                                      │
│  ↑↓ Navigate   Enter Select   Esc Cancel            │
└──────────────────────────────────────────────────────┘

┌─── Select Model ─────────────────────────────────────┐
│                                                      │
│  ▸ deepseek-chat        (128K context)              │
│    deepseek-coder       (128K context)              │
│    deepseek-reasoner    (128K context)              │
│                                                      │
│  ↑↓ Navigate   Enter Select   Esc Cancel            │
└──────────────────────────────────────────────────────┘
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open command palette |
| `Ctrl+L` | Clear screen |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+D` | Exit (when input is empty) |
| `↑` / `↓` | Navigate history (in input) / Navigate lists (in overlays) |
| `Enter` | Confirm / Select |
| `Esc` | Close overlay / Cancel |
| `Tab` | Switch between diff tabs |

## Performance

v2 includes several performance optimizations:
- **Streaming throttle**: 16ms/frame output for smooth rendering
- **Virtual scrolling**: Long conversations paginate automatically (>100 messages)
- **Diff worker**: File diff computation runs in `worker_threads`
- **Keyboard optimization**: Event handlers use `useInput` to avoid duplicate bindings
