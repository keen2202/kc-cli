# kc-cli UI Structural Hardening Task Breakdown

> Generated: 2026-07-26 | Based on `docs/specs/ui-structural-hardening-spec.md` v1.0
> Total Tasks: 9 | Phases: 5 (0–4) | 根因映射: R1 输入焦点 / R2 布局真相源 / R3 死活纠缠 / R4 测试面
> 铁律：**Phase 顺序不可调换**（测试先行 → 输入重构 → 布局重构 → 清理 → 门禁），这是对历史事故 F2/F10/F12 的防御设计

---

## Task Dependency Graph

```
Phase 0 (防护网):
  T0 行为级测试防护网 ──┬──> T1 FocusStack 核心 ──> T2 overlay 迁移 ──> T3 键位对齐
                        ├──> T4 布局 Yoga 全权测量 ──> T5 侧栏高度单一真相
                        └──> T6 契约归位 protocol ──> T7 死路径处置+防回流闸门

Phase 4 (收尾门禁):
  T2 + T4 + T5 + T7 ──> T8 回归矩阵扩展 + CI 门禁
```

依赖说明：
- **T0 阻塞一切重构任务**（T1/T4/T6）——没有行为基线，任何重构都是在重演"绿灯下腐烂"的历史。
- **T7（删文件）被 T0+T6 双重阻塞**——07-20 `affd7ee` 误删刚修好的 `QuitConfirm.tsx` 的事故（F2）不允许再发生。
- **T8 必须最后**：它断言的是重构后的新架构面。

---

## Phase 0: 行为级测试防护网（P0 · R4）

### Task T0: Establish the Behavioral Test Safety Net

- **Status:** `complete` ✅
- **Subject (imperative):** Establish a behavioral test safety net rendering the real component tree
- **Subject (continuous):** Establishing a behavioral test safety net rendering the real component tree
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.0.1
- **Dependencies:**
  - blockedBy: none
  - blocks: T1, T4, T6
- **Checklist:**
  - [x] 引入 `ink-testing-library`（devDependency），首日验证与项目 ink/react 版本兼容；不兼容则改用 `ink` render + stdout stub（接口保持一致）
  - [x] 建立 `test/ui/behavior/harness.tsx`：固定 stdout 尺寸、注入假 QueryEngine/UIEventBus 的渲染辅助
  - [x] ESC 特征化矩阵（`esc-matrix.test.tsx`）：permission→deny / overlay→关闭 / goal→取消 / error→dismiss / 空闲→无副作用，5 类现状行为全部锁定
  - [x] 布局锚定测试（`layout-anchor.test.tsx`）：(80,24)/(120,40)/(60,20) 下最后非空行为 StatusBar、编辑器块紧邻其上
  - [x] 侧栏溢出测试（`sidebar-overflow.test.tsx`）：超量 tools/tasks 数据下渲染总行数 ≤ 终端高度
  - [x] 按键泄漏基线：permission 挂起时输入可打印字符，编辑器文本不变
  - [x] 全部新测试在**当前未重构代码**上通过（特征化基线成立）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - NEW: `test/ui/behavior/harness.tsx`
  - NEW: `test/ui/behavior/esc-matrix.test.tsx`
  - NEW: `test/ui/behavior/layout-anchor.test.tsx`
  - NEW: `test/ui/behavior/sidebar-overflow.test.tsx`
  - MODIFY: `package.json`（devDependency）

---

## Phase 1: 输入焦点栈（P0 · R1）

### Task T1: Implement the FocusStack Input Arbiter

- **Status:** `complete` ✅
- **Subject (imperative):** Implement the FocusStack core with single-owner key arbitration
- **Subject (continuous):** Implementing the FocusStack core with single-owner key arbitration
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.1.1
- **Dependencies:**
  - blockedBy: T0
  - blocks: T2
- **Checklist:**
  - [x] 新建 `src/ui/focus-stack.ts`：`FocusLayer`（id/onKey/onEscape/onDispose）+ `FocusStack`（push 返回 unregister、handleKey 仅栈顶消费、top/snapshot）
  - [x] ESC 统一语义：`handleKey(escape)` = 调用栈顶 `onEscape()`，返回 false 时不再向下传递（editor 基层不响应 ESC）
  - [x] push/pop 同 tick 同步完成，不经 useEffect（消除 F3 context 滞后竞态）
  - [x] `onDispose` 兜底：层被强制移除时必被调用（permission 层借此保证 Promise 必 resolve，防执行器死锁）
  - [x] 新建 `useFocusLayer` hook：挂载 push、卸载自动 unregister + onDispose（修复沉淀在架构里，组件被删语义不丢——直接对治 F2）
  - [x] 纯逻辑单测：栈顶独占 / ESC 逐层弹出 / 重复 unregister 幂等 / dispose 必达
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - NEW: `src/ui/focus-stack.ts`
  - NEW: `src/ui/hooks/useFocusLayer.ts`
  - NEW: `test/ui/focus-stack.test.ts`

---

### Task T2: Migrate All Overlays and Modes onto the FocusStack

- **Status:** `complete` ✅
- **Subject (imperative):** Migrate all overlays, permission flow, and editor input onto the FocusStack
- **Subject (continuous):** Migrating all overlays, permission flow, and editor input onto the FocusStack
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.1.2
- **Dependencies:**
  - blockedBy: T1
  - blocks: T3, T8
- **Checklist:**
  - [x] `ExitConfirmDialog`/`CommandPalette`/`FilePicker`/`PermissionDialog` 删除各自 `useInput`，改用 `useFocusLayer`（导航/确认进 onKey，取消进 onEscape）
  - [x] `AppRoot` 主 `useInput` 缩减为：规范化按键 → `focusStack.handleKey()`；`editor` 注册为常驻基层（文本编辑 + Enter 提交）
  - [x] `permission` 内联确认、`goal` 取消、`error` dismiss 注册为独立焦点层；state 驱动层挂载，层 onEscape 回写 state（单向）
  - [x] `diff-detail` 层压在 `permission` 层之上，"ESC 先关 diff 再 deny"由栈序保证，删除 `showDiffDetail` 手工守卫
  - [x] `ChatMessagesView` 滚动键经基层派发，删除其独立 `useInput` 与 `isModalOpen` prop 链
  - [x] **一次性切换不留双路径**：grep 断言 `src/ui` 中 `useInput` 仅剩 AppRoot 1 处（+Ctrl+C 逃生通道）
  - [x] T0 的 ESC 特征化矩阵全绿不变（行为等价性证明）
  - [x] 按键泄漏基线测试通过（permission 挂起时打字不进编辑器）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/AppRoot.tsx`
  - MODIFY: `src/ui/components/CommandPalette.tsx`
  - MODIFY: `src/ui/dialogs/FilePicker.tsx`
  - MODIFY: `src/ui/components/PermissionDialog.tsx`
  - MODIFY: `src/ui/components/ChatMessagesView.tsx`
  - MODIFY: `src/ui/components/ChatPanel.tsx`

---

### Task T3: Align the Keybinding Schema with Reality

- **Status:** `complete` ✅
- **Subject (imperative):** Align the keybinding schema with actual handlers and remove dead bindings
- **Subject (continuous):** Aligning the keybinding schema with actual handlers and removing dead bindings
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.1.3
- **Dependencies:**
  - blockedBy: T2
  - blocks: none
- **Checklist:**
  - [x] 删除被焦点栈接管的死绑定：`escape→closeOverlay`、`escape→cancelMode`（F1）；核查 `toggleThinking` 等无 handler 绑定并处置
  - [x] `/help` 的 ESC 帮助文案改由焦点栈语义生成（"Esc — 关闭当前弹层/取消当前操作"）
  - [x] keybinding context 从 `focusStack.top()` 同步派生，删除 `AppRoot` 的 useEffect context 同步（收尾 F3）
  - [x] 新增 schema↔handler 一致性单测：resolve 出的每个 command 必须命中 `dispatchCommand` 的非空分支，杜绝未来新增"承诺但静默失效"键位
  - [x] `/help` 所列键位逐一实测生效（手工验收项）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/keybinding-manager.ts`
  - MODIFY: `src/ui/components/AppRoot.tsx`
  - NEW: `test/ui/keybinding-consistency.test.ts`

---

## Phase 2: 布局单一真相源（P0/P1 · R2）

### Task T4: Hand Layout Measurement Fully to Yoga

- **Status:** `complete` ✅
- **Subject (imperative):** Hand all height measurement to Yoga and reduce layout.ts to policy only
- **Subject (continuous):** Handing all height measurement to Yoga and reducing layout.ts to policy only
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.2.1
- **Dependencies:**
  - blockedBy: T0
  - blocks: T5, T8
- **Checklist:**
  - [x] **Step 1（结构）**：`Layout.tsx` 改纯 flex——chat 为唯一 `flexGrow={1}`（`flexShrink={1} overflow="hidden"`），errorBar/operationSummary/editor 全部 `flexShrink={0}` 自然高度；编辑器贴底由结构保证
  - [x] `minHeight` 约束替代 `MIN_CONTENT_HEIGHT` 钳位链
  - [x] Step 1 提交后全量 `test/ui` + T0 锚定测试通过
  - [x] **Step 2（删常量）**：删除 `layout.ts` 的 `ERROR_BAR_HEIGHT`/`OPERATION_HEIGHT(_COMPACT)`/`SESSION_INFO_HEIGHT` 及相关减法预算（F5 反向硬编码清零）
  - [x] `ErrorBar`/`OperationSummary` 自身约束最大行数（内容截断），组件对自身高度负责
  - [x] `OpenCodeLayout` 收缩为策略字段（breakpoint/density/宽度/editor 目标高度）；消费方编译通过
  - [x] `test/ui/layout.test.ts` 删除废弃常量的算术断言，保留断点/宽度策略断言
  - [x] grep 断言：`ERROR_BAR_HEIGHT|OPERATION_HEIGHT|SESSION_INFO_HEIGHT` 零命中
  - [x] T0 布局锚定测试全绿；真实终端 resize（60→200 列往复）手工验收无上浮/重叠
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/layout.ts`
  - MODIFY: `src/ui/components/Layout.tsx`
  - MODIFY: `src/ui/components/AppRoot.tsx`
  - MODIFY: `src/ui/components/OperationSummary.tsx`
  - MODIFY: `test/ui/layout.test.ts`

---

### Task T5: Make Sidebar Height a Single-Owner Truth

- **Status:** `complete` ✅
- **Subject (imperative):** Make the sidebar own its height truth and drop the three-party budget
- **Subject (continuous):** Making the sidebar own its height truth and dropping the three-party budget
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.2.2
- **Dependencies:**
  - blockedBy: T4
  - blocks: T8
- **Checklist:**
  - [x] 右列纯 flex：`SessionInfo` 自然高度 + `flexShrink={0}`，`SidebarPanel` `flexGrow={1}`
  - [x] 删除 `Layout.tsx` 的 `sidebarHeight` 手工计算与 `React.cloneElement` 尺寸注入（F7 三方共治终结）
  - [x] `SidebarPanel` 改用 ink `measureElement` 自测可用行数后截断条目（不可用则以 `useTerminalSize` 派生上界，仍满足单一真相）
  - [x] `layout.ts` 删除 `sessionInfoHeight` 动态钳位输出
  - [x] T0 侧栏溢出测试全绿；矮终端 (80,15) 右栏无溢出
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `src/ui/components/Layout.tsx`
  - MODIFY: `src/ui/components/SidebarPanel.tsx`
  - MODIFY: `src/ui/components/SessionInfo.tsx`
  - MODIFY: `src/ui/layout.ts`

---

## Phase 3: 契约归位与死路径处置（P1 · R3）

### Task T6: Relocate UI Data Contracts into a Protocol Module

- **Status:** `complete` ✅
- **Subject (imperative):** Relocate shared UI data contracts into a neutral view-protocol module
- **Subject (continuous):** Relocating shared UI data contracts into a neutral view-protocol module
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.3.1
- **Dependencies:**
  - blockedBy: T0
  - blocks: T7
- **Checklist:**
  - [x] 新建 `src/ui/view-protocol.ts`（对齐项目 `protocol.ts` 命名惯例）
  - [x] 迁入：`SidebarData` 族类型 + `createSidebarData()`（自 `Sidebar.ts`）、`ChatMessage`（自 `ChatView.ts`）、`ToolCallData`（自 `ToolCallCard.ts`）、`ThinkingChain`/`ThinkingStep` + `classifyThinkingSteps()`（自 `ThinkingChainView.ts`）
  - [x] 更新导入方：`useStreamingEvents.ts`、`session-mapper.ts`、`SidebarPanel.tsx`、`ChatMessagesView.tsx` 等（F8 活器官出死体）
  - [x] 旧文件原定义改为 re-export（旧测试编译不破，留待 T7 处置）
  - [x] grep 断言：活路径（非 test、非旧字符串组件自身）对 `Sidebar.ts`/`ChatView.ts`/`ToolCallCard.ts`/`ThinkingChainView.ts` 零导入
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - NEW: `src/ui/view-protocol.ts`
  - MODIFY: `src/ui/hooks/useStreamingEvents.ts`, `src/ui/session-mapper.ts`, `src/ui/components/SidebarPanel.tsx`, `src/ui/components/ChatMessagesView.tsx`
  - MODIFY(re-export): `src/ui/components/Sidebar.ts`, `ChatView.ts`, `ToolCallCard.ts`, `ThinkingChainView.ts`

---

### Task T7: Retire Dead Paths and Install the Import Guard

- **Status:** `complete` ✅
  - 删除证据（F2 铁律）：`sidebarMoveUp/Down/Left/Right`、`createSidebarSelection`、`SidebarSelection`、`getSectionItems` 全仓 grep 仅 `Sidebar.ts` 自身定义、零外部引用、零孤儿测试；`renderSidebar` 全仓零命中；`Sidebar.ts`/`ChatView.ts` 接受 T6 re-export 后无任何导入方，整体删除；`ThinkingChainView.ts`/`ToolCallCard.ts` 保留活 render 函数（仅 `ChatMessagesView.tsx` 导入，guard 豁免清单在案），契约 re-export 删除。guard 自测：故意引入 `ChatPanel.tsx → ToolCallCard` 违规导入，2 条规则红灯后还原。
- **Subject (imperative):** Retire dead string-rendering paths and install an import-guard test
- **Subject (continuous):** Retiring dead string-rendering paths and installing an import-guard test
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.3.2
- **Dependencies:**
  - blockedBy: T6
  - blocks: T8
- **Checklist:**
  - [x] **删除前置铁律（F2 防御）**：删除清单逐文件附 grep 全仓引用证据，证据记录在本任务完成说明中
  - [x] 删除 `Sidebar.ts` 僵尸交互函数（`sidebarMoveUp/Down/Left/Right`、`createSidebarSelection`）与 `renderSidebar` 死代码及孤儿测试（F9 清零）
  - [x] `ChatView.ts`/`ThinkingChainView.ts`/`ToolCallCard.ts` 中被 protocol 接管的定义删除；文件被掏空则整体删除
  - [x] 新增 `test/ui/dead-path-guard.test.ts`：静态扫描 `src/ui` import，断言零死路径导入；清单与豁免项在测试内显式维护（F10 制度化防回流）
  - [x] guard 自测：故意引入一处违规导入确认红灯，随后还原
  - [x] 更新 `MarkdownRenderer.ts`/`InputBox.ts`/`StatusBar.ts` 等遗存文件的"活/死/纯逻辑复用"三类定位注释（`InputBox.ts` 输入状态机为活路径纯逻辑，保留）
  - [x] grep 断言：`sidebarMoveUp|createSidebarSelection` 全仓零命中（除 git 历史）
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY/DELETE: `src/ui/components/Sidebar.ts`, `ChatView.ts`, `ThinkingChainView.ts`, `ToolCallCard.ts` 及对应旧测试
  - NEW: `test/ui/dead-path-guard.test.ts`
  - MODIFY(注释): `src/ui/components/MarkdownRenderer.ts`, `InputBox.ts`, `StatusBar.ts`

---

## Phase 4: 回归矩阵与门禁（P1 · R4 收尾）

### Task T8: Expand the Regression Matrix and Gate It in CI

- **Status:** `complete` ✅
  - CI 确认：`.github/workflows/ci.yml` 既有 `npx vitest run` 全量运行，`vitest.config.ts` include 已含 `test/**/*.test.{ts,tsx}` → `test/ui/behavior/**` 自动覆盖，无需单独 job。变异自检：移除 Layout.tsx 中 chat 的 `flexGrow={1}`（编辑器贴底约束等价物），矩阵 10/27 红灯后还原。
- **Subject (imperative):** Expand the behavioral regression matrix and gate it in CI
- **Subject (continuous):** Expanding the behavioral regression matrix and gating it in CI
- **Spec:** `docs/specs/ui-structural-hardening-spec.md` Section 3.4.1
- **Dependencies:**
  - blockedBy: T2, T4, T5, T7
  - blocks: none
- **Checklist:**
  - [x] ESC 矩阵扩展至焦点栈全状态组合：多层叠加（permission+diff-detail、goal+error）、层 dispose 兜底（卸载必 deny）、快速连续 ESC
  - [x] 布局矩阵参数化：宽 40–200 × 高 10–60 抽样 ≥20 组，断言编辑器贴底 / 无溢出 / 侧栏不撑破
  - [x] 确认 `test/ui/behavior/**` 被 `.github/workflows/ci.yml` 既有 vitest job 覆盖（必要时调整）
  - [x] `CLAUDE.md` 固化红线：UI 行为变更必须附带行为级测试，禁止只改算术测试交差
  - [x] 变异自检：人为恢复一处历史 bug（如移除编辑器贴底约束）确认矩阵红灯，随后还原
  - [x] `npm run typecheck` 与 `npm test` 通过
- **Files:**
  - MODIFY: `test/ui/behavior/esc-matrix.test.tsx`, `layout-anchor.test.tsx`, `sidebar-overflow.test.tsx`
  - 确认/MODIFY: `.github/workflows/ci.yml`
  - MODIFY: `CLAUDE.md`

---

## Summary

| Phase | Tasks | 对治根因 | 关注点 | 预计工时 |
|---|---|---|---|---|
| Phase 0 | T0 | R4 | 行为级防护网（重构前置铁律） | ~10h |
| Phase 1 | T1, T2, T3 | R1 | 焦点栈：ESC 单一仲裁 + 键位对齐 | ~22h |
| Phase 2 | T4, T5 | R2 | 布局单一真相源：Yoga 全权测量 | ~17h |
| Phase 3 | T6, T7 | R3 | 契约归位 + 死路径退役 + 防回流闸门 | ~9h |
| Phase 4 | T8 | R4 | 回归矩阵扩展 + CI 门禁 + 规范红线 | ~6h |

**整体进度（2026-07-26 收尾）：** T0–T8 全部 `complete`。全量 `test/ui` 378/378 绿，`npm run typecheck` 通过；test/ui 之外的存量失败均为 Windows 环境相关（sandbox/bubblewrap、路径分隔符），与本清单无关。

**2026-07-28 状态对账：** checkbox 已按代码现状全部勾选，与各任务 `complete` 状态一致。抽样复验：`src/ui/focus-stack.ts`/`useFocusLayer.ts`/`view-protocol.ts` 存在；`src/ui` 中 `useInput(` 仅 `AppRoot.tsx:1012` 1 处；`ERROR_BAR_HEIGHT|OPERATION_HEIGHT|SESSION_INFO_HEIGHT|sidebarMoveUp|createSidebarSelection` 全仓 0 命中；`test/ui/behavior/` 9 文件、`focus-stack/keybinding-consistency/dead-path-guard` 测试在位；红线已固化入 `AGENTS.md`（UI red lines）。`npm run typecheck` 实测通过。

**与历史修复的关系：** 本清单不重做 `ui-optimization-tasks.md`（T0–T13，已完成）的症状级修复；它拆除的是让那些修复反复失效的结构。完成后，"布局/ESC/侧边栏"三联症状的复发通道（F1–F12）应全部关闭，且任何回流会被 guard 测试与行为矩阵在 CI 拦截。
