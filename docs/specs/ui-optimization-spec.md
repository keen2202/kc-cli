# kc-cli UI Optimization Specification

> 基于 `UI_REVIEW_2026-07-19.md` 的源码可达性审查结果，经全仓库逐条核对确认后编制
> Generated: 2026-07-19 | Version: 1.0 | Scope: `src/ui/**`（ink + react + chalk）
> 原则基线：**简单高效** —— 信息单一来源、核心任务路径最短、零冗余、视觉/响应式一致

---

## 1. Executive Summary

本规格文档记录 `kc-cli` v3.2.0 交互式终端 UI 的 **13 项改进**，全部经源码核对确认存在（H1–H3 高、M1–M5 中、L1–L4 低）。核心结论：UI 骨架（布局引擎、虚拟滚动、真实光标、主题系统、响应式断点）已具备"简单高效"基础，但**关键能力（权限闸门、diff 审阅、命令面板、文件选择）停留在死代码或未接线状态**，并存在"信息三处重复""键位假死""颜色双来源"三类一致性返工。

- **Scope:** `src/ui/**` 共 40 个源文件，重点 `AppRoot.tsx`、`layout.ts`、`theme.ts` 及 8 个组件
- **Risk Profile:** Phase 1（Medium，涉及安全闸门接线）/ Phase 2（Low–Medium）/ Phase 3（Low，清理与一致性收尾）
- **Total Estimated Effort:** 约 1.5–2 周
- **根因洞察：** 主题 `ThemeTokens` 是 `chalk` 函数（面向字符串渲染），无法直接用于 ink `<Text color>` 属性；这是 M4「颜色双来源」及 H1/L1 未走主题的**共同根因**。因此需先建立 **theme color bridge**（暴露 `theme.colors` 的 hex 值供 ink 组件消费），再收敛各处硬编码颜色。

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| H1 | 权限确认 + Diff 审阅缺失（死代码未接活路径） | 交互效率 / 组件层级 | `PermissionDialog`/`DiffPreview` 零导入，overlay 仅挂 `ExitConfirmDialog` | 按 `PermissionMode` 挂载权限弹窗 + diff 审阅联动 |
| H2 | 键位表里不符：热键 schema 全失效 | 交互效率 / 视觉一致性 | `keybinding-manager` 定义完整 schema 但 `resolve()` 零调用，全硬编码 | 接通 resolver 分发命令，或删除死 schema |
| H3 | Provider/Model 顶栏/底栏/右栏三处重复 | 布局结构 / 视觉一致性 | 三处渲染同一 provider/model | 单一信息源：顶栏品牌 + 底栏运行态，SessionInfo 去重 |
| M1 | 窄终端 HeaderBar/StatusBar 无截断撑破锁定高度 | 响应式适配 | 单行 `<Text>`，无宽度感知截断 | 宽度感知截断 / model 名缩写 |
| M2 | 附件/文件选择链路断裂 | 交互效率 | `@` 仅插入字符注释 Phase 6，`FilePicker` 零导入，附件计数无入口 | 接通 `@`→文件补全，或暂隐附件 UI |
| M3 | 侧边栏高度预算与真实分配脱节 | 布局结构 | `SidebarPanel` 未传 `height`，用 `?? 20` 兜底 | 传入真实 `rowHeight` 或组件内实测 |
| M4 | 多组件硬编码颜色绕过主题 token（双来源） | 视觉一致性 | `DiffPreview`/`SidebarPanel`/`PermissionDialog`/`ExitConfirmDialog` 用字面色 | 统一经 theme color bridge 消费语义色 |
| M5 | 死代码簇：4 对话框 + 2 字符串渲染器 | 组件层级 / 维护成本 | 5 组件 + `renderChatView`/`renderSidebar` 零外部导入 | 接通（走 H1/H2/M2）或删除/标注 `@deprecated` |
| L1 | 边框样式不统一（single/round/手绘 ASCII） | 视觉一致性 | `single`/`round`/手绘 `┌─` 混用 | 统一 `single`，`DiffPreview` 改用 ink `borderStyle` |
| L2 | 交互状态 vs Agent 模式概念混淆（双 mode） | 组件层级 | `agentMode`(build/plan) 与 `mode`(idle/…) 语义混淆 | 顶栏标注 `Mode: Build`，底栏保留运行态 |
| L3 | `tiny` 断点(<60 列)状态栏未做字段降级 | 响应式适配 | `StatusBar` 恒显示且无降级 | tiny 下仅保留 mode + 轮次 |
| L4 | 聊天区最小可视行保护较弱 | 布局结构 / 响应式 | `contentHeight=Math.max(1,…)` 可压到 1 行 | 设最小可视行，主内容优先于右栏 |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T0 Theme Color Bridge（根因基础） | 1 | High | 3h | Low |
| P0 | T1 权限确认闸门接线（H1a） | 1 | High | 10h | Medium |
| P0 | T2 Diff 审阅接线（H1b） | 1 | High | 8h | Medium |
| P0 | T3 Provider/Model 单一信息源（H3） | 1 | Medium | 3h | Low |
| P1 | T4 Keybinding Resolver 接线（H2） | 2 | High | 8h | Medium |
| P1 | T5 硬编码颜色收敛到主题（M4） | 2 | Medium | 5h | Low |
| P1 | T6 附件/文件选择链路（M2） | 2 | Medium | 6h | Medium |
| P1 | T7 窄终端截断（M1） | 2 | Medium | 4h | Low |
| P2 | T8 侧栏高度预算修正（M3） | 3 | Medium | 4h | Low |
| P2 | T9 死代码删除/标注（M5） | 3 | Medium | 3h | Low |
| P2 | T10 边框样式统一（L1） | 3 | Low | 2h | Low |
| P2 | T11 mode 语义澄清（L2） | 3 | Low | 2h | Low |
| P2 | T12 tiny 断点字段降级（L3） | 3 | Low | 2h | Low |
| P2 | T13 聊天区最小可视行（L4） | 3 | Low | 3h | Low |

---

## 3. Detailed Fix Proposals

### 3.0 Phase 1 — 基础与安全闸门（P0）

#### 3.0.1 T0 — Theme Color Bridge（架构优化 · M4 根因）

**Problem:** `ThemeTokens`（`theme.ts:36-68`）全部是 `chalk` 函数，仅适用于字符串渲染管线；ink 的 `<Text color>` / `<Box borderColor>` 需要**颜色名或 hex 字符串**。`DiffPreview.tsx:47-48` 已明确注释"tokens 返回 ChalkInstance，无法直接用作 Ink color 属性，回退到标准色名"。这是所有 ink 组件绕过主题的结构性根因。

**Solution（代码重构 + 架构优化）：** 在 `useTheme()` 返回值中新增 `colors: ThemeColors`（`theme.ts` 已有的 hex 调色板，ink 原生支持 hex color prop）。ink 组件改用语义色：

```typescript
// useTheme.tsx — ThemeContextValue 扩展
interface ThemeContextValue {
  theme: Theme;
  tokens: ThemeTokens;   // 供字符串渲染管线（chalk）
  colors: ThemeColors;   // 新增：供 ink Text/Box color 属性（hex）
  setTheme: (name: string) => void;
}
// value: { theme, tokens: theme.resolve(), colors: theme.colors, setTheme }
```

ink 组件示例（`DiffPreview` / `SidebarPanel` / `PermissionDialog`）：

```tsx
const { colors } = useTheme();
// add → colors.success；remove → colors.error；context → colors.muted
<Text color={colors.success}>{formatted}</Text>
```

**Files:** MODIFY `src/ui/hooks/useTheme.tsx`（扩展 context）；`src/ui/theme.ts`（确认 `ThemeColors` 导出，必要时补充 `overlayBackground` 字段）。
**验证：** 切换 8 套主题时 ink 组件颜色随之变化；`npm run typecheck`。

#### 3.0.2 T1 — 权限确认闸门接线（安全性增强 · H1a）🔴

**Problem:** 作为 AI coding agent，用户**无法在 UI 审阅/授权工具调用**——安全性最高优先级缺口。`PermissionDialog.tsx`（含 Allow/Allow Always/Deny 交互）已实现但零导入；`AppRoot` overlay 仅挂 `ExitConfirmDialog`（`AppRoot.tsx:528-533`）。

**Solution（安全性增强 + 架构优化）：**
1. 在 `AppRoot` 引入权限请求状态：`const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)`。
2. 打通 QueryEngine/permissions 引擎的授权回调到 UI：当工具执行触达 `PermissionMode`（`default|acceptEdits|plan|bypassPermissions`，见 `src/permissions/protocol.ts`）需要确认时，构造 `PermissionRequest{ toolName, inputSummary, onDecide }` 并 `setPermissionRequest`。
3. `overlay` 挂载：`permissionRequest ? <PermissionDialog request={permissionRequest} onClose={() => setPermissionRequest(null)} /> : (showExitConfirm ? <ExitConfirmDialog/> : null)`。
4. 复用 `sidebarData.tools` 显示"正在执行什么"。
5. `bypassPermissions` 模式下跳过弹窗；`acceptEdits` 仅对写操作自动放行。

**安全考量：** 弹窗必须在工具**实际执行前**阻塞；`onDecide('deny')` 必须中止该工具调用并向 QueryEngine 反馈拒绝；`allow_always` 写入会话级白名单（对齐 `permissions/engine.ts` 规则），避免越权持久化。

**Files:** MODIFY `src/ui/components/AppRoot.tsx`（overlay + 状态 + 回调）；MODIFY `src/ui/components/PermissionDialog.tsx`（走 theme colors，见 T0/T5）；关联 `src/permissions/engine.ts`、`src/permissions/interaction.ts`、`src/executors/toolExecutor.ts`（授权钩子）。
**验证：** 触发写工具时弹窗阻塞；Deny 中止执行；Allow Always 本会话不再询问；bypassPermissions 不弹窗。

#### 3.0.3 T2 — Diff 审阅接线（安全性增强 · H1b）🔴

**Problem:** `DiffPreview.tsx`（含 Accept/Reject、多文件 tab、`←/→` 切换）已实现但零导入。用户无法在写文件前审阅 diff。

**Solution（安全性增强）：** 将待写入文件的 `FileDiff[]`（oldContent/newContent）在权限确认前传入 `DiffPreview`，形成"审阅 → 授权"联动：diff 展示 → `[A]ccept` 进入权限授权 / `[R]eject` 中止。与 T1 的 overlay 复用同一层级（互斥或串联）。`edit`/`write` 类工具在 `acceptEdits` 以下模式必须先经 diff 审阅。

**Files:** MODIFY `src/ui/components/AppRoot.tsx`（挂载 + diff 状态）；MODIFY `src/ui/components/DiffPreview.tsx`（走 theme colors + ink 边框，见 T5/T10）；关联 `src/ui/diff-viewer.ts`（diff 计算复用）、写类工具执行路径。
**验证：** 写文件前展示 diff；Reject 不落盘；Accept 后写入并在 Sidebar Files 反映。

#### 3.0.4 T3 — Provider/Model 单一信息源（代码重构 · H3）🔴

**Problem:** `provider/model` 三处重复：`HeaderBar.tsx:17`、`StatusBarView.tsx:40`、`SessionInfo.tsx:40-41`。30 列右栏中 8 行 `SessionInfo` 有 2 行被重复信息占据。

**Solution（代码重构）：**
- 顶栏保留 `kc v3.2 · provider/model · Build/Plan`（品牌 + 上下文）；
- **移除 `SessionInfo` 的 Model/Provider 两行**，仅保留 sessionId / tokens / duration（释放右栏空间给高价值可观测性）；
- 底栏 `StatusBar` 保留运行态 + 轮次 + tokens，model 缩写或省略（与 M1/L3 协同）。

**Files:** MODIFY `src/ui/components/SessionInfo.tsx`（删除 provider/model 行及 props）；MODIFY `src/ui/components/AppRoot.tsx`（`SessionInfo` 不再传 provider/model）；可选 MODIFY `StatusBarView.tsx`（model 缩写）。
**验证：** 全 UI 中 provider/model 信息不再重复出现于右栏卡片。

---

### 3.1 Phase 2 — 交互与一致性（P1）

#### 3.1.1 T4 — Keybinding Resolver 接线（代码重构 · H2）🔴

**Problem:** `keybinding-manager.ts:81-103` 定义了 `ctrl+o/s/f/t`、`?`、`up/down` 等完整 schema，但 `AppRoot` 创建后从不 `resolve()`，全部按键在 `useInput` 硬编码；`AppRoot.tsx:320` Ctrl+K "not yet wired"、`:452` ↑/↓ "not wired yet"。

**Solution（二选一，推荐接通）：**
- **(推荐) 接通**：`useInput` 内将 ink 按键转为 `KeypressEvent`，经 `keybindingManager.resolve(event)` 得到 command 字符串，再分发到 handler map（`palette`/`modelSelector`/`sessionSwitcher`/`filePicker`/`toggleSidebar`/`help`/`historyPrev`/`historyNext`…）。用 `setContext('input'|'idle'|'streaming'|'overlay'|'delete-mode')` 维护上下文，让 `when` 条件生效。
- **或删除**：移除 `keybinding-manager.ts` 与 4 个死对话框，以 `AppRoot` 硬编码为单一事实源。

**Files:** MODIFY `src/ui/components/AppRoot.tsx`（resolver 分发 + context 维护）；MODIFY `src/ui/hooks/useKeybindings.ts`（补齐调用点）；关联 `src/ui/keybinding-manager.ts`、`src/ui/keypress.ts`。
**验证：** schema 中每个键位实际生效或被移除；无"承诺但静默失效"的键位；`?` 显示 `getHelpText()`。

#### 3.1.2 T5 — 硬编码颜色收敛到主题（视觉一致性 · M4）🟡

**Problem:** `DiffPreview.tsx:53-57`、`SidebarPanel.tsx:22-64`、`PermissionDialog.tsx:36-61`、`ExitConfirmDialog`(`AppRoot.tsx:92` `#1a1b26`) 均未用 `useTheme()`；切换主题时这些区域颜色不变。

**Solution（依赖 T0）：** 基于 T0 的 `colors` bridge，将上述字面色替换为语义色：工具/任务状态 → `colors.success/error/warning/muted/primary`；overlay 背景 → `colors.background`；边框 → `colors.border`。`SidebarPanel` 的 `InkColor` 映射函数改为返回 hex。

**Files:** MODIFY `SidebarPanel.tsx`、`DiffPreview.tsx`、`PermissionDialog.tsx`、`AppRoot.tsx`(ExitConfirmDialog + ErrorBar)。
**验证：** 8 套主题切换时全部 ink 区域颜色一致响应；无字面色残留（grep `color="green"|color="red"|#1a1b26`）。

#### 3.1.3 T6 — 附件/文件选择链路（交互效率 · M2）🟡

**Problem:** `AppRoot.tsx:405-409` `@` 仅 `insertChar` + 注释 "Phase 6"；`FilePicker.tsx` 零导入；编辑器显示 "Attachments: x/5" 与删除模式却无添加入口。

**Solution（二选一）：**
- **接通**：`@` 触发 `FilePicker`（或内联文件补全），选中后加入 `attachmentState.attachments`；`ctrl+f` 经 T4 resolver 打开 `FilePicker`。
- **或暂隐**：在链路完成前隐藏附件计数 UI 与删除模式，避免暴露不可用功能。

**Files:** MODIFY `AppRoot.tsx`（`@`/`ctrl+f` 分支 + 附件状态）；MODIFY `src/ui/dialogs/FilePicker.tsx`（接通或标注）；MODIFY `Editor.tsx`（附件 UI 显隐）。
**验证：** 附件 UI 与真实能力一致（可用则可添加/删除，不可用则不显示）。

#### 3.1.4 T7 — 窄终端截断（响应式 · M1）🟡

**Problem:** `HeaderBar`/`StatusBar` 为 `HEADER_HEIGHT=1`/`STATUS_BAR_HEIGHT=1` 锁定单行；长 `provider/model` 超列宽会折行导致后续布局错位。

**Solution（性能/健壮性）：** 对超长内容做宽度感知截断（`truncate + …`）；或在 `computeOpenCodeLayout` 中缩写长 model 名（`claude-3-5-sonnet-20241022` → `c3.5-sonnet`）；用 `useTerminalSize().width` 计算可用列宽后裁剪。

**Files:** MODIFY `HeaderBar.tsx`、`StatusBarView.tsx`（宽度感知截断）；可选 `layout.ts`（提供 model 缩写工具）。
**验证：** 40/60/80 列下顶栏/底栏均单行不折行、不错位。

---

### 3.2 Phase 3 — 布局预算与清理收尾（P2）

#### 3.2.1 T8 — 侧栏高度预算修正（布局结构 · M3）🟡

**Problem:** `Layout.tsx:49` 右栏用 `flexGrow={1}`，`SidebarPanel` 未收到 `height`（`AppRoot.tsx:517`），内部 `height ?? 20` 兜底（`SidebarPanel.tsx:89`），预算 `(height??20)-9)/4` 与真实可用行数无关。

**Solution（性能/布局重构）：** 在 `Layout` 计算 `rowHeight`（`layout.ts:93` 已有 `contentHeight+editorHeight+errorBarHeight`）并传给 `SidebarPanel`（`height={rowHeight - sessionInfoHeight}`）；分区分配改为**按各 section 实际数量加权**而非均分（空 section 不占预算）。
**Files:** MODIFY `Layout.tsx`（传 height）、`AppRoot.tsx`（透传）、`SidebarPanel.tsx`（加权分配）。
**验证：** 矮/高终端下侧栏不溢出、不浪费空行。

#### 3.2.2 T9 — 死代码删除/标注（维护成本 · M5）🟡

**Problem:** `SessionSwitcher`/`FilePicker`/`QuitConfirm`/`PermissionDialog`/`DiffPreview` 及 `ChatView.ts` 的 `renderChatMessage`/`renderChatView`、`Sidebar.ts` 的 `renderSidebar` 零外部导入。

**Solution（代码重构）：** 经 T1/T2/T4/T6 决策后：已接通的（`PermissionDialog`/`DiffPreview`/`FilePicker`）保留；仍未接通的字符串渲染器（`renderChatView`/`renderSidebar`/`renderChatMessage`）与 `QuitConfirm`/`SessionSwitcher` **删除或标 `@deprecated`**。保留 `ChatView.ts` 的 `ChatMessage` 类型（被 `ChatMessagesView` 引用）。
**Files:** DELETE/标注 `Sidebar.ts`(renderSidebar)、`ChatView.ts`(渲染函数)、`dialogs/QuitConfirm.tsx`、`dialogs/SessionSwitcher.tsx`（视 T4 决策）。
**验证：** grep 确认无死导出残留；`npm run typecheck` 通过。

#### 3.2.3 T10 — 边框样式统一（视觉一致性 · L1）🟢

**Problem:** `Editor`/`SessionInfo`/`SidebarPanel` 用 `single`，`PermissionDialog` 用 `round`，`DiffPreview` 手绘 ASCII（`DiffPreview.tsx:137,194`）。
**Solution:** 全局统一 `borderStyle="single"`；`DiffPreview` 改用 ink `<Box borderStyle="single" borderColor={colors.border}>` 替换手绘 `┌─`/`└`。
**Files:** MODIFY `PermissionDialog.tsx`（round→single）、`DiffPreview.tsx`（手绘→ink 边框）。
**验证:** 全 overlay/卡片边框风格一致。

#### 3.2.4 T11 — mode 语义澄清（组件层级 · L2）🟢

**Problem:** 顶栏 `agentMode`(build/plan) 与底栏 `mode`(idle/streaming/overlay/steer) 双 mode 并现易混淆。
**Solution:** 顶栏标注 `Mode: Build`/`Mode: Plan`；底栏保留运行态 `● streaming` 等，明确区分"工作模式"与"运行状态"。
**Files:** MODIFY `HeaderBar.tsx`（加 `Mode:` 前缀）、`StatusBarView.tsx`（保运行态）。

#### 3.2.5 T12 — tiny 断点字段降级（响应式 · L3）🟢

**Problem:** `tiny`(<60 列) 隐藏 header/sidebar，但 `StatusBar` 恒显示且无字段降级（`layout.ts:14-19`）。
**Solution:** 向 `StatusBar` 传入 `density`/`breakpoint`，tiny 下仅保留 mode + 轮次，省略/缩写 model 与 tokens。
**Files:** MODIFY `layout.ts`（透出断点）、`AppRoot.tsx`（传参）、`StatusBarView.tsx`（降级渲染）。

#### 3.2.6 T13 — 聊天区最小可视行（布局结构 · L4）🟢

**Problem:** `layout.ts:89` `contentHeight=Math.max(1, …)` 矮终端可压到 1 行，而右栏 `sessionInfoHeight` 固定 8 优先（`layout.ts:94`）。
**Solution:** 给聊天区设最小可视行（如 `Math.max(6, …)`），主内容优先于右栏；80–100 列区间可缩小右栏宽度（当前固定 30 偏宽）。
**Files:** MODIFY `layout.ts`（contentHeight 下限 + 右栏宽度分级）。
**验证:** 矮终端下聊天区不被压至 1 行。

---

## 4. Impacted File List

| 文件 | 涉及任务 | 变更类型 |
|---|---|---|
| `src/ui/hooks/useTheme.tsx` | T0 | MODIFY（新增 colors bridge） |
| `src/ui/theme.ts` | T0 | MODIFY（确认/补充 ThemeColors 导出） |
| `src/ui/components/AppRoot.tsx` | T1,T2,T3,T4,T5,T6,T8,T12 | MODIFY（overlay/状态/resolver/透传） |
| `src/ui/components/PermissionDialog.tsx` | T1,T5,T10 | MODIFY（接线 + 主题色 + 边框） |
| `src/ui/components/DiffPreview.tsx` | T2,T5,T10 | MODIFY（接线 + 主题色 + ink 边框） |
| `src/ui/components/SessionInfo.tsx` | T3 | MODIFY（移除 provider/model） |
| `src/ui/components/HeaderBar.tsx` | T7,T11 | MODIFY（截断 + Mode 前缀） |
| `src/ui/components/StatusBarView.tsx` | T3,T7,T11,T12 | MODIFY（截断/降级/运行态） |
| `src/ui/keybinding-manager.ts` | T4 | MODIFY/关联 |
| `src/ui/hooks/useKeybindings.ts` | T4 | MODIFY（补调用点） |
| `src/ui/dialogs/FilePicker.tsx` | T6,T9 | MODIFY（接线或标注） |
| `src/ui/components/Editor.tsx` | T6 | MODIFY（附件 UI 显隐） |
| `src/ui/components/SidebarPanel.tsx` | T5,T8 | MODIFY（主题色 + 加权预算） |
| `src/ui/components/Layout.tsx` | T8 | MODIFY（传 height） |
| `src/ui/layout.ts` | T7,T12,T13 | MODIFY（缩写/断点/最小行） |
| `src/ui/components/Sidebar.ts` | T9 | DELETE/标注 renderSidebar |
| `src/ui/components/ChatView.ts` | T9 | DELETE 渲染函数（保留类型） |
| `src/ui/dialogs/QuitConfirm.tsx` | T9 | DELETE/标注 |
| `src/ui/dialogs/SessionSwitcher.tsx` | T4,T9 | 接线或 DELETE |
| `src/permissions/engine.ts`,`interaction.ts` | T1 | 关联（授权钩子） |
| `src/executors/toolExecutor.ts` | T1,T2 | 关联（执行前审阅/授权） |

---

## 5. Implementation Progress Tracker

> 状态核对：2026-07-19（对照 `src/ui/**`、`src/executors/toolExecutor.ts`、`src/query/QueryEngine.ts` 实际实现 + `npm run typecheck` 通过 + `test/ui` 全套 357 例通过）

| Task | 描述 | Phase | Status | Owner | 完成日期 |
|---|---|---|---|---|---|
| T0 | Theme Color Bridge | 1 | ✅ complete | — | 2026-07-19 |
| T1 | 权限确认闸门接线（H1a） | 1 | ✅ complete | — | 2026-07-19 |
| T2 | Diff 审阅接线（H1b） | 1 | ✅ complete | — | 2026-07-19 |
| T3 | Provider/Model 单一信息源（H3） | 1 | ✅ complete | — | 2026-07-19 |
| T4 | Keybinding Resolver 接线（H2） | 2 | ✅ complete | — | 2026-07-19 |
| T5 | 硬编码颜色收敛（M4） | 2 | ✅ complete | — | 2026-07-19 |
| T6 | 附件/文件选择链路（M2） | 2 | ✅ complete | — | 2026-07-19 |
| T7 | 窄终端截断（M1） | 2 | ✅ complete | — | 2026-07-19 |
| T8 | 侧栏高度预算修正（M3） | 3 | ✅ complete | — | 2026-07-19 |
| T9 | 死代码删除/标注（M5） | 3 | ✅ complete | — | 2026-07-19 |
| T10 | 边框样式统一（L1） | 3 | ✅ complete | — | 2026-07-19 |
| T11 | mode 语义澄清（L2） | 3 | ✅ complete | — | 2026-07-19 |
| T12 | tiny 断点字段降级（L3） | 3 | ✅ complete | — | 2026-07-19 |
| T13 | 聊天区最小可视行（L4） | 3 | ✅ complete | — | 2026-07-19 |

**本轮实现要点（详见 `ui-optimization-tasks.md` 各任务 ✅ 区块）：**
- **T8**：`Layout.tsx` 经 `React.cloneElement` 向 `SidebarPanel` 注入真实 `height`/`width`；`SidebarPanel` 按 `activeSections`（非空 section）加权分配条目预算。
- **T9**：删除无引用的 `QuitConfirm`/`SessionSwitcher`；`renderSidebar`/`renderChatView`/`renderChatMessage` 仍有单测覆盖，标 `@deprecated` 保留类型与测试。
- **T10**：`PermissionDialog.tsx:63` `borderStyle="round"` → `"single"`（与 DiffPreview 等一致）。
- **T11**：`HeaderBar.tsx` 渲染 `Mode: Build`/`Mode: Plan`（同步 `plain` 投影长度）。
- **T12**：`OpenCodeLayout` 新增 `breakpoint`/`density` 字段；`StatusBarView` 在 tiny(<60 列) 仅渲染 mode + 轮次。
- **T13**：`layout.ts` 新增 `MIN_CONTENT_HEIGHT=6`（优先压缩 editor 保留聊天区）；`RIGHT_PANEL_WIDTH` 30→24，`wide` 仍 40。

---

## 6. Verification & Test Plan

### 6.1 通用门禁
- `npm run typecheck` 无错误；`npm test` 全绿（`vitest.config.ts`）。
- 现有 `test/ui/**`（17 文件）不回归；为 T0/T1/T2/T4 新增单测。

### 6.2 分任务验证要点
- **T0/T5：** 主题切换测试——遍历 8 套主题断言 ink 组件颜色随 `colors` 变化（快照或颜色断言）。
- **T1/T2（安全）：** 权限流集成测试——写工具在 `default` 模式必弹窗；Deny 断言工具未执行（mock toolExecutor）；`bypassPermissions` 断言不弹窗；diff Reject 断言不落盘。
- **T3：** 断言 `SessionInfo` 渲染不含 provider/model 字段。
- **T4：** 对每个 schema 键位断言 `resolve()` 返回预期 command 且分发到对应 handler；`when` 上下文切换生效。
- **T7/M1：** 40/60/80/120 列快照断言单行不折行。
- **T8/T13：** 多种 `(width,height)` 下 `computeOpenCodeLayout` 单测断言 `contentHeight ≥ 下限`、侧栏预算与真实行数一致。
- **T12：** tiny 断点下 `StatusBar` 快照断言字段降级。

### 6.3 手工验收
- 真实终端 resize（tiny→wide）无错位；权限弹窗/diff 审阅端到端可用；键位提示与实际行为一致。

---

## 7. Assumptions & Risks

- **假设：** `PermissionMode` 与 `permissions/engine.ts` 提供可复用的授权判定入口；`QueryEngine` 可在工具执行前暴露审阅/授权挂钩（若无需先补该挂钩，属 T1 前置）。
- **假设：** ink 版本支持 `<Text color>` 接收 hex 字符串（当前代码已用 hex 背景色，成立）。
- **风险：** T1/T2 触及执行主链路，需保证弹窗阻塞不引入死锁（异步授权 Promise 需正确 resolve/reject）；建议 TDD 先行。
- **风险：** T4 接通 resolver 可能与现有硬编码分支重复触发，需一次性迁移并删除旧分支，避免双路径。

---

**编制人**：Frontend Developer（基于源码静态可达性分析 + 全仓库逐条核对）
**对照基线**：`UI_REVIEW_2026-07-19.md`（13 项问题全部核对确认存在）
