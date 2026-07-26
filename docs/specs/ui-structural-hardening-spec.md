# kc-cli UI Structural Hardening Specification

> 基于 2026-07-26 对"布局/ESC/侧边栏三重问题反复复发"的根因调研编制（git 历史取证 + 全源码核对）
> Generated: 2026-07-26 | Version: 1.0 | Scope: `src/ui/**`、`test/ui/**`
> 原则基线：**按根因立项，不按症状立项** —— 本规格的目标不是第 5 次修复三个症状，而是拆除让它们必然复发的三个结构性缺陷

---

## 1. Executive Summary

### 1.1 背景：同一组问题的四次修复史

git 历史与任务记忆显示，"布局偏移 / ESC 失灵 / 侧边栏异常"三联症状在一个月内被修复至少 4 次：

| 日期 | Commit | 修复内容 | 结果 |
|---|---|---|---|
| 2026-07-19 | `fdc3647` | anchor editor to bottom, fix error/dialog ESC, wire live sidebar | 次日部分修复被 cleanup 删除 |
| 2026-07-20 | `affd7ee` | UI optimization T0-T13（含 layout、死代码清理） | 删除了前一天刚修好 ESC 的 `QuitConfirm.tsx`/`SessionSwitcher.tsx` |
| 2026-07-20 | `a6e2dce`/`f49991e` | 再次涉及布局与操作条 | — |
| 2026-07-24 | `9bc7876` | 又一次 resize 后 chat 渗入 editor，补 `overflow="hidden"` + `flexShrink={0}` | 最近一次钳位补丁 |

**结论：每次修复的都是结构性缺陷的"投影"，投影源从未被拆除。** 本规格识别出 4 个根因（R1–R4），并给出一次性拆除方案。

### 1.2 根因总览

| 编号 | 根因 | 投影出的症状 |
|---|---|---|
| R1 | 输入系统"广播 + 各自为政"，无焦点仲裁者 | 所有 ESC 类 bug；按键泄漏进编辑器；死键位绑定 |
| R2 | 两套布局真相源（layout.ts 手工行数预算 vs ink/Yoga flexbox） | 所有输入框上浮/内容重叠/溢出类 bug |
| R3 | 字符串渲染"死路径"与 ink"活路径"类型/运行时纠缠 | 侧边栏契约脆弱；每轮 cleanup 都造成回归或不敢删 |
| R4 | 测试断言内部算术而非用户可见行为（元根因） | "299 测试全绿"与"UI 又坏了"长期并存，回归不可探测 |

- **Scope:** `src/ui/**` 42 个源文件，重点 `AppRoot.tsx`(1033 行)、`layout.ts`、`Layout.tsx`、`Sidebar.ts`、`keybinding-manager.ts`
- **Risk Profile:** Phase 1（Medium，触输入主链路）/ Phase 2（Medium，触布局主链路）/ Phase 3（Low）/ Phase 0（Low，纯新增测试）
- **Total Estimated Effort:** 约 1.5–2 周
- **实施顺序原则：** 先建行为级测试防护网（Phase 0），再做输入与布局重构——直接对治 R4"修复无回归保护"的历史教训

---

## 2. Problem Classification & Priority Matrix

### 2.1 根因 R1 — 输入系统无焦点仲裁者（ESC 复发的结构源头）

Ink 的 `useInput` 是**广播式**的：所有挂载组件同时收到每个按键，框架层没有"焦点"概念。当前 ESC 语义决策散落在至少 6 个互不知情的位置：

| # | 位置 | 承担的 ESC 语义 |
|---|---|---|
| 1 | `AppRoot.tsx:775-824` 主 `useInput` | permission deny、goal 取消、error dismiss（3 种语义硬编码同一函数） |
| 2 | `AppRoot.tsx:95-102` `ExitConfirmDialog` 自带 `useInput` | 取消退出 |
| 3 | `CommandPalette.tsx:48-50` 自带 `useInput` | 关闭面板 |
| 4 | `FilePicker.tsx:23-25` 自带 `useInput` | 取消选择 |
| 5 | `PermissionDialog.tsx:37-39` 自带 `useInput` | deny |
| 6 | `keybinding-manager.ts:98-99` schema | `escape → closeOverlay / cancelMode` |

**实锤失配（当前代码中可复现）：**

- **F1 死绑定**：`AppRoot.tsx:796` 在 overlay 打开时提前 `return`，keybinding 的 `escape→closeOverlay` 永远不会被 resolve；且 `dispatchCommand` 中 `closeOverlay` 的实现是空的 `return true`（`AppRoot.tsx:766-768`）。但 `/help` 的 `getHelpText()` 仍向用户展示这条不存在的能力。
- **F2 修复随文件蒸发**：ESC 修复沉淀在具体组件文件里而非架构里——`QuitConfirm.tsx`/`SessionSwitcher.tsx` 于 07-19 补上 ESC 处理，07-20 即被 cleanup 整体删除，修复消失。
- **F3 context 滞后一帧**：keybinding context 靠 `useEffect`（`AppRoot.tsx:272-282`）在渲染后异步同步，快速连续按键时 `when` 条件基于过期上下文判定，存在竞态。
- **F4 组合状态乘法增长**：互斥守卫（`overlayOpen`、`isModalOpen`、`showDiffDetail`、`permissionRequest`…）需要在每个 handler 里手动维护。每新增一个 overlay/模式，需改动的守卫点呈乘法增长，漏一处即是下一个 ESC bug。

### 2.2 根因 R2 — 两套布局真相源（布局复发的结构源头）

`layout.ts` 手工按行数预算每个区块，`Layout.tsx` 将数字交给 Yoga flexbox 渲染，但同时又使用 `flexGrow={1}`/`flexShrink={0}`/`overflow="hidden"`——**两套系统都有权决定最终高度，任何分歧就是一次布局 bug**。

**实锤失配：**

- **F5 反向硬编码**：`ERROR_BAR_HEIGHT = 4 // border(2)+content(1)+marginBottom(1)`、`OPERATION_HEIGHT = 8 // border(2)+title+op-name+...`（`layout.ts:93-102`）把子组件内部渲染细节（边框/margin/行数）硬编码进布局常量。组件改一行文案、窄列触发 `<Text>` 自动换行，常量即失真，输入框即上浮。
- **F6 钳位补丁堆积**：`layout.ts` 中 `Math.max/Math.min` 钳位已出现 10+ 处，`9bc7876` 又补 `overflow="hidden"`+`flexShrink={0}`——全部是给"两套真相源分歧的具体表现"打补丁，分歧生成机制原封未动。
- **F7 侧栏高度三方共治**：`Layout.tsx:30-38` 手工计算 `sidebarHeight` 后经 `React.cloneElement` 注入；`layout.ts:156-158` 动态钳位 `sessionInfoHeight`；`SidebarPanel` 内部再按预算截断。侧栏最终高度的真相分布在三处。

### 2.3 根因 R3 — 死活路径类型/运行时纠缠（侧边栏与 cleanup 复发的结构源头）

历次修复均宣称"只动 ink 活路径，不碰字符串渲染死路径"，但该隔离**从未真实成立**：

- **F8 死路径里嵌着活器官**：`SidebarData` 类型与 `createSidebarData()` **运行时函数**位于旧字符串组件 `Sidebar.ts`，而活路径 `useStreamingEvents.ts:6-7` 正从它导入运行时代码；`session-mapper.ts`、`useStreamingEvents.ts` 还从 `ChatView.ts`/`ToolCallCard.ts`/`ThinkingChainView.ts` 导入类型。
- **F9 僵尸代码误导**：`Sidebar.ts` 的 `sidebarMoveUp/Down/Left/Right`、`createSidebarSelection` 全仓库零调用，持续误导后续修复对"什么是活的"的判断。
- **F10 cleanup 与修复互相破坏**：删死代码 → 切断活路径依赖或误删活文件（F2 即实例）→ 回归 → 下轮不敢删 → 僵尸继续堆积。死活不解纠缠，cleanup 永远是高危操作。

### 2.4 根因 R4 — 测试未对准故障面（元根因）

- **F11**：`test/ui/layout.test.ts` 的用例全部断言 `computeOpenCodeLayout` 的**算术性质**（不溢出、≥1），但历史布局 bug 全部发生在"算术结果 ≠ Yoga 实际渲染"的缝隙——现有测试在原理上探测不到这类回归。
- **F12**：无任何测试渲染真实组件树断言"ESC 在状态组合 X 下产生效果 Y"或"resize 后编辑器末行贴底"。这解释了为什么每轮修复都能"全绿交付"，而症状照常复发。

### 2.5 Priority Ranking

| Priority | Task | Phase | 对治根因 | Impact | Effort | Risk |
|---|---|---|---|---|---|---|
| P0 | T0 行为级测试防护网 | 0 | R4 | High | 10h | Low |
| P0 | T1 FocusStack 焦点栈核心 | 1 | R1 | High | 8h | Medium |
| P0 | T2 全部 overlay/模式迁移到焦点栈 | 1 | R1 | High | 10h | Medium |
| P1 | T3 键位 schema 与实现对齐 | 1 | R1 | Medium | 4h | Low |
| P0 | T4 布局单一真相源（Yoga 全权测量） | 2 | R2 | High | 12h | Medium |
| P1 | T5 侧栏/右栏高度单一真相 | 2 | R2 | Medium | 5h | Low |
| P1 | T6 UI 数据契约归位 protocol 模块 | 3 | R3 | Medium | 4h | Low |
| P1 | T7 死路径处置 + 导入防回流闸门 | 3 | R3 | Medium | 5h | Low |
| P1 | T8 回归矩阵扩展 + CI 门禁 | 4 | R4 | High | 6h | Low |

---

## 3. Detailed Fix Proposals

### 3.0 Phase 0 — 行为级测试防护网（P0，先行）

#### 3.0.1 T0 — 建立行为级测试防护网（测试策略 · R4）

**Problem:** F11/F12——现有测试只覆盖内部算术，历次重构在无行为回归保护下进行，这正是 F2（修复被 cleanup 误删）能悄无声息发生的前提。

**Solution（测试基建）：**
1. 引入 `ink-testing-library`（devDependency），建立 `test/ui/behavior/` 目录与渲染辅助（固定 stdout 尺寸、注入假 QueryEngine/事件流的 harness）。
2. 编写**特征化测试（characterization tests）**锁定当前正确行为，作为后续重构的护栏：
   - ESC 现状矩阵：`permissionRequest 挂起时 ESC=deny`、`overlay 打开时 ESC 关闭该 overlay`、`goal active 时 ESC 触发取消`、`仅错误条时 ESC dismiss 最新错误`、`空闲时 ESC 无副作用`；
   - 布局锚定：在 (80,24)/(120,40)/(60,20) 尺寸下渲染 `AppRoot`，断言最后非空行是 StatusBar、编辑器块紧邻其上（贴底不上浮）；
   - 侧栏溢出：注入超量 tools/tasks 数据，断言渲染总行数 ≤ 终端高度。
3. 断键泄漏基线：permission 挂起时输入可打印字符，断言编辑器文本不变。

**Files:** NEW `test/ui/behavior/harness.tsx`、`test/ui/behavior/esc-matrix.test.tsx`、`test/ui/behavior/layout-anchor.test.tsx`、`test/ui/behavior/sidebar-overflow.test.tsx`；MODIFY `package.json`（devDep）。
**验证：** 新测试在**当前未重构代码**上全绿（特征化基线成立）；`npm run typecheck` 通过。

---

### 3.1 Phase 1 — 输入焦点栈（P0，对治 R1）

#### 3.1.1 T1 — 实现 FocusStack 焦点栈核心（架构优化 · R1）

**Problem:** F1/F3/F4——无焦点仲裁者，ESC 语义 6 处分散，context 异步滞后。

**Solution（架构优化）：** 新建 `src/ui/focus-stack.ts`：

```typescript
export type FocusLayerId = 'editor' | 'error' | 'goal' | 'permission'
  | 'diff-detail' | 'palette' | 'file-picker' | 'exit-confirm';

export interface FocusLayer {
  id: FocusLayerId;
  /** 返回 true 表示按键已被本层消费，停止向下传递 */
  onKey: (event: KeypressEvent) => boolean;
  /** ESC 的统一语义：弹出本层时执行（关闭/取消/deny）。返回 false 表示本层不响应 ESC（如 editor 基层） */
  onEscape: () => boolean;
  /** 层被强制移除（如宿主组件卸载）时的兜底，保证 Promise 类决策必有归宿 */
  onDispose?: () => void;
}

export class FocusStack {
  push(layer: FocusLayer): () => void;   // 返回 unregister
  handleKey(event: KeypressEvent): boolean; // 仅栈顶可消费；ESC = 栈顶 onEscape()
  top(): FocusLayerId | null;
  snapshot(): FocusLayerId[];            // 供测试与状态栏诊断
}
```

设计要点：
1. **唯一的顶层 `useInput`** 留在 `AppRoot`，将按键规范化为 `KeypressEvent` 后交 `focusStack.handleKey()`；除 Ctrl+C 逃生通道外，不再有第二个 `useInput`。
2. **ESC 语义收敛为一条规则**："ESC = 请求栈顶层退出"。各层只需实现 `onEscape`，互斥守卫（F4 的乘法增长）整体消失。
3. **同步性**：栈的 push/pop 在事件处理同一 tick 内完成，不经 `useEffect`，消除 F3 竞态。keybinding context 改为从 `focusStack.top()` **同步派生**。
4. **安全保证（防死锁/防泄漏）**：`permission` 层的 `onDispose` 必须以 `deny` resolve 未决 Promise（层被意外移除时执行器不悬挂）；非栈顶层收不到任何按键（按键不再泄漏进编辑器——安全性增强，防止误触发提交/命令）。
5. 提供 `useFocusLayer(layer)` React hook：挂载即 push、卸载即自动 unregister + `onDispose`，使"修复沉淀在架构里"——组件文件被删除时语义由栈兜底，F2 不再可能。

**Files:** NEW `src/ui/focus-stack.ts`、`src/ui/hooks/useFocusLayer.ts`；NEW `test/ui/focus-stack.test.ts`（纯逻辑单测：push/pop 顺序、ESC 路由、dispose 兜底）。
**验证：** 单测覆盖栈顶独占、ESC 逐层弹出、dispose 必达；`npm run typecheck`。

#### 3.1.2 T2 — 迁移全部 overlay/模式到焦点栈（代码重构 · R1）

**Problem:** 6 处分散的 `useInput` 与守卫需要一次性收编，避免双路径并存（历史上 T4 键位接线的教训：迁移不彻底 = 双触发）。

**Solution（代码重构）：**
1. `ExitConfirmDialog`/`CommandPalette`/`FilePicker`/`PermissionDialog` 删除各自 `useInput`，改用 `useFocusLayer`（导航/确认键进 `onKey`，取消进 `onEscape`）。
2. `AppRoot` 主 `useInput` 缩减为：规范化按键 → `focusStack.handleKey()`；`editor` 作为常驻基层（`onKey` 承接文本编辑与 Enter 提交，`onEscape` 返回 false）。
3. `permission` 内联确认、`goal` 取消、`error` dismiss 分别注册为独立层（error 层仅在有活动错误时在栈中）。层进出与既有 state（`showPalette` 等）保持单向：state 驱动层的挂载，层的 `onEscape` 回写 state。
4. `showDiffDetail` 成为 `diff-detail` 层压在 `permission` 层之上——"ESC 先关 diff 再 deny"由栈序自然保证，无需手工守卫。
5. `ChatMessagesView` 的滚动键改为经基层 `onKey` 派发（删除其独立 `useInput` 与 `isModalOpen` prop 判断）。

**Files:** MODIFY `AppRoot.tsx`（主输入收敛 + 层注册）、`CommandPalette.tsx`、`FilePicker.tsx`、`PermissionDialog.tsx`、`ChatMessagesView.tsx`、`ChatPanel.tsx`（移除 isModalOpen 透传）。
**验证：** T0 的 ESC 特征化矩阵全绿不变（行为等价）；grep 确认 `useInput` 在 `src/ui` 仅剩 AppRoot 一处（+逃生通道）；按键泄漏基线测试通过。

#### 3.1.3 T3 — 键位 schema 与实现对齐（代码重构 · R1）

**Problem:** F1——`escape→closeOverlay` 是死绑定但仍进 `/help`；`toggleThinking` 等绑定无 handler；schema 承诺与实现脱节。

**Solution:**
1. 删除 `keybinding-manager.ts` 中由焦点栈接管的绑定（`escape→closeOverlay`、`escape→cancelMode`）；ESC 帮助文案改为由焦点栈生成（"Esc — 关闭当前弹层/取消当前操作"）。
2. 对每条剩余绑定建立 schema↔`dispatchCommand` 的一致性单测：resolve 出的每个 command 必须有非空 handler，杜绝"承诺但静默失效"。
3. keybinding context 从 `focusStack.top()` 同步派生（配合 T1 第 3 点），删除 `AppRoot.tsx:272-282` 的 useEffect 同步。

**Files:** MODIFY `keybinding-manager.ts`、`AppRoot.tsx`；NEW `test/ui/keybinding-consistency.test.ts`。
**验证：** `/help` 展示的每个键位实测生效；一致性单测防止未来新增死绑定。

---

### 3.2 Phase 2 — 布局单一真相源（P0/P1，对治 R2）

#### 3.2.1 T4 — 布局交由 Yoga 全权测量（架构优化 · R2）

**Problem:** F5/F6——手工行数预算与 Yoga 双真相源；反向硬编码常量随组件演化必然失真。

**Solution（架构优化）：** 职责重划——**layout.ts 只保留"策略"，Yoga 独占"测量"**：
1. `layout.ts` 保留：断点表、`rightPanelWidth`、`editorHeight` 目标值（策略性数字）、`truncate`/`abbreviateModel` 工具。**删除** `ERROR_BAR_HEIGHT`/`OPERATION_HEIGHT(_COMPACT)`/`SESSION_INFO_HEIGHT` 等"反向硬编码组件内部细节"的常量及其参与的减法预算。
2. `Layout.tsx` 改为纯 flex 结构：
   - 左列：chat `flexGrow={1} flexShrink={1} overflow="hidden"` + errorBar/operationSummary/editor 均 `flexShrink={0}`（自然高度，Yoga 实测）；
   - 编辑器贴底由"chat 是唯一 flexGrow 元素"结构性保证，不再依赖行数减法；
   - `minHeight` 约束替代 `MIN_CONTENT_HEIGHT` 钳位链。
3. `ErrorBar`/`OperationSummary` 约束自身最大行数（内容截断），保证自然高度有上界——**组件对自身高度负责**，取代"布局层猜测组件高度"。
4. `OpenCodeLayout` 接口收缩为策略字段（breakpoint/density/宽度/editor 目标高度），高度类字段逐步废弃；消费方（StatusBarView 等）不受影响。

**风险控制：** 该任务受 T0 布局锚定测试保护；分两步提交（先 Layout.tsx 结构、后删 layout.ts 常量），每步跑全量 `test/ui`。

**Files:** MODIFY `src/ui/layout.ts`、`src/ui/components/Layout.tsx`、`AppRoot.tsx`（OperationSummary/ErrorBar 不再依赖预留高度）、`OperationSummary.tsx`、`test/ui/layout.test.ts`（删除对废弃常量的算术断言，保留策略断言）。
**验证：** T0 布局锚定测试在 (40..200)×(10..60) 抽样尺寸下全绿；真实终端 resize 手工验收无上浮/重叠。

#### 3.2.2 T5 — 侧栏/右栏高度单一真相（代码重构 · R2）

**Problem:** F7——侧栏高度真相三方共治（layout.ts 钳位 / Layout.tsx cloneElement 注入 / SidebarPanel 内部预算）。

**Solution:**
1. 右列改为纯 flex：`SessionInfo` 自然高度 + `flexShrink={0}`，`SidebarPanel` `flexGrow={1}`；删除 `Layout.tsx` 的 `sidebarHeight` 手工计算与 `cloneElement` 注入。
2. `SidebarPanel` 改用 ink `measureElement`（或保守的 `useTerminalSize` 派生上界）自测可用行数后截断条目——高度真相唯一归属组件自身。
3. `layout.ts` 删除 `sessionInfoHeight` 动态钳位输出。

**Files:** MODIFY `Layout.tsx`、`SidebarPanel.tsx`、`SessionInfo.tsx`、`layout.ts`。
**验证:** T0 侧栏溢出测试（超量数据不撑破终端高度）全绿；矮终端 (80,15) 下右栏无溢出。

---

### 3.3 Phase 3 — 契约归位与死路径处置（P1，对治 R3）

#### 3.3.1 T6 — UI 数据契约归位 protocol 模块（代码重构 · R3）

**Problem:** F8——活路径从死文件导入类型与运行时函数，死活纠缠使 cleanup 永远高危。

**Solution:**
1. 新建 `src/ui/view-protocol.ts`（对齐项目既有 `protocol.ts` 命名惯例），迁入：`SidebarData`/`SidebarFile`/`SidebarTool`/`SidebarTask`/`SidebarSection` + `createSidebarData()`（来自 `Sidebar.ts`）；`ChatMessage`（来自 `ChatView.ts`）；`ToolCallData`（来自 `ToolCallCard.ts`）；`ThinkingChain`/`ThinkingStep` + `classifyThinkingSteps()`（来自 `ThinkingChainView.ts`）。
2. 更新全部导入方：`useStreamingEvents.ts`、`session-mapper.ts`、`SidebarPanel.tssx`、`ChatMessagesView.tsx` 等；旧文件中原定义改为从 `view-protocol` 的 re-export（保持旧测试编译通过，供 T7 处置）。

**Files:** NEW `src/ui/view-protocol.ts`；MODIFY 上述导入方与 4 个旧组件文件。
**验证：** `npm run typecheck`；grep 确认活路径（非 test、非旧字符串组件）不再从 `Sidebar.ts`/`ChatView.ts`/`ToolCallCard.ts`/`ThinkingChainView.ts` 导入。

#### 3.3.2 T7 — 死路径处置 + 导入防回流闸门（代码重构 · R3）

**Problem:** F9/F10——僵尸代码（`sidebarMoveUp/Down/Left/Right` 等零调用）持续误导；无机制阻止活路径再次依赖死路径。

**Solution:**
1. T6 完成后，删除 `Sidebar.ts` 中僵尸交互函数与 `renderSidebar` 相关死代码及其孤儿测试；`ChatView.ts`/`ThinkingChainView.ts`/`ToolCallCard.ts` 中已被 protocol 接管的定义删除，文件若被掏空则整体删除（**删除前 grep 全仓引用并列出证据**，吸取 F2 教训——本次删除受 T0 行为测试保护）。
2. **防回流闸门**：新增 `test/ui/dead-path-guard.test.ts`——静态扫描 `src/ui` 的 import 语句，断言不存在从死路径清单文件的导入；该清单与豁免项在测试文件内显式维护。未来任何人重新引入死路径依赖，CI 直接红灯。
3. 更新 `MarkdownRenderer.ts`/`InputBox.ts`/`StatusBar.ts` 等字符串渲染遗存的定位注释：明确"活/死/纯逻辑复用"三类标注（`InputBox.ts` 的输入状态机被 AppRoot 复用，属活路径纯逻辑，不删）。

**Files:** MODIFY/DELETE `Sidebar.ts`、`ChatView.ts`、`ThinkingChainView.ts`、`ToolCallCard.ts` 及对应旧测试；NEW `test/ui/dead-path-guard.test.ts`。
**验证：** typecheck + 全量测试；guard 测试对故意引入的违规导入能红灯（自测一次后还原）。

---

### 3.4 Phase 4 — 回归矩阵与门禁（P1，对治 R4 收尾）

#### 3.4.1 T8 — 扩展回归矩阵并纳入 CI 门禁（测试策略 · R4）

**Problem:** 防护网（T0）建立后需覆盖重构后的新架构面，并制度化防止"绿灯腐烂"再现。

**Solution:**
1. ESC 矩阵扩展至焦点栈全状态组合：多层叠加（permission+diff-detail、goal+error）、层 dispose 兜底（permission 层卸载必 deny）、快速连续 ESC。
2. 布局矩阵参数化：宽 40–200 × 高 10–60 抽样 20 组，断言编辑器贴底、无溢出、侧栏不撑破。
3. 将 `test/ui/behavior/**` 纳入 `.github/workflows/ci.yml` 既有测试 job（确认无需单独 job，vitest 全量已含）。
4. 在 `CLAUDE.md`/开发规范中固化红线：**UI 行为变更必须附带行为级测试；禁止只改算术测试交差**。

**Files:** MODIFY `test/ui/behavior/**`（扩展）；确认 `.github/workflows/ci.yml`；MODIFY `CLAUDE.md`（规范条目）。
**验证：** 全量 `npm test` 绿；人为注入一处历史 bug（如移除 editor `flexShrink={0}` 等价约束）矩阵能红灯（自测后还原）。

---

## 4. Impacted File List

| 文件 | 涉及任务 | 变更类型 |
|---|---|---|
| `test/ui/behavior/harness.tsx` | T0 | NEW（渲染 harness） |
| `test/ui/behavior/esc-matrix.test.tsx` | T0,T8 | NEW |
| `test/ui/behavior/layout-anchor.test.tsx` | T0,T8 | NEW |
| `test/ui/behavior/sidebar-overflow.test.tsx` | T0,T8 | NEW |
| `src/ui/focus-stack.ts` | T1 | NEW（焦点栈核心） |
| `src/ui/hooks/useFocusLayer.ts` | T1 | NEW |
| `test/ui/focus-stack.test.ts` | T1 | NEW |
| `src/ui/components/AppRoot.tsx` | T2,T3,T4 | MODIFY（输入收敛+层注册+去预留高度） |
| `src/ui/components/CommandPalette.tsx` | T2 | MODIFY（useInput→useFocusLayer） |
| `src/ui/dialogs/FilePicker.tsx` | T2 | MODIFY（useInput→useFocusLayer） |
| `src/ui/components/PermissionDialog.tsx` | T2 | MODIFY（useInput→useFocusLayer） |
| `src/ui/components/ChatMessagesView.tsx` | T2,T6 | MODIFY（滚动键收编+契约导入） |
| `src/ui/components/ChatPanel.tsx` | T2 | MODIFY（移除 isModalOpen） |
| `src/ui/keybinding-manager.ts` | T3 | MODIFY（删除死绑定） |
| `test/ui/keybinding-consistency.test.ts` | T3 | NEW |
| `src/ui/layout.ts` | T4,T5 | MODIFY（删反向常量，收缩为策略层） |
| `src/ui/components/Layout.tsx` | T4,T5 | MODIFY（纯 flex，删 cloneElement 注入） |
| `src/ui/components/OperationSummary.tsx` | T4 | MODIFY（自身高度上界） |
| `src/ui/components/SidebarPanel.tsx` | T5,T6 | MODIFY（自测高度+契约导入） |
| `src/ui/components/SessionInfo.tsx` | T5 | MODIFY（自然高度） |
| `test/ui/layout.test.ts` | T4 | MODIFY（删除废弃常量断言） |
| `src/ui/view-protocol.ts` | T6 | NEW（UI 数据契约） |
| `src/ui/hooks/useStreamingEvents.ts` | T6 | MODIFY（导入改道） |
| `src/ui/session-mapper.ts` | T6 | MODIFY（导入改道） |
| `src/ui/components/Sidebar.ts` | T6,T7 | MODIFY→DELETE（僵尸清除） |
| `src/ui/components/ChatView.ts` | T6,T7 | MODIFY/DELETE |
| `src/ui/components/ThinkingChainView.ts` | T6,T7 | MODIFY/DELETE |
| `src/ui/components/ToolCallCard.ts` | T6,T7 | MODIFY/DELETE |
| `test/ui/dead-path-guard.test.ts` | T7 | NEW（防回流闸门） |
| `.github/workflows/ci.yml` | T8 | 确认/MODIFY |
| `CLAUDE.md` | T8 | MODIFY（测试红线规范） |

---

## 5. Implementation Progress Tracker

> 状态核对：2026-07-26（初始编制）

| Task | 描述 | Phase | 对治根因 | Status | Owner | 完成日期 |
|---|---|---|---|---|---|---|
| T0 | 行为级测试防护网 | 0 | R4 | 🔵 in_progress | — | — |
| T1 | FocusStack 焦点栈核心 | 1 | R1 | ⚪ pending | — | — |
| T2 | overlay/模式迁移到焦点栈 | 1 | R1 | ⚪ pending | — | — |
| T3 | 键位 schema 与实现对齐 | 1 | R1 | ⚪ pending | — | — |
| T4 | 布局 Yoga 全权测量 | 2 | R2 | ⚪ pending | — | — |
| T5 | 侧栏高度单一真相 | 2 | R2 | ⚪ pending | — | — |
| T6 | UI 契约归位 protocol | 3 | R3 | ⚪ pending | — | — |
| T7 | 死路径处置 + 防回流闸门 | 3 | R3 | ⚪ pending | — | — |
| T8 | 回归矩阵 + CI 门禁 | 4 | R4 | ⚪ pending | — | — |

---

## 6. Verification & Test Plan

### 6.1 通用门禁
- `npm run typecheck` 无错误；`npm test` 全绿（vitest）。
- 现有 `test/ui/**` 不回归；T0 特征化基线在每个 Phase 结束时必须保持全绿（行为等价性证明）。

### 6.2 分根因验证要点
- **R1（T1/T2/T3）：** ESC 矩阵——每个焦点层组合下 ESC 的效果唯一且正确；`src/ui` 中 `useInput` 仅剩 1 处（grep 断言）；permission 层 dispose 必 deny（无执行器悬挂）；按键零泄漏（permission 挂起时打字不进编辑器）；schema 每键位有活 handler。
- **R2（T4/T5）：** 参数化尺寸矩阵下编辑器贴底、总行数 ≤ 终端高度、侧栏不溢出；`layout.ts` 中不再存在描述组件内部结构的行数常量（grep `ERROR_BAR_HEIGHT|OPERATION_HEIGHT|SESSION_INFO_HEIGHT` 为零）。
- **R3（T6/T7）：** 活路径对死路径零导入（guard 测试制度化）；僵尸导出清零（grep `sidebarMoveUp|createSidebarSelection` 零命中）。
- **R4（T0/T8）：** 变异自检——人为恢复一个历史 bug（如去掉编辑器贴底约束），行为矩阵必须红灯。

### 6.3 手工验收
- 真实终端：resize（60→200 列往复）无上浮/重叠/残影；每个弹层 ESC 逐层退出符合直觉；权限确认期间乱按键盘编辑器内容不变；`/help` 所列键位逐一实测有效。

---

## 7. Assumptions & Risks

- **假设：** ink 当前版本支持 `measureElement`（T5 使用；若不可用，退化方案为 `useTerminalSize` 派生上界，仍满足"单一真相"目标）。
- **假设：** `ink-testing-library` 与项目 ink/react 版本兼容（T0 首日验证，不兼容则以 `ink` 的 `render` + 自建 stdout stub 替代，接口不变）。
- **风险：** T2 触输入主链路，迁移不彻底会双路径触发——以"grep useInput 仅剩 1 处"为完成硬标准，一次性切换不留过渡态。
- **风险：** T4 删除高度常量可能暴露隐藏依赖（如某组件依赖固定 8 行渲染）——分两步提交、每步全量测试，且受 T0 锚定测试保护。
- **风险：** T7 删除文件是 F2 事故的同类操作——制度化前置条件：删除清单逐文件附 grep 引用证据，且 T0/T6 先行完成。
- **历史教训内建：** 本规格的 Phase 顺序（测试先行 → 重构 → 清理）本身就是对 F2/F10/F12 三个历史事故模式的防御设计，不可调换。

---

**编制人**：基于 2026-07-26 根因调研（git 取证 `fdc3647`/`affd7ee`/`9bc7876` + 全源码核对 + 4 次历史修复任务记忆比对）
**对照基线**：`docs/specs/ui-optimization-spec.md` v1.0（前轮症状级修复的规格，本规格为其结构级续篇）
