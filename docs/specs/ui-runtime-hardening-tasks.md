# kc-cli UI Runtime Hardening — Task List

> 依据：`docs/specs/ui-runtime-hardening-spec.md` v1.0（2026-07-27）
> 铁律：每任务附行为级/单元测试；每任务完成后回写本表状态

## 任务状态表

| Task | 描述 | 对治根因 | Priority | Status | 完成日期 |
|---|---|---|---|---|---|
| T1 | Token 统计管线修复（stop usage 透传 + include_usage + tokensMax 派生） | G1 | P0 | ✅ done | 2026-07-27 |
| T2 | 思考流可视化（reasoning_content + live chain + 两态渲染） | G2 | P0 | ✅ done | 2026-07-27 |
| T3 | 侧栏工具生命周期 + detail 摘要 | G3 | P1 | ✅ done | 2026-07-27 |
| T4 | 状态栏实时性（progressPercent 进度条 + overlay mode） | G4 | P1 | ✅ done | 2026-07-27 |
| T5 | Shift+Tab 循环执行模式 | G5 | P1 | ✅ done | 2026-07-27 |
| T6 | 窄窗口输入框越界（单行裁剪 + 自测宽度 + 显隐 + overflow 兜底） | G6 | P1 | ✅ done | 2026-07-27 |

## 任务明细与验收清单

### T1 — Token 统计管线（P0）
- [x] `OpenAICompatibleClient.buildRequestBody` 流式加 `stream_options.include_usage`
- [x] `parseStreamChunk` 捕获 usage chunk；stop 事件携带 usage
- [x] `QueryEngine.streamLLMResponse` 捕获 stop usage；`createTurnCompleteEvent` 透传
- [x] `AppRoot` tokensMax = `getCapabilities(provider, model).maxContextWindow`
- [x] 测试：usage chunk 解析；turn_complete usage 透传（`test/api/OpenAICompatibleClient.test.ts`、`test/query/QueryEngine-coverage-2.test.ts`、`test/ui/behavior/runtime-hardening.test.tsx`）

### T2 — 思考流可视化（P0）
- [x] `parseStreamChunk` 支持 `delta.reasoning_content` → thinking_delta
- [x] `useStreamingEvents` thinking_delta 期间即写入 `thinkingChains` map
- [x] `ThinkingChain.endTime`；turn_complete 冻结时长
- [x] `renderThinkingChain` 流式预览 / 完成折叠两态
- [x] 测试：reasoning_content 解析；流式链可见性；渲染两态（`test/ui/thinking-chain-view.test.ts`、`test/ui/behavior/runtime-hardening.test.tsx`）

### T3 — 侧栏工具生命周期（P1）
- [x] `SidebarTool.detail` 字段
- [x] tool_started 附 detail + startTime；tool_completed 回写 status/duration
- [x] `SidebarPanel` 渲染 detail
- [x] 测试：completed 状态与 duration 断言（`test/ui/behavior/runtime-hardening.test.tsx`）

### T4 — 状态栏实时性（P1）
- [x] 进度条改用 progressPercent
- [x] overlay 打开时 mode 显示 'overlay'
- [x] 测试：`test/ui/status-bar-view.test.tsx`（新建）+ `test/ui/behavior/runtime-hardening.test.tsx` overlay 用例

### T5 — Shift+Tab（P1）
- [x] `formatKeypressEvent` 命名键追加 shift 前缀
- [x] 注册 `shift+tab → cycleExecutionMode`
- [x] 测试：resolver + consistency 扩展；`?`/tab 不回归（`test/ui/keybinding-resolver.test.ts`）

### T6 — 窄窗输入框（P1）
- [x] 输入行光标跟随水平裁剪 + `wrap="truncate"`；多行取末 N 行
- [x] `measureElement` 自测列宽
- [x] 附件条按预算显隐
- [x] `Layout` editor 槽位 `overflow="hidden"`
- [x] 测试：60x20 长输入行为用例（`test/ui/behavior/runtime-hardening.test.tsx`）

## 门禁

- `npm run typecheck` 无错误 ✅（2026-07-27 验证）
- `npm test`：本轮相关套件全绿（135/135，含 `test/ui/behavior/**` 基线不回归）✅；
  全量运行中另有若干**与本轮无关的环境性失败**（Windows 缺 bubblewrap 沙箱后端、符号链接 EPERM、POSIX `/tmp` 路径假设），均发生在未改动的构造路径（`SandboxManager`/`ToolExecutor`），非本轮回归
