# UI & Event System -- Task Breakdown

> Depends on: `ui-event-system-spec.md`
> Estimated total: 8 phases, ~40 tasks

---

## Phase 1: Foundation Layer (EventBus + Theme Wiring)

**Goal**: Build the event pipeline and wire the existing theme system. Everything else depends on this.

### T1.1 -- UIEventBus implementation
- **File**: `src/ui/event-bus.ts` (new)
- **What**: Implement `UIEventBus` class with `use(middleware)`, `on(type, handler)`, `emit(event)`. Middleware chain runs in order; listeners fire after all middlewares pass. Return unsubscribe from `on()`.
- **Acceptance**: Unit test with 3 middlewares (log, transform, block) + 2 listeners, verify ordering and block behavior.

### T1.2 -- Theme token map definition
- **File**: `src/ui/theme.ts` (modify)
- **What**: Define `ThemeTokens` interface covering all 27 tokens from spec section 5.2. Add `resolve(tokens: ThemeTokens)` method to each existing Theme object. Map existing theme color arrays to the token names.
- **Acceptance**: `theme.resolve().chat.user` returns a chalk function for each of the 5 themes.

### T1.3 -- Theme injection into component signatures
- **Files**: All `src/ui/components/*.ts` files
- **What**: Add `theme: Theme` as the last parameter to every component render function (`renderChatView`, `renderStatusBar`, `renderSidebar`, `renderInputBox`, `renderToolCallCard`, `renderCommandPalette`, `renderModelSelector`). Update all call sites in `App.ts`.
- **Acceptance**: `tsc --noEmit` passes. No hardcoded `chalk.xxx` remains in component files -- all color calls go through `theme.resolve().xxx`.

### T1.4 -- Replace hardcoded chalk in ChatView
- **File**: `src/ui/components/ChatView.ts`
- **What**: Replace all `chalk.cyan`, `chalk.dim`, `chalk.green` etc. with theme token lookups. User message prefix uses `theme.resolve()['chat.user']`, assistant uses `chat.assistant`, system uses `chat.system`.
- **Acceptance**: Render ChatView with `dark` theme and `light` theme, verify different colors.

### T1.5 -- Replace hardcoded chalk in remaining components
- **Files**: `StatusBar.ts`, `Sidebar.ts`, `InputBox.ts`, `ToolCallCard.ts`, `CommandPalette.ts`, `ModelSelector.ts`
- **What**: Same as T1.4 but for all other components. Each file should have zero direct `chalk` color calls (only `chalk.bold`, `chalk.dim` decorators are acceptable if the theme doesn't cover emphasis).
- **Acceptance**: `grep -r "chalk\.\(cyan\|green\|red\|yellow\|blue\|magenta\|white\|gray\)" src/ui/components/` returns empty.

---

## Phase 2: Component Extraction

**Goal**: Break the monolithic App.ts into isolated, testable components.

### T2.1 -- Extract Header component
- **File**: `src/ui/components/Header.ts` (new)
- **What**: Extract `App.renderHeader()` into standalone `renderHeader(props: { model, provider, theme }): RenderResult`. Returns formatted banner lines.
- **Acceptance**: Unit test renders header with mock props, snapshot matches expected output.

### T2.2 -- Extract ChatViewport component
- **File**: `src/ui/components/ChatViewport.ts` (new)
- **What**: Extract message rendering area that integrates VirtualScroller. Props: `messages, scroller, width, height, theme`. Handles scroll offset calculation and visible range.
- **Acceptance**: Unit test with 200 messages, verify only visible range is rendered.

### T2.3 -- Extract ThinkingIndicator component
- **File**: `src/ui/components/ThinkingIndicator.ts` (new)
- **What**: Shows "Thinking..." with elapsed time counter. Props: `startTime, theme`. Updates every 100ms. Used when agent is in `streaming` state but no text delta yet.
- **Acceptance**: Renders "Thinking... 2.3s" after 2.3 seconds.

### T2.4 -- Extract PermissionDialog component
- **File**: `src/ui/components/PermissionDialog.ts` (new)
- **What**: Overlay that prompts user for tool permission. Shows tool name, input summary, and options (Allow Once / Allow Always / Deny). Props: `toolCall, rule, theme`. Handles Y/A/D keypresses.
- **Acceptance**: Renders dialog, keypress 'y' returns 'allow', 'a' returns 'allow_always', 'n' returns 'deny'.

### T2.5 -- Extract HelpPanel component
- **File**: `src/ui/components/HelpPanel.ts` (new)
- **What**: Overlay showing all slash commands and keybindings. Props: `commands[], keybindings[], theme`. Two-column layout.
- **Acceptance**: Renders all registered commands and keybindings in a scrollable panel.

### T2.6 -- Refactor App.ts to use extracted components
- **File**: `src/ui/components/App.ts`
- **What**: Replace inline rendering with calls to extracted components. App becomes an orchestrator: collects state, calls component render functions, composes the full screen. Remove all rendering logic that now lives in components.
- **Acceptance**: App.ts drops below 400 lines. All visual output is identical to before refactor.

---

## Phase 3: Overlay Manager

**Goal**: Unified overlay system replacing ad-hoc stdin switching.

### T3.1 -- OverlayManager implementation
- **File**: `src/ui/overlay-manager.ts` (new)
- **What**: Implement `OverlayManager` with `push()`, `pop()`, `has()`, `handleKeypress()`, `render()`. Overlays are stacked by zIndex. Keypress dispatches top-down; first overlay that returns `true` from `onKeypress` consumes the event.
- **Acceptance**: Unit test pushes 3 overlays, verifies keypress dispatch order and pop behavior.

### T3.2 -- Migrate CommandPalette to Overlay interface
- **File**: `src/ui/components/CommandPalette.ts`
- **What**: Wrap existing CommandPalette as an `Overlay` implementation. Implement `onKeypress()` to handle up/down/enter/escape.
- **Acceptance**: CommandPalette opens via OverlayManager.push(), navigates with arrows, selects with enter, closes with escape.

### T3.3 -- Migrate ModelSelector to Overlay interface
- **File**: `src/ui/components/ModelSelector.ts`
- **What**: Same as T3.2 but for ModelSelector.
- **Acceptance**: ModelSelector opens/closes via OverlayManager, provider/model selection works.

### T3.4 -- Migrate DiffPreview to Overlay interface
- **File**: `src/ui/diff-viewer.ts`
- **What**: Wrap `renderMultiFileDiff` as an Overlay. Handle tab switching between files and accept/reject keypresses.
- **Acceptance**: Diff overlay shows file tabs, left/right switches files, 'a' accepts, 'r' rejects.

### T3.5 -- Wire PermissionDialog as Overlay
- **File**: `src/ui/components/App.ts`
- **What**: When `agent:tool_permission_denied` event fires, push PermissionDialog overlay. On decision, resolve the permission promise and continue execution.
- **Acceptance**: Tool permission flow works end-to-end: event -> overlay -> user input -> resolution.

### T3.6 -- Wire HelpPanel as Overlay
- **File**: `src/ui/components/App.ts`
- **What**: `/help` command pushes HelpPanel overlay. Escape closes it.
- **Acceptance**: `/help` shows help panel, escape dismisses it.

### T3.7 -- Remove ad-hoc stdin switching from App.ts
- **File**: `src/ui/components/App.ts`
- **What**: Remove the manual `process.stdin.setRawMode()` calls and overlay-specific state variables. All overlay management goes through OverlayManager.
- **Acceptance**: No direct stdin mode manipulation in App.ts. All overlay behavior works as before.

---

## Phase 4: Event Pipeline Integration

**Goal**: Wire UIEventBus between QueryEngine and UI, add middleware.

### T4.1 -- Connect QueryEngine to UIEventBus
- **File**: `src/ui/components/App.ts`
- **What**: In the event consumption loop, instead of calling `this.handleEvent(event)` directly, emit through `this.eventBus.emit(event)`. The UI subscribes as a listener.
- **Acceptance**: All events still reach the UI. Event flow: QueryEngine -> UIEventBus.emit() -> middlewares -> UI listener.

### T4.2 -- Implement LogMiddleware
- **File**: `src/ui/middleware/log.ts` (new)
- **What**: Logs all events when verbose mode is on. Format: `[HH:MM:SS.mmm] event.type {key=data}`.
- **Acceptance**: With `--verbose`, all events appear in stderr log.

### T4.3 -- Implement BudgetMiddleware
- **File**: `src/ui/middleware/budget.ts` (new)
- **What**: Tracks cumulative tokens from `agent:turn_complete` events. Emits warning at 80% budget. Blocks further queries at 100%.
- **Acceptance**: After consuming 80% of budget, UI shows warning. At 100%, input is blocked with message.

### T4.4 -- Implement PluginMiddleware
- **File**: `src/ui/middleware/plugin.ts` (new)
- **What**: Routes events to registered plugin hooks (from spec 4.3). Plugins register via `PluginEventHooks` interface.
- **Acceptance**: Mock plugin receives `onToolStart` and `onToolComplete` events with correct data.

### T4.5 -- Implement BridgeMiddleware
- **File**: `src/ui/middleware/bridge.ts` (new)
- **What**: Forward events as NDJSON to stdout when `--json` flag is set. Each line is `{"type":"...","payload":{...},"timestamp":...}`.
- **Acceptance**: `kc --json -p "hello"` outputs valid NDJSON to stdout.

### T4.6 -- Remove direct handleEvent coupling
- **File**: `src/ui/components/App.ts`
- **What**: The old `handleEvent()` method becomes an internal handler registered on the event bus. Remove the direct call from the query loop.
- **Acceptance**: App.ts no longer directly processes events from the generator. All flow through event bus.

---

## Phase 5: Keyboard System

**Goal**: Unified keybinding manager replacing scattered keypress handling.

### T5.1 -- KeybindingManager implementation
- **File**: `src/ui/keybinding-manager.ts` (new)
- **What**: Implement `KeybindingManager` with `register()`, `resolve()`, `setContext()`, `clearContext()`, `getHelpText()`. Context-aware: same key can map to different commands depending on state.
- **Acceptance**: Unit test registers bindings with contexts, verifies correct resolution in different states.

### T5.2 -- Register default keybindings
- **File**: `src/ui/keybinding-manager.ts`
- **What**: Register all default keybindings from spec table (Ctrl+K, Ctrl+I, Ctrl+L, Ctrl+C, Ctrl+D, Ctrl+T, Ctrl+Shift+D, Escape, Up, Down, Tab).
- **Acceptance**: Each key resolves to correct command in correct context.

### T5.3 -- Wire KeybindingManager into App.ts
- **File**: `src/ui/components/App.ts`
- **What**: Replace the inline keypress switch/case with `keybindingManager.resolve(keypress)`. Dispatch resolved commands to a `executeCommand(command)` method.
- **Acceptance**: All existing keyboard shortcuts work as before. Help text from KeybindingManager matches actual behavior.

### T5.4 -- Add `/keybindings` command
- **File**: `src/ui/components/App.ts`
- **What**: New slash command that shows current keybindings in HelpPanel overlay.
- **Acceptance**: `/keybindings` shows all active bindings with their contexts.

---

## Phase 6: Responsive Layout

**Goal**: Adapt UI to terminal size changes.

### T6.1 -- Layout breakpoints implementation
- **File**: `src/ui/layout.ts` (modify)
- **What**: Define 4 breakpoints (tiny <60, compact 60-79, standard 80-119, wide 120+). Each breakpoint defines: sidebar visibility, header visibility, status bar density, chat area proportions.
- **Acceptance**: Resizing terminal triggers layout recalculation. Sidebar auto-hides below 80 cols.

### T6.2 -- Responsive component rendering
- **Files**: All components
- **What**: Components accept `density: 'compact' | 'normal' | 'wide'` prop and adjust output accordingly. StatusBar in compact mode shows only model + tokens. Sidebar in compact mode shows icons only.
- **Acceptance**: At 60 cols, UI is usable without horizontal scrolling.

### T6.3 -- Terminal resize event handling
- **File**: `src/ui/components/App.ts`
- **What**: Listen for `process.stdout.on('resize')`. Debounce at 100ms. Recalculate layout, invalidate VirtualScroller viewport, trigger re-render.
- **Acceptance**: Resizing terminal mid-conversation preserves scroll position and message history.

---

## Phase 7: Structured Output & Bridge

**Goal**: JSON event stream for IDE integration and testing.

### T7.1 -- JSON output mode
- **File**: `src/main.ts` (modify)
- **What**: Add `--json` CLI flag. When set, skip App initialization. Instead, pipe QueryEngine events through BridgeMiddleware to stdout as NDJSON. Input comes from stdin line-by-line.
- **Acceptance**: `echo "hello" | kc --json` outputs valid NDJSON lines.

### T7.2 -- JSON pretty mode
- **File**: `src/main.ts`
- **What**: Add `--json-pretty` flag. Same as --json but with `JSON.stringify(event, null, 2)` formatting. Useful for debugging.
- **Acceptance**: Output is valid, formatted JSON.

### T7.3 -- Bridge message protocol
- **File**: `src/ui/bridge-protocol.ts` (new)
- **What**: Define `BridgeMessage` type wrapping events with session ID and sequence number. Implement `createBridgeWriter()` that handles framing and buffering.
- **Acceptance**: Messages include session ID, monotonically increasing sequence numbers.

### T7.4 -- Integration test: JSON mode
- **File**: `test/ui/json-mode.test.ts` (new)
- **What**: End-to-end test: start kc in JSON mode with MockLLMClient, send a prompt, verify event sequence in output (text_delta -> turn_complete -> complete).
- **Acceptance**: Test passes, event sequence matches expected pattern.

---

## Phase 8: Testing & Polish

**Goal**: Full test coverage and cleanup.

### T8.1 -- Component snapshot tests
- **File**: `test/ui/components/*.test.ts` (new, one per component)
- **What**: For each component, render with known inputs and snapshot the string output. Test with at least 2 themes.
- **Acceptance**: All components have snapshot tests. `npm test` passes.

### T8.2 -- Event pipeline integration tests
- **File**: `test/ui/event-pipeline.test.ts` (new)
- **What**: Test full pipeline: emit events through UIEventBus with all middlewares, verify final state. Test middleware ordering, blocking, and error recovery.
- **Acceptance**: 100% middleware branch coverage.

### T8.3 -- Overlay interaction tests
- **File**: `test/ui/overlay.test.ts` (new)
- **What**: Simulate keypress sequences through OverlayManager. Test: open palette -> type search -> select -> verify result. Open permission dialog -> press deny -> verify denial.
- **Acceptance**: All overlay flows have happy-path and escape-path tests.

### T8.4 -- Theme consistency audit
- **File**: N/A (verification task)
- **What**: `grep` for any remaining hardcoded chalk color calls in `src/ui/`. Fix any found.
- **Acceptance**: Zero hardcoded chalk color calls outside of `theme.ts`.

### T8.5 -- Remove dead code
- **Files**: Various
- **What**: Remove `DiffPreview.tsx` (unused Ink component). Remove any unused imports. Clean up old overlay state variables from App.ts.
- **Acceptance**: `tsc --noEmit` passes. No unused exports detected.

### T8.6 -- Performance benchmark
- **File**: `test/ui/perf.test.ts` (new)
- **What**: Benchmark render cycle with 100, 500, 1000 messages. Measure render latency, memory usage. Assert against spec targets.
- **Acceptance**: All performance targets from spec section 9 are met.

---

## Dependency Graph

```
Phase 1 (Foundation)
  ├── T1.1 EventBus
  ├── T1.2 Theme tokens ──┐
  ├── T1.3 Theme inject ──┤
  ├── T1.4 ChatView theme ┤
  └── T1.5 All themes ────┘
         │
Phase 2 (Components) ──── depends on Phase 1
  ├── T2.1-T2.5 Extract
  └── T2.6 Refactor App
         │
Phase 3 (Overlays) ────── depends on Phase 2
  ├── T3.1 OverlayManager
  ├── T3.2-T3.4 Migrate
  └── T3.5-T3.7 Wire
         │
Phase 4 (Events) ──────── depends on Phase 1
  ├── T4.1 Connect bus
  ├── T4.2-T4.5 Middlewares
  └── T4.6 Decouple
         │
Phase 5 (Keyboard) ────── depends on Phase 3
  ├── T5.1-T5.2 Manager
  └── T5.3-T5.4 Wire
         │
Phase 6 (Responsive) ──── depends on Phase 2
  ├── T6.1 Breakpoints
  ├── T6.2 Components
  └── T6.3 Resize
         │
Phase 7 (JSON/Bridge) ─── depends on Phase 4
  ├── T7.1-T7.2 Modes
  ├── T7.3 Protocol
  └── T7.4 Test
         │
Phase 8 (Testing) ─────── depends on all above
  ├── T8.1-T8.3 Tests
  ├── T8.4-T8.5 Cleanup
  └── T8.6 Perf
```

## Parallel Work Opportunities

These can be done in parallel within each phase:

- **Phase 1**: T1.1 (EventBus) || T1.2-T1.5 (Theme wiring)
- **Phase 2**: T2.1-T2.5 (all extractions independent of each other)
- **Phase 3**: T3.2-T3.4 (all migrations independent)
- **Phase 4**: T4.2-T4.5 (all middlewares independent)
- **Phase 6**: T6.1 || T6.2

## Estimated Effort

| Phase | Tasks | Effort |
|-------|-------|--------|
| 1. Foundation | 5 | 2 days |
| 2. Components | 6 | 3 days |
| 3. Overlays | 7 | 2 days |
| 4. Events | 6 | 2 days |
| 5. Keyboard | 4 | 1 day |
| 6. Responsive | 3 | 1 day |
| 7. Bridge | 4 | 1.5 days |
| 8. Testing | 6 | 2 days |
| **Total** | **41** | **~14.5 days** |
