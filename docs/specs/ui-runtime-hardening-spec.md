# kc-cli UI Runtime Hardening Specification

> 基于 2026-07-27 对"六项 UI 运行时症状"的根因调研编制（全源码核对，逐条实锤定位）
> Generated: 2026-07-27 | Version: 1.0 | Scope: `src/api/**`、`src/query/QueryEngine.ts`、`src/ui/**`、`test/**`
> 原则基线：**按根因立项，不按症状立项**（承接 `ui-structural-hardening-spec.md` 铁律）——本轮全部为数据管线与组件级修复，不触碰已落地的焦点栈 / Yoga 单一真相源架构

---

## 1. Executive Summary

### 1.1 背景

结构级硬化（focus-stack、Yoga 全权测量、view-protocol 契约归位）完成后，用户反馈 6 项运行时症状：

| # | 症状 | 表象层 |
|---|---|---|
| S1 | 无 Shift+Tab 循环执行模式快捷键 | 输入系统 |
| S2 | 窄窗口下输入框越界 | 布局/组件 |
| S3 | 长时间思考但无流式输出 | 数据管线 |
| S4 | Token 计数不准确（恒为 0 / 上限固定 200000） | 数据管线 |
| S5 | 右侧工具栏无工具调用简要信息、状态永远 running | 数据管线 |
| S6 | 左下角状态栏未实时更新 | 数据管线（S4/S5 的下游投影） |

### 1.2 根因总览（全部已在源码实锤）

| 编号 | 根因 | 证据 | 投影症状 |
|---|---|---|---|
| G1 | usage 数据管线三处断裂：`QueryEngine.streamLLMResponse` 的 `case 'stop': break;` 丢弃 usage；`createTurnCompleteEvent` 硬编码 `{0,0,0}`；OpenAI 兼容客户端流式请求不带 `stream_options.include_usage` 也不解析 usage chunk | `QueryEngine.ts:939-940,1539-1546`；`OpenAICompatibleClient.ts:426-453` | S4、S6（tokens 恒 0） |
| G2 | 思考流三处断裂：(a) `parseStreamChunk` 不读 `delta.reasoning_content`（DeepSeek-R1/QwQ/GLM 风格推理零事件）；(b) `useStreamingEvents` 仅在 turn_complete 才把思考链放入 `thinkingChains` map，流式期间 UI 取不到；(c) `folded:true` 恒折叠只渲染一行头，且时长用 `Date.now()` 完成后仍在走 | `OpenAICompatibleClient.ts:433-453`；`useStreamingEvents.ts:85-100,147-154`；`ThinkingChainView.ts:15-21` | S3 |
| G3 | 侧栏工具生命周期断裂：`tool_started` 推入 running 条目后，`tool_completed` 只更新消息 toolCalls，从不回写 `sidebarData.tools` → 条目永远 running、无时长、无输入摘要 | `useStreamingEvents.ts:102-145` | S5、S6（`currentOperation` 永远显示 stale running 工具） |
| G4 | 状态栏自身两处失真：进度条用 turnCount 重算而非 `progressPercent` prop（goal 模式进度条不动）；`mode` 从不显示 'overlay'（overlay 打开时仍显示 idle） | `StatusBarView.tsx:40-41`；`AppRoot.tsx:1061-1071` | S6 |
| G5 | `formatKeypressEvent` 丢弃 shift 修饰符，shift+tab 与 tab 不可区分；`cycleExecutionMode` 仅绑定 ctrl+g | `keybinding-manager.ts:67-73,96` | S1 |
| G6 | Editor 高度/宽度双失真：输入行 `<Text>` 默认换行（长文本纵向撑破固定槽位）；附件条在 1 行预算下仍渲染；宽度用全终端宽而非本列宽（右栏可见时偏大）；Layout editor 槽位无 overflow 兜底 | `Editor.tsx:56-131`；`Layout.tsx:62` | S2 |

- **Risk Profile:** T1/T2 触 API 流解析与引擎事件（Medium）；T3/T4/T5 局部组件与 hook（Low）；T6 触编辑器渲染（Low-Medium，受行为测试保护）。
- **非目标：** 不改 focus-stack / 布局架构；不改 budgetEnforcer 的估算式预算；不引入新依赖。

### 1.3 Priority Ranking

| Priority | Task | 对治根因 | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 Token 统计管线 | G1 | High | 3h | Medium |
| P0 | T2 思考流可视化 | G2 | High | 4h | Medium |
| P1 | T3 侧栏工具生命周期 | G3 | Medium | 2h | Low |
| P1 | T4 状态栏实时性 | G4 | Medium | 1h | Low |
| P1 | T5 Shift+Tab 快捷键 | G5 | Low | 1h | Low |
| P1 | T6 窄窗输入框越界 | G6 | Medium | 3h | Low-Medium |

---

## 2. Detailed Fix Proposals

### 2.1 T1 — Token 统计管线修复（G1）

1. `OpenAICompatibleClient.buildRequestBody`：流式请求追加 `stream_options: { include_usage: true }`。
2. `parseStreamChunk` 捕获 `data.usage`（prompt/completion/total_tokens）暂存到实例字段；`processSSELine` 的 `[DONE]` 分支在 stop 事件上携带已捕获的 usage。
3. `QueryEngine.streamLLMResponse`：`case 'stop'` 捕获 `event.usage`；`createTurnCompleteEvent(message, usage)` 透传真实 usage（无则回退零值）。Anthropic/Ollama 已在 stop 带 usage，自动受益。
4. `AppRoot`：`SessionInfo` 的 `tokensMax` 由 `getCapabilities(provider, model).maxContextWindow` 派生，替换硬编码 200000。

**Files:** `src/api/OpenAICompatibleClient.ts`、`src/query/QueryEngine.ts`、`src/ui/components/AppRoot.tsx`
**验证：** usage chunk 解析单测；turn_complete usage 透传单测；UI turn_complete 累加已有逻辑不动。

### 2.2 T2 — 思考过程流式可视化（G2）

1. `parseStreamChunk` 新增 `delta.reasoning_content` → `thinking_delta` 分支（不受 `supportsChainOfThought` 开关限制：该字段存在即为思考内容）。
2. `useStreamingEvents.thinking_delta`：更新 `currentThinkingChainRef` 的同时 `thinkingChainsRef.current.set(assistantId, chain)`，流式期间 ChatMessageView 即可渲染。
3. `ThinkingChain` 增加可选 `endTime`；turn_complete 时补写。`renderThinkingChain`：流式中（无 endTime）头部 + 最新 step 单行预览；完成后折叠头 + `endTime` 冻结时长。

**Files:** `src/api/OpenAICompatibleClient.ts`、`src/ui/hooks/useStreamingEvents.ts`、`src/ui/view-protocol.ts`、`src/ui/components/ThinkingChainView.ts`
**验证：** reasoning_content 单测；流式期间 thinkingChains 可见性测试；渲染两态测试。

### 2.3 T3 — 侧栏工具生命周期与简要信息（G3）

1. `SidebarTool` 增加 `detail?: string`（输入摘要）。
2. `tool_started`：侧栏条目附 `detail`（从 `toolCall.input` 提取首个字符串参数，截断 40 字符）与内部 startTime。
3. `tool_completed`：回写侧栏最后一个同名 running 条目 → completed/failed + `duration`。
4. `SidebarPanel` Tools 区渲染 dim 的 detail（列宽内截断）。

**Files:** `src/ui/view-protocol.ts`、`src/ui/hooks/useStreamingEvents.ts`、`src/ui/components/SidebarPanel.tsx`
**验证：** hook 级测试断言 completed 状态与 duration；behavior 测试不回归。

### 2.4 T4 — 状态栏实时更新（G4）

1. `StatusBarView` 进度条改用 `progressPercent` prop 填充。
2. `AppRoot` 派生 StatusBar 显示 mode：任一 overlay（palette/filePicker/exitConfirm/diffDetail/permission）打开时显示 'overlay'。
3. tokens 与 running 工具由 T1/T3 修复后自然实时。

**Files:** `src/ui/components/StatusBarView.tsx`、`src/ui/components/AppRoot.tsx`
**验证：** status-bar.test.ts 扩展 progressPercent / overlay mode 用例。

### 2.5 T5 — Shift+Tab 循环执行模式（G5）

1. `formatKeypressEvent` 对命名键（`name.length > 1`）追加 `shift` 前缀；可打印字符不加（保护 `?` 等绑定）。
2. 注册 `{ key: 'shift+tab', command: 'cycleExecutionMode' }`，保留 ctrl+g 后备。
3. `handleEditorKey` 的 tab 分支已进 resolver，shift+tab 自动命中，`dispatchCommand.cycleExecutionMode` 已实现。

**Files:** `src/ui/keybinding-manager.ts`；测试 `test/ui/keybinding-resolver.test.ts`、`test/ui/keybinding-consistency.test.ts`
**验证：** shift+tab → cycleExecutionMode 解析测试；tab（无 shift）仍 → toggleAgentMode；`?` 绑定不回归。

### 2.6 T6 — 窄窗口输入框越界（G6）

1. `Editor` 输入行光标跟随水平窗口裁剪 + `wrap="truncate"` 保证单行；多行文本只显示末 N 行（N=内部行预算）。
2. `Editor` 用 `measureElement` 自测实际列宽（fallback：`computeOpenCodeLayout` 派生）。
3. 附件条按预算显隐：内部预算 <2 行时隐藏（有附件时优先保留计数行）。
4. `Layout` editor 槽位补 `overflow="hidden"` 兜底。

**Files:** `src/ui/components/Editor.tsx`、`src/ui/components/Layout.tsx`
**验证：** behavior/layout-anchor 扩展窄窗 (60x20) + 长输入用例：总行数 ≤ 终端高度、状态栏在末行。

---

## 3. Impacted File List

| 文件 | 任务 | 变更类型 |
|---|---|---|
| `src/api/OpenAICompatibleClient.ts` | T1,T2 | MODIFY（usage 捕获 + reasoning_content） |
| `src/query/QueryEngine.ts` | T1 | MODIFY（stop usage → turn_complete） |
| `src/ui/components/AppRoot.tsx` | T1,T4 | MODIFY（tokensMax 派生 + overlay mode） |
| `src/ui/hooks/useStreamingEvents.ts` | T2,T3 | MODIFY（live chain + 工具回写） |
| `src/ui/view-protocol.ts` | T2,T3 | MODIFY（endTime + detail 字段） |
| `src/ui/components/ThinkingChainView.ts` | T2 | MODIFY（两态渲染） |
| `src/ui/components/SidebarPanel.tsx` | T3 | MODIFY（detail 渲染） |
| `src/ui/components/StatusBarView.tsx` | T4 | MODIFY（progressPercent 进度条） |
| `src/ui/keybinding-manager.ts` | T5 | MODIFY（shift 修饰符 + 绑定） |
| `src/ui/components/Editor.tsx` | T6 | MODIFY（裁剪 + 自测宽度 + 显隐） |
| `src/ui/components/Layout.tsx` | T6 | MODIFY（overflow 兜底） |
| `test/**` | T1-T6 | NEW/MODIFY（见 tasks 文档） |

---

## 4. Verification & Test Plan

- 通用门禁：`npm run typecheck` 无错误；`npm test` 全绿；`test/ui/behavior/**` 特征化基线不回归。
- 红线（承接 structural-hardening T8）：UI 行为变更必须附带行为级测试。
- 分任务验证要点见 §2 各节与 `ui-runtime-hardening-tasks.md`。

---

## 5. Assumptions & Risks

- 不改 focus-stack / Yoga 布局架构；本轮不触碰 `layout.ts` 策略常量。
- `stream_options.include_usage` 为 OpenAI 兼容协议扩展，DeepSeek/Qwen 均支持；不支持的网关会忽略该字段（usage 回退零值，不破坏流）。
- Windows 终端 shift+tab 依赖 ink 对 `ESC[Z` 的识别（key.tab+key.shift）；保留 ctrl+g 等价后备。
- `intent-context-hardening-spec.md` 仅为文档格式参照，其 H1–H4 不在本轮范围。

---

**编制人**：基于 2026-07-27 全源码核对（逐文件证据见 §1.2）
**对照基线**：`docs/specs/ui-structural-hardening-spec.md` v1.0（结构级硬化），本规格为其运行时数据管线续篇
