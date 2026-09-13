# Architecture Hardening T6 — Medium/Low 残项复核报告

- **复核日期**: 2026-09-13
- **范围**: `docs/review/CODE_REVIEW_2026-07-06.md` 中 S5、Q3–Q5、P3、P5–P7 共 8 项
- **方法**: 只读源码逐项核实，附 `file:line` 证据；不修改 `src/**`
- **结论汇总**: ✅ 4 项已修复 / ⚠️ 3 项部分 / ❌ 0 项完全未修复（1 项原 Q1 附带确认已修）

| ID | 主题 | 结论 | 关键证据 |
|---|---|---|---|
| S5 | commandNormalizer 危险命令绕过 | ⚠️部分 | `commandNormalizer.ts:14-32`、`readonlyCommands.ts:191-220` |
| Q3 | 静默吞错点 | ⚠️部分 | `acp/handlers.ts:103-106` 已修；残余见下 |
| Q4 | FileEditTool 错误处理 | ✅已修复 | `FileEditTool/index.ts:146-163` |
| Q5 | Zod `as any` | ✅已修复 | `zodToJsonSchema.ts:1-29` |
| P3 | 全局并发信号量 | ✅已修复 | `toolExecutor.ts:111-124,509-514` |
| P5 | 全量对话常驻 / token 估算 | ⚠️部分 | `QueryEngineState.ts:15,75,98-107,217-220` |
| P6 | 压缩额外 LLM 调用主路径 | ✅已修复 | `QueryEngine.ts:724-750`、`QueryEngineCompaction.ts:247-277` |
| P7 | 每请求重序列化 | ✅已修复 | `BaseApiClient.ts:43-51,154-258,266-293` |

---

## 逐项证据

### S5 — 危险命令检测可被变量展开 / base64 / 引号绕过 → ⚠️部分

**原问题**（CODE_REVIEW S5）：正则匹配可被空格、变量展开、base64、引号、`$(...)` 绕过。

**现状**：

- 归一化器已落地：`src/permissions/commandNormalizer.ts:14-32` 处理零宽字符、同形字、反斜杠转义、多空白；`splitSubCommands`（`:93-102`）按 `| ; && ||` 拆子命令。
- 危险判定已升级为 bypass-resistant：`src/permissions/readonlyCommands.ts:191-220` `isDangerousBashCommand`：
  - pipe-to-shell：`:202` `/\|\s*(?:sh|bash)\b/`
  - base64 解码：`:204` `base64` + `-d/--decode`
  - 高危原语不依赖参数形态：`:208` `rm` + 任意 `-rf/-R -f/--recursive --force` 组合（`hasRecursiveForceFlags` `:163-172`）；`:209-213` `mkfs` / `dd of=/dev/` / `chmod 777` / `shutdown`
  - 变量赋值 / 命令替换：关键字字面量仍出现在命令串中，归一化后可命中（注释 `:178-181`）
- 引号误报防护：`shellAwareNormalize`（`:18-31`）剥离单/双引号与注释后再匹配。
- BashTool 调用点：`src/tools/BashTool/index.ts:126` `checkDangerousCommand(..., { normalize: true })`。

**残余缺口**（故为部分）：

1. 引号拆词绕过：`r''m -rf /` 或 `r""m -rf /` 经 `shellAwareNormalize` 剥离引号后变成 `r m`，不再匹配 `\brm\b`（`readonlyCommands.ts:22,25` + `:208`）。
2. ANSI-C / `$'...'` 与 `${var}` 间接展开未专门处理；`commandNormalizer.ts` 无对应步骤。
3. 无 AST/分词级归一化，仍以字符串正则为主（CODE_REVIEW 修复建议「语法树/分词归一化」未做）。

**建议**：在 `isDangerousBashCommand` 前对剥引号结果再做一次「相邻引号段拼接」归一化；或对 `rm/mkfs/dd/chmod` 采用分词后 token 匹配而非连续正则。

---

### Q3 — 静默吞错点 → ⚠️部分

**原问题**（CODE_REVIEW Q3）：`im-bridge.ts:157`、`agent-orchestrator.ts:171`、`App.ts:319` 使用 `.catch(() => {})`。

**已修复点**：

| 原位置 | 现状 | 证据 |
|---|---|---|
| ACP 后台 Agent（Q1，连带） | 日志 + `agent/error` 通知 | `src/acp/handlers.ts:103-106` |
| `im-bridge.ts:157` | `logger.services.error` + 回复失败再记日志 | `src/im/im-bridge.ts:155-157` |
| `App.ts:319` | 文件已更名 `AppRoot.tsx`，未见同构空 catch（路径消失） | — |

**仍存在的空/静默 catch**（故为部分）：

| 位置 | 形态 | 性质 |
|---|---|---|
| `src/im/im-bridge.ts:66-68` | `catch { // Ignore disconnect errors }` | 关机路径，可接受但无日志 |
| `src/orchestrator/agent-orchestrator.ts:244` | `void promise.catch(() => {})` | 有注释说明防 unhandledRejection；失败仍会经 `settleTrackedError` 上报，但该 catch 本身静默 |
| `src/orchestrator/agent-orchestrator.ts:535-536` | `catch { return false; }` | resume 兜底 sendMessage 失败无日志 |
| `src/tools/FileEditTool/index.ts:52-55` | `catch { stamp = null }` | stat best-effort，有注释 |
| `src/tools/FileEditTool/index.ts:87` | `.catch(() => null)` | 冲突检查 stat，best-effort |

**建议**：为 `agent-orchestrator.ts:535` 与 `im-bridge.ts:66` 补 `logger.*.warn`；`void promise.catch` 改为 `.catch(err => logger.orchestrator.debug(...))` 保留诊断痕迹。

---

### Q4 — FileEditTool 错误处理弱于 Bash/Git → ✅已修复

**原问题**：`error instanceof Error ? error.message : String(error)` 丢弃栈信息，不区分 exec/校验错误。

**现状**：`src/tools/FileEditTool/index.ts:146-163`：

- `getErrorMessage(error)`（`:147`）
- `getErrorStack(error)` → `metadata.stack`（`:151-154`）
- `isExecError(error)` → 保留 `exitCode` / `signal` / `stderr`（`:157-161`）

与 `BashTool/index.ts:112-118`（`getErrorMessage` + `isExecError` + exitCode/stderr）同一套工具函数，栈信息不再丢失。

---

### Q5 — Zod 内部经 `as any` 访问 → ✅已修复

**原问题**：`src/utils/zodToJsonSchema.ts:162` `const def = schema._def as any;`。

**现状**：整个文件重写为对维护库的薄封装（T22）：

- `src/utils/zodToJsonSchema.ts:17` `import { zodToJsonSchema as convertWithZodToJsonSchema } from 'zod-to-json-schema'`
- `:23-28` 仅传 `$refStrategy: 'none'`，**无任何 `_def` / `as any` 访问**
- 旧实现与逐工具等价性夹具见文件头注释（`:4-14`）与 `test/utils/zodToJsonSchema-migration.test.ts`

**关联**：T5 checklist 中 zod@3→4 评估仍未完成，但 Q5 本体（`as any` 访问 Zod 内部）已消除。

---

### P3 — 每子 Agent 独立 ToolExecutor 使全局并发上限形同虚设 → ✅已修复

**原问题**：`DEFAULT_MAX_CONCURRENT_TOOLS=5` 每执行器一份，N 子 Agent → 5N OS/网络并发。

**现状**：`src/executors/toolExecutor.ts`：

- `:104` 保留每执行器 `DEFAULT_MAX_CONCURRENT_TOOLS = 5`（非 OS 工具仍按执行器限流，合理）
- `:111` `OS_NETWORK_TOOLS = {Bash, Run, WebFetch, Sql}`
- `:117` `DEFAULT_GLOBAL_TOOL_CONCURRENCY = max(4, os.cpus().length)`
- `:124` `export const GLOBAL_TOOL_SEMAPHORE = new Semaphore(...)` 进程级共享
- `:509-514` 执行时 OS/网络工具先取全局信号量再取执行器信号量：

```ts
const result = OS_NETWORK_TOOLS.has(toolCall.toolName)
  ? await GLOBAL_TOOL_SEMAPHORE.withPermit(runWithExecutorPermit)
  : await runWithExecutorPermit();
```

N 个子 Agent 的 Bash/Run/WebFetch/Sql 并发被进程级上限约束，5N 问题消除。

---

### P5 — 全量对话常驻内存 + token 估算全量重算 → ⚠️部分

**原问题**：默认保留 1000 条消息；`getTokenEstimate` 失效后全量重算。

**已改进**：

| 点 | 证据 |
|---|---|
| 默认上限 1000 → **200** | `src/query/QueryEngineState.ts:15` `DEFAULT_MAX_MESSAGES = 200` |
| 增量 token 累计 | `:32` `runningTokenTotal`；`addMessage` `:75` 逐条累加 |
| `setMessages` 可跳过全量重算 | `:98-107` 接受 `knownTotal` |
| trim 只减被删消息 | `:217-220` `runningTokenTotal -= estimateMessageTokensArray(removed)` |
| 热路径读缓存 | `:129-131` `getTokenEstimate()` 直接返回 running total |

**仍为部分的原因**：

1. 对话消息仍全量常驻内存（CLI 场景可接受，但「常驻」本身未改）。
2. `invalidateTokenEstimate`（`:133-137`）仍全量重算，分支切换（`branch`/`checkout` `:232,243`）也触发全量重算。
3. 压缩阈值与激进度未在本项范围内单独下调（`functional.ts:19` `MAX_TOKEN_LIMIT = 128_000` 为绝对上限）。

**建议**：分支切换可复用父节点 running total 做差量；长期可考虑消息内容外置（大 tool result 落盘 + 摘要占位）。

---

### P6 — 压缩触发时额外非流式 LLM 调用叠加主路径 → ✅已修复

**原问题**：自动压缩以 `chat({stream:false})` 同步阻塞主路径（60s 超时）。

**现状**：

- 主路径 `compactingPhase` 已改为 fire-and-forget：`src/query/QueryEngine.ts:724-750`
  - `:741-748` 调 `this.compaction.triggerFullCompactAsync(...)` 后立即 return
  - `:724-727` 注释明确「LLM-based summarization path is fire-and-forget」
- 异步实现：`src/query/QueryEngineCompaction.ts:247-277`
  - `:253` 在途去重（`pendingCompactPromise !== null` 则 no-op）
  - `:241` 文档承诺 Always returns immediately (< 50 ms)
- 结果在下一次 streaming 前经 `drainPendingCompactResult`（`:292-325`）合并，保留触发后新增消息（`:316-322`）。
- 同步 `compact()` 方法仍存在（`:81-175`）但非主状态机路径。

---

### P7 — formatMessages / formatTools 每次请求重序列化 → ✅已修复

**原问题**：每次请求重建整消息数组与工具 JSON Schema。

**现状**：`src/api/BaseApiClient.ts` 已加多层缓存：

| 缓存 | 证据 |
|---|---|
| 单消息格式化缓存 | `:43` `_msgFormatCache`；`:171-176` 命中则跳过重格式化 |
| 整数组引用缓存 | `:47` `_msgFullCache`；`:155-163` ids+contentHash 全等则直接返回 |
| 工具规格缓存 | `:51` `_toolsFormatCache`；`:266-292` 按 name+schemaJSON 复合键缓存 |
| 内容哈希失效 | `:57-80` `hashContent` djb2，id 不变但内容变时仍会重算 |

QueryEngine 侧另有按 conversation version 的 `apiMessagesCache`（`src/query/QueryEngine.ts:836-843`），重试循环内复用已构建数组。

**残余**：缓存 key 的 `hashContent` 对每条消息仍做 `JSON.stringify`（`:69`），在超长 tool result 上有固定开销；属可接受折中，不构成原问题（整数组重复全量序列化）。

---

## 结构化 Backlog（未修复 / 部分修复残留）

| 编号 | 位置 | 问题 | 建议 | 优先级 |
|---|---|---|---|---|
| T6-B1 | `src/permissions/readonlyCommands.ts:18-31` + `:208` | 引号拆词 `r''m` / `r""m` 剥离后不再匹配 `\brm\b` | 剥引号后做相邻段拼接再匹配；或分词 token 匹配高危原语 | P2 |
| T6-B2 | `src/permissions/commandNormalizer.ts` | 无 `$'...'` ANSI-C 与 `${var}` 展开处理 | 在 normalize 增加 ANSI-C 引号解码步骤 | P3 |
| T6-B3 | `src/orchestrator/agent-orchestrator.ts:535-536` | resume 兜底 `catch { return false }` 无日志 | 补 `logger.orchestrator.warn` | P3 |
| T6-B4 | `src/im/im-bridge.ts:66-68` | disconnect 空 catch 无日志 | 补 `logger.services.debug/warn` | P4 |
| T6-B5 | `src/orchestrator/agent-orchestrator.ts:244` | `void promise.catch(() => {})` 完全静默 | 改为 debug 级日志保留诊断 | P4 |
| T6-B6 | `src/query/QueryEngineState.ts:232,243` | branch/checkout 触发 token 全量重算 | 子分支复用父 running total 差量更新 | P3 |
| T6-B7 | `src/query/QueryEngineState.ts:15` | 消息仍全量常驻（上限已降 200） | 大 tool result 外置落盘 + 摘要占位（长期） | P4 |

---

## 与 Spec / Tasks 的同步

- `architecture-hardening-tasks.md` T6 Status → `completed`，checklist 勾选，指向本文档。
- 已修复项（Q4/Q5/P3/P6/P7）建议回填 `architecture-hardening-spec.md` §1.1 表（若该表仍维护）。
- T6-B1–B7 可作为后续独立 backlog 迭代，不阻塞 T6 关闭。

---

## 复核方法说明

- 源码只读；未跑完整测试套件（符合任务硬性要求）。
- 关键路径逐行读取；grep/glob 工具因本机 ripgrep 下载失败不可用，改为直接读取已知路径文件。
- 行号以 2026-07-28 工作区为准。
