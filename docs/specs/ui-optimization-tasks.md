# kc-cli UI Optimization Task Breakdown

> Generated: 2026-07-19 | Based on `docs/specs/ui-optimization-spec.md` v1.0
> Total Tasks: 14 | Phases: 3 | Source Review: `UI_REVIEW_2026-07-19.md`

---

## Task Dependency Graph

```
Phase 1 (P0 — 基础与安全闸门):
  T0 Theme Color Bridge ──┬──> T1 权限闸门(H1a) ──> T2 Diff 审阅(H1b)
                          ├──> T5 颜色收敛(M4)
                          └──> T10 边框统一(L1)
  T3 Provider/Model 单一源(H3) ──> T11 mode 语义(L2)

Phase 2 (P1 — 交互与一致性):
  T4 Keybinding Resolver(H2) ──> T6 附件/文件链路(M2)
  T7 窄终端截断(M1) ──> T12 tiny 降级(L3)

Phase 3 (P2 — 布局预算与清理):
  T8 侧栏高度预算(M3) ──> T13 聊天区最小行(L4)
  T1 + T2 + T4 + T6 ──> T9 死代码清理(M5)
```

依赖说明：
- **T0** 是 M4/H1/L1 的根因基础（暴露 hex 主题色给 ink），阻塞 T1/T2/T5/T10。
- **T9**（死代码清理）必须在"接通 vs 删除"决策完成后进行，故被 T1/T2/T4/T6 阻塞。

---

## Phase 1: 基础与安全闸门（P0）

### Task T0: Implement Theme Color Bridge for Ink Components

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Implement a theme color bridge exposing hex palette to Ink components
- **Subject (continuous):** Implementing a theme color bridge exposing hex palette to Ink components
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.0.1
- **Dependencies:**
  - blockedBy: none
  - blocks: T1, T2, T5, T10
- **Checklist:**
  - [x] 在 `ThemeContextValue` 新增 `colors: ThemeColors` 字段（`useTheme.tsx:19`）
  - [x] `ThemeProvider` 的 `value` 中注入 `colors: theme.colors`（`useTheme.tsx:31`）
  - [x] 确认 `ThemeColors` 已从 `theme.ts` 导出（`useTheme.tsx:8` 导入使用）；`overlayBackground` 复用 `colors.background`
  - [x] 主题色单测：`test/ui/app-integration.test.ts` 断言 8 套主题存在且 `colors.primary` 有效
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/hooks/useTheme.tsx`
  - MODIFY: `src/ui/theme.ts`（确认导出/补充字段）
  - NEW/MODIFY: `test/ui/useTheme.test.tsx`

---

### Task T1: Wire Permission Confirmation Gate into Active UI Path

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Wire the PermissionDialog into the AppRoot overlay and permission flow
- **Subject (continuous):** Wiring the PermissionDialog into the AppRoot overlay and permission flow
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.0.2（对应 H1a）
- **Dependencies:**
  - blockedBy: T0
  - blocks: T2, T9
- **Checklist:**
  - [x] 在 `AppRoot` 新增 `permissionRequest` 状态与 `setPermissionRequest`（`AppRoot.tsx:181`）
  - [x] 打通 `permissions` 授权判定 → UI 回调：`queryEngine.setPermissionRequestHandler` 构造 `PermissionRequest`（`AppRoot.tsx:205-220`，`toolExecutor.ts:297-320`）
  - [x] `overlay` 挂载 `PermissionDialog`（与 palette/filePicker/`ExitConfirmDialog` 串联，`AppRoot.tsx:662-675`）
  - [x] 工具执行**前**阻塞；`onDecide('deny')` 中止调用（`toolExecutor.ts:307-314` 返回 `isError`）
  - [x] `allow_always` 写入会话级白名单（`toolExecutor.ts:315-317 addSessionAllowRule`）；`acceptEdits` 写操作自动放行（`:300`）；`bypassPermissions` 经 `checkPermission` 直接 allow 不弹窗
  - [x] 复用 `sidebarData.tools` 展示执行中工具（`SidebarPanel` Tools 区）
  - [x] 权限流集成测试：`test/executors/toolExecutor-permission.test.ts`（ask 阻塞 / Deny 中止 / allow_always 执行）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/AppRoot.tsx`（overlay + 状态 + 回调）
  - MODIFY: `src/ui/components/PermissionDialog.tsx`（走 theme colors）
  - 关联: `src/permissions/engine.ts`, `src/permissions/interaction.ts`, `src/executors/toolExecutor.ts`
  - NEW: `test/ui/permission-flow.test.tsx`

---

### Task T2: Wire Diff Review into the Approval Flow

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Wire the DiffPreview into the write-tool approval flow
- **Subject (continuous):** Wiring the DiffPreview into the write-tool approval flow
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.0.3（对应 H1b）
- **Dependencies:**
  - blockedBy: T0, T1
  - blocks: T9
- **Checklist:**
  - [x] 将待写文件 `FilePatchPreview[]` 经 `toolExecutor.buildDiffPreview` 传入 `PermissionDialog` → `DiffPreview`（`PermissionDialog.tsx:51-86`）
  - [x] 形成"审阅 → 授权"联动：diff 内联展示后 `[Y]Accept` / `[N/R]Reject`（`PermissionDialog.tsx:42-93`，`showActions={false}` 由弹窗托管按键）
  - [x] `edit`/`write` 类工具在 `acceptEdits` 以下模式先经 diff 审阅（`toolExecutor.ts:298-306`）
  - [x] 复用 `src/ui/diff-viewer.ts` 的 `computeDiff`（`DiffPreview.tsx:3,92,114`）
  - [x] Reject 中止不落盘（deny 分支返回 isError，工具不执行）；Accept 后正常写入
  - [x] diff 审阅测试：`test/ui/diff-preview.test.ts`
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/AppRoot.tsx`（挂载 + diff 状态）
  - MODIFY: `src/ui/components/DiffPreview.tsx`（theme colors + ink 边框）
  - 关联: `src/ui/diff-viewer.ts`, 写类工具执行路径
  - NEW: `test/ui/diff-review.test.tsx`

---

### Task T3: Consolidate Provider/Model to a Single Source of Truth

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Consolidate the duplicated Provider/Model info into a single source
- **Subject (continuous):** Consolidating the duplicated Provider/Model info into a single source
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.0.4（对应 H3）
- **Dependencies:**
  - blockedBy: none
  - blocks: T11
- **Checklist:**
  - [x] 从 `SessionInfo` 移除 Model / Provider 两行及对应 props（`SessionInfo.tsx:4-9,29-30`）
  - [x] `AppRoot` 的 `<SessionInfo>` 不再传 provider/model（`AppRoot.tsx:643-650`）
  - [x] 顶栏保留 `kc v3.2 · provider/model · Build/Plan`（`HeaderBar.tsx:21`）
  - [x] 底栏 model 经 `abbreviateModel` 缩写（`StatusBarView.tsx:39`）
  - [x] `SessionInfo` 单测（`test/ui/components.test.ts`）不含 provider/model
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/SessionInfo.tsx`
  - MODIFY: `src/ui/components/AppRoot.tsx`
  - 可选 MODIFY: `src/ui/components/StatusBarView.tsx`

---

## Phase 2: 交互与一致性（P1）

### Task T4: Wire the Keybinding Resolver and Dispatch Commands

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Wire useInput through the keybinding resolver and dispatch commands
- **Subject (continuous):** Wiring useInput through the keybinding resolver and dispatching commands
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.1.1（对应 H2）
- **Dependencies:**
  - blockedBy: none
  - blocks: T6, T9
- **Checklist:**
  - [x] `useInput` 内将 ink 按键转 `KeypressEvent` 并 `keybindingManager.resolve(event)`（`AppRoot.tsx:132-145,511-518`）
  - [x] 建立 command → handler map（`dispatchCommand`：palette/newSession/filePicker/toggleSidebar/help/historyPrev/historyNext… `AppRoot.tsx:467-504`）
  - [x] 用 `setContext('input'|'idle'|'streaming'|'overlay'|'delete-mode')` 使 `when` 生效（`AppRoot.tsx:224-234`）
  - [x] 移除与 schema 重复的硬编码分支（仅对控制键走 resolver，普通字符直插，`AppRoot.tsx:513-532`）
  - [x] `?` 显示 `getHelpText()`（`AppRoot.tsx:492`）；`ctrl+k/f/t`、`up/down` 实际生效（ctrl+o/s 已移除：无背向 UI，避免断言失效，`keybinding-manager.ts:83-85`）
  - [x] resolver 单测：`test/ui/keybinding-resolver.test.ts`
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/AppRoot.tsx`
  - MODIFY: `src/ui/hooks/useKeybindings.ts`
  - 关联: `src/ui/keybinding-manager.ts`, `src/ui/keypress.ts`
  - NEW: `test/ui/keybinding-resolver.test.tsx`

---

### Task T5: Converge Hardcoded Colors onto Theme Tokens

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Converge hardcoded colors in Ink components onto theme tokens
- **Subject (continuous):** Converging hardcoded colors in Ink components onto theme tokens
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.1.2（对应 M4）
- **Dependencies:**
  - blockedBy: T0
  - blocks: none
- **Checklist:**
  - [x] `SidebarPanel` 状态色映射改用 `colors.success/error/warning/muted/primary`（`SidebarPanel.tsx:24-64`）
  - [x] `DiffPreview` add/remove/context 改用 `colors.success/error/muted`（`DiffPreview.tsx:54-61`）
  - [x] `PermissionDialog` 边框/标题/按钮改用 `colors.*`（`PermissionDialog.tsx:63-93`）
  - [x] `ExitConfirmDialog` + `ErrorBar` 背景/边框改用 `colors.background/error`（`AppRoot.tsx:56-118`）
  - [x] grep 确认无 `color="green"|color="red"|#1a1b26` 字面残留（`#1a1b26` 仅作为 `theme.ts` 调色板定义）
  - [x] 8 套主题切换颜色一致响应（经 `useTheme().colors` 驱动）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/SidebarPanel.tsx`
  - MODIFY: `src/ui/components/DiffPreview.tsx`
  - MODIFY: `src/ui/components/PermissionDialog.tsx`
  - MODIFY: `src/ui/components/AppRoot.tsx`（ExitConfirmDialog + ErrorBar）

---

### Task T6: Connect Attachment / File Picker Pipeline (or Hide It)

- **Status:** `complete` ✅ (verified 2026-07-19 — 采用“接通”方案)
- **Subject (imperative):** Connect the @-file autocomplete and FilePicker pipeline
- **Subject (continuous):** Connecting the @-file autocomplete and FilePicker pipeline
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.1.3（对应 M2）
- **Dependencies:**
  - blockedBy: T4
  - blocks: T9
- **Checklist:**
  - [x] 决策：接通 `@`/`ctrl+f` → `FilePicker`（`AppRoot.tsx:551-554,479`）
  - [x] 选中文件加入 `attachmentState.attachments`（`onFileSelect` `AppRoot.tsx:412-420`），删除模式生效（`:534-548`）
  - [x] `ctrl+f` 经 T4 resolver 打开 `FilePicker`（`keybinding-manager.ts:88` → `dispatchCommand 'filePicker'`）
  - [x] 附件 UI 与真实能力一致（`Editor.tsx:111-127` 计数/删除与实际添加入口对应）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/AppRoot.tsx`（`@`/`ctrl+f` 分支 + 附件状态）
  - MODIFY: `src/ui/dialogs/FilePicker.tsx`
  - MODIFY: `src/ui/components/Editor.tsx`（附件 UI 显隐）

---

### Task T7: Add Width-Aware Truncation to HeaderBar/StatusBar

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Add width-aware truncation to HeaderBar and StatusBar
- **Subject (continuous):** Adding width-aware truncation to HeaderBar and StatusBar
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.1.4（对应 M1）
- **Dependencies:**
  - blockedBy: none
  - blocks: T12
- **Checklist:**
  - [x] 用 `useTerminalSize().width` 计算可用列宽并对超长内容 `truncate + …`（`HeaderBar.tsx:15-38`，`StatusBarView.tsx:32-61`）
  - [x] 长 model 名缩写工具 `abbreviateModel`（`layout.ts:46-55`：`claude-3-5-sonnet-20241022` → `c3.5-sonnet`）
  - [x] 单行不折行的截断逻辑已实现（`plain.length <= avail` 分支）
  - [x] `npm run typecheck` 与 `npm test` 通过
  - _建议（补强）：可为 `layout.ts:truncate/abbreviateModel` 补 40/60/80/120 列快照断言（当前 `test/ui/layout.test.ts` 未覆盖该矩阵）。_
- **Files:**
  - MODIFY: `src/ui/components/HeaderBar.tsx`
  - MODIFY: `src/ui/components/StatusBarView.tsx`
  - 可选 MODIFY: `src/ui/layout.ts`（model 缩写工具）

---

## Phase 3: 布局预算与清理收尾（P2）

### Task T8: Fix Sidebar Height Budget to Match Real Allocation

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Fix the sidebar height budget to use real allocated rows
- **Subject (continuous):** Fixing the sidebar height budget to use real allocated rows
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.1（对应 M3）
- **Dependencies:**
  - blockedBy: none
  - blocks: T13
- **Checklist:**
  - [x] `Layout` 计算并向 `SidebarPanel` 传入 `height = rowHeight - sessionInfoHeight`（`Layout.tsx` 经 `React.cloneElement` 注入 `height`/`width`）
  - [x] `AppRoot` 无需改动——`Layout` 内注入尺寸，`<SidebarPanel data={sidebarData} />` 保持不变
  - [x] 分区分配改为按各 section 实际数量加权（空 section 不占预算，`SidebarPanel.tsx` `activeSections`）
  - [x] 多 `(width,height)` 单测断言侧栏不溢出/不浪费空行（`test/ui/layout.test.ts` 34 例通过）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/Layout.tsx`
  - MODIFY: `src/ui/components/SidebarPanel.tsx`
- **✅ 实现说明：** `Layout.tsx` 计算 `sidebarHeight = contentHeight + editorHeight + errorBarHeight - sessionInfoHeight`，并用 `React.cloneElement` 将 `height`/`width` 注入 `sidebar` 元素（AppRoot 无需透传）。`SidebarPanel.tsx` 将均分 `budget/4` 改为按 `activeSections`（数量 >0 的 section）加权：`perSection = floor(budget / max(1, activeSections))`，空 section 不占用条目预算。

---

### Task T9: Remove or Deprecate Dead UI Code

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Remove or deprecate the dead UI dialogs and string renderers
- **Subject (continuous):** Removing or deprecating the dead UI dialogs and string renderers
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.2（对应 M5）
- **Dependencies:**
  - blockedBy: T1, T2, T4, T6
  - blocks: none
- **Checklist:**
  - [x] 标注 `Sidebar.ts` 的 `renderSidebar` 为 `@deprecated`（仍有单测覆盖，故保留但明确弃用）
  - [x] 标注 `ChatView.ts` 的 `renderChatMessage`/`renderChatView` 为 `@deprecated`（保留 `ChatMessage` 类型）
  - [x] 删除 `dialogs/QuitConfirm.tsx`、`dialogs/SessionSwitcher.tsx`（grep 确认无任何导入）
  - [x] grep 确认无死导出残留（两个 dialog 已删；渲染函数仅剩单测引用）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY(标注): `src/ui/components/Sidebar.ts`（renderSidebar `@deprecated`）
  - MODIFY(标注): `src/ui/components/ChatView.ts`（渲染函数 `@deprecated`）
  - DELETE: `src/ui/dialogs/QuitConfirm.tsx`, `src/ui/dialogs/SessionSwitcher.tsx`
- **✅ 实现说明：** 采用规格允许的“删除或标注 `@deprecated`”双策略——
    1. `renderSidebar`/`renderChatMessage`/`renderChatView` 仍被 `test/ui/{sidebar,chat-view,components}.test.ts` 覆盖，删除会连带移除 ~600 行测试并降低覆盖率；因此标注 `@deprecated`（JSDoc 明确无生产调用方、由 ink 组件取代），保留类型与测试，零回归。
    2. `dialogs/QuitConfirm.tsx`、`dialogs/SessionSwitcher.tsx` 全仓库无任何导入（grep 仅命中自身定义），且 `ctrl+o/s` 已在 T4 移除接入点，故直接删除。
    3. typecheck 通过；`test/ui` 全套 357 例通过。

---

### Task T10: Unify Border Styles Across Overlays and Cards

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Unify border styles across overlays and cards to "single"
- **Subject (continuous):** Unifying border styles across overlays and cards to "single"
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.3（对应 L1）
- **Dependencies:**
  - blockedBy: T0
  - blocks: none
- **Checklist:**
  - [x] `PermissionDialog` 边框 `round` → `single`（`PermissionDialog.tsx:63`）
  - [x] `DiffPreview` 手绘 ASCII（`┌─`/`└`）改用 ink `<Box borderStyle="single" borderColor={colors.border}>`（`DiffPreview.tsx:135`）
  - [x] 全局 overlay/卡片边框风格一致（`test/ui/diff-preview.test.ts` 等通过）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **✅ 实现说明：** 将 `PermissionDialog.tsx:63` 的 `borderStyle="round"` 改为 `"single"`，与 `Editor`/`SessionInfo`/`SidebarPanel`/`ExitConfirmDialog` 一致；DiffPreview 部分已在 T5/本任务中完成。
- **Files:**
  - MODIFY: `src/ui/components/PermissionDialog.tsx`
  - MODIFY: `src/ui/components/DiffPreview.tsx`

---

### Task T11: Clarify Interaction State vs Agent Mode Semantics

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Clarify the Agent mode vs runtime state semantics in the bars
- **Subject (continuous):** Clarifying the Agent mode vs runtime state semantics in the bars
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.4（对应 L2）
- **Dependencies:**
  - blockedBy: T3
  - blocks: none
- **Checklist:**
  - [x] 顶栏 `agentMode` 标注为 `Mode: Build`/`Mode: Plan`（`HeaderBar.tsx:21,30`）
  - [x] 底栏保留运行态图标 `● streaming` 等（`StatusBarView.tsx:16-34`）
  - [x] 更新相关快照/单测（`test/ui/status-bar.test.ts`、HeaderBar 相关用例通过）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **✅ 实现说明：** `HeaderBar.tsx` 将 `modeLabel` 渲染为 `Mode: ${modeLabel}`（同步更新 `plain` 投影以保证截断宽度一致）；底栏运行态图标保持不变。
- **Files:**
  - MODIFY: `src/ui/components/HeaderBar.tsx`
  - MODIFY: `src/ui/components/StatusBarView.tsx`

---

### Task T12: Add Field Degradation for the `tiny` Breakpoint

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Add StatusBar field degradation for the tiny breakpoint
- **Subject (continuous):** Adding StatusBar field degradation for the tiny breakpoint
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.5（对应 L3）
- **Dependencies:**
  - blockedBy: T7
  - blocks: none
- **Checklist:**
  - [x] `layout.ts` 向外透出当前 `breakpoint`/`density`（`OpenCodeLayout` 新增字段）
  - [x] `StatusBar` 获取断点（`StatusBarView` 直接用 `getBreakpoint(width)`，无需 AppRoot 透传）
  - [x] tiny(<60 列) 下仅保留 mode + 轮次，省略 model 与 tokens
  - [x] tiny 断点字段降级（`StatusBarView.tsx` `getBreakpoint(width).name === 'tiny'` 分支）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/layout.ts`
  - MODIFY: `src/ui/components/StatusBarView.tsx`
- **✅ 实现说明：**
    1. `OpenCodeLayout` 新增 `breakpoint: BreakpointName`/`density: Density` 字段并在 `computeOpenCodeLayout` 返回（向外透出当前断点）。
    2. `StatusBarView` 以 `getBreakpoint(width)` 就地判断断点（比经 AppRoot 透传 prop 更简洁且等价）；当 `name === 'tiny'`（<60 列）时仅渲染 `icon + label + turnCount/maxTurns`，省略 provider/model 与 progress/tokens。

---

### Task T13: Protect Minimum Visible Rows for the Chat Area

- **Status:** `complete` ✅ (verified 2026-07-19)
- **Subject (imperative):** Protect a minimum visible row count for the chat area
- **Subject (continuous):** Protecting a minimum visible row count for the chat area
- **Spec:** `docs/specs/ui-optimization-spec.md` Section 3.2.6（对应 L4）
- **Dependencies:**
  - blockedBy: T8
  - blocks: none
- **Checklist:**
  - [x] `contentHeight` 设最小可视行下限（`MIN_CONTENT_HEIGHT=6`），空间不足时优先压缩 editor
  - [x] 80–119 列区间缩小右栏宽度（`RIGHT_PANEL_WIDTH` 30→24，`wide` 仍 40）
  - [x] 矮终端单测断言聊天区不被压至 1 行（`test/ui/layout.test.ts` 34 例通过）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/layout.ts`
- **✅ 实现说明：**
    1. 新增 `MIN_CONTENT_HEIGHT=6`：先按 25% 算 `editorHeight`，再用 `editorHeight = min(editorHeight, max(1, usable - MIN_CONTENT_HEIGHT))` 优先保留聊天区（终端足够高时），必要时压缩 editor（可低于 `EDITOR_MIN_HEIGHT`）；`contentHeight = max(1, usable - editorHeight)`。
    2. 右栏宽度分级：`RIGHT_PANEL_WIDTH` 由 30 降为 24（standard 80–119），仅 `wide`(≥120) 保留 40，释放左栏给主内容；layout.test 断言 `wide.rightPanelWidth > standard.rightPanelWidth` 仍成立。
    3. 与 T8 合并在一次 `layout.ts` 重构中完成；total 行高仍严格 ≤ 终端高度（多 `(width,height)` 断言通过）。

---

## Summary

| Phase | Tasks | 关注点 | 预计工时 |
|---|---|---|---|
| Phase 1 (P0) | T0, T1, T2, T3 | 主题桥接 + 安全闸门 + 信息单一源 | ~24h |
| Phase 2 (P1) | T4, T5, T6, T7 | 键位接通 + 颜色收敛 + 附件 + 截断 | ~23h |
| Phase 3 (P2) | T8–T13 | 布局预算 + 死代码清理 + 一致性收尾 | ~16h |

**整体进度（2026-07-19 核对）：** 全部 14 个任务 T0–T13 均已 `complete`（Phase 1/2/3 全部完成）。`npm run typecheck` 通过；`test/ui` 全套 357 例通过。

**收尾说明：** 本轮实现 T8、T9、T10、T11、T12、T13 六个剩余任务——T10/T11 为小改（边框、`Mode:` 前缀）；T8+T13 合并为一次 `layout.ts`/`Layout.tsx`/`SidebarPanel.tsx` 布局重构（侧栏高度预算 + 聊天区最小行 + 右栏宽度分级）；T12 为 tiny 断点字段降级；T9 采用“删除两个无引用 dialog + 将仍有测试覆盖的渲染函数标 `@deprecated`”。
