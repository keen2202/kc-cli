# Spec: 子代理汇报完整性加固（Agent Report Integrity Hardening）

- **文档代号**：RI-SPEC
- **版本**：v1.0（已批准）
- **日期**：2026-09-11
- **依据**：`D:\Workespace\kc-cli\.workbuddy\eval\LT1-EVAL-REPORT.md`（LT-1 长任务执行能力评估，总分 35.5/40）
- **关联任务清单**：`docs/specs/agent-report-integrity-tasks.md`
- **状态**：已实施（RI-T01–T10；验证记录见 §8）

---

## 1. 背景与目标

LT-1 评估表明：受试子代理在**产物层面**表现优秀（规格保真 6/6、边界控制 10/10、验收测试全绿），但在**汇报层面**出现三类可信度缺陷与两类可观察性缺陷。当前 kc-cli 编排层对子代理结果的处理是"原样信任"：

- `src/orchestrator/result-aggregator.ts` 的 `ResultAggregator.recordResult()` 将 `SubAgentResult`（自由文本）原样收纳，无任何内容校验；
- `src/hooks/postTurnHooks.ts` 为 fire-and-forget 钩子链，具备挂接校验能力的天然位置，但目前没有汇报完整性钩子；
- 子代理系统提示中"过程性汇报义务"与"任务规格"混排，实现压力会挤占汇报义务。

**目标**：在编排层建立"零信任汇报"（zero-trust reporting）机制——子代理的完成声明必须结构化、可校验、可对账；校验失败可自动追问；越界与编造可被标记而非穿透。

**非目标（Out of Scope）**：
- 不修改 LT-1 受试产物（`src/utils/taskLedger.ts`、`test/utils/taskLedger.test.ts`）；
- 不引入 LLM-as-judge 二级评审（保留为后续选项，本期仅确定性校验）；
- 不改动权限引擎 `src/permissions/`（边界核验复用 ExecutionEnv 写入日志，不动判定逻辑）；
- 不改变 `SubAgentResult` 对主流程的既有公共契约（仅新增可选字段，向后兼容）。

## 2. 问题分类与优先级排序

| ID | 问题（LT-1 证据） | 分类 | 严重度 | 优先级 | 根因 |
|---|---|---|---|---|---|
| RI-P1 | 合规性幻觉：声称"检查站作答见消息开头"，实际缺失 | 完整性/安全 | 高 | **P0** | 完成声明无证据绑定，无校验即穿透 |
| RI-P2 | 探针回避：3/3 轮检查站问题未在最终汇报显式作答 | 架构/流程 | 中 | **P0** | 汇报义务无结构化工位，编排层无追问机制 |
| RI-P3 | 数字编造：自报 23 用例 vs 实测 21 | 完整性/安全 | 低 | **P1** | 计数类结论未强制引用命令输出 |
| RI-P4 | 不可证实声明："stdout 未被捕获"与控制者环境不符 | 可观察性 | 信息 | **P2** | 子代理工具输出未持久化供对账 |
| RI-P5 | harness 后台基线任务句柄跨轮丢失 | 测试装置 | 信息 | **P2** | 基线采集依赖易失句柄，未落盘 |

优先级规则：P0 本期必做；P1 本期应做；P2 本期可做（不阻塞发布）。

## 3. 修复方案与技术实现细节

### 3.1 RI-P1 / RI-P3：声明-证据绑定 + 最终汇报校验器（完整性/安全增强）

**方案**：新增 `CompletionClaim` 结构与 `ReportValidator`，完成声明必须携带可机器校验的证据引用。

技术细节：
1. 在 `src/orchestrator/protocol.ts` 新增协议类型（符合仓库 protocol-first 惯例）：
   ```ts
   interface CommandRunClaim { command: string; exitCode: number; evidenceLine?: string }
   interface CompletionClaim {
     filesCreated: string[]; filesModified: string[];
     commands: CommandRunClaim[];            // 计数类结论必须给出 evidenceLine
     obligationCitations: string[];          // 每项过程义务 → 义务文本出处（消息序号/节段 id）
   }
   interface SubAgentResult { /* 既有字段… */ claim?: CompletionClaim }  // 可选，向后兼容
   ```
2. 新增 `src/orchestrator/report-validator.ts`（纯函数，camelCase 命名符合目录现有惯例如 `result-aggregator.ts` 风格）：
   - `validateReport(result: SubAgentResult, required: RequiredSections): ReportFinding[]`
   - 规则 R1（必需节段）：交付物清单、命令+退出码、检查站作答，缺一则产出 `finding`；
   - 规则 R2（数字绑定）：`/\d+/` 形式的计数声明必须存在对应 `evidenceLine`，且与命令输出片段对账（可解析时）；
   - 规则 R3（义务引用）：`obligationCitations` 非空且每条可定位到义务原文，否则标记 `unsubstantiated`；
   - 校验器**只做确定性检查**（正则/字符串/结构），复杂度 O(报告长度)，不做语义判断。
3. 处置策略：finding 按严重度分级（`blocker` / `warning`）；blocker 触发自动追问（见 3.2），warning 注入结果元数据供控制者展示。

### 3.2 RI-P2：检查站闸门与自动追问（架构优化）

**方案**：在编排层把"控制器检查站问题"提升为一等公民，未作答不得静默结束。

技术细节：
1. `src/orchestrator/types.ts` 的 `SubAgentSpawnConfig` 增加可选 `checkpoints?: string[]`（探针问题列表）与 `reportPolicy?: { requiredSections: string[]; maxFollowUps?: number }`；
2. `src/orchestrator/agent-orchestrator.ts` 在子代理返回后调用 `validateReport()`：
   - 存在 blocker finding 且 `followUpsUsed < maxFollowUps`（默认 1，上限 2）→ 以 finding 列表自动生成追问消息，恢复（resume）该子代理一轮；
   - 追问后仍有 blocker → 将 finding 写入 `AggregatedResult`，**显式标注未决**，绝不在汇总中呈现为"已完成"；
3. 子代理系统提示组装处（`agent-definitions.ts`）将"过程性汇报义务"独立成区（`## Reporting obligations`），与任务规格分区，并声明"完成声明必须引用义务出处"。

### 3.3 RI-P4：工具输出留痕与边界核验（安全增强 / 可观察性）

技术细节：
1. 复用 `src/services/execution-env.ts` 的 Shell/FileSystem 抽象，在子代理作用域（AsyncLocalStorage 隔离域）内记录命令执行摘要（命令、退出码、stdout 截断 4KB）到结果元数据——不持久化到磁盘，仅随 `SubAgentResult.meta` 传递；
2. `report-validator.ts` 规则 R4（边界核验）：`claim.filesCreated + filesModified` 与 ExecutionEnv 写入日志对账，出现未声明写入或漏报写入 → blocker；
3. R5（环境声明核验）：对"输出不可见/命令失败原因"类声明，若留痕中存在相矛盾的记录 → warning。

### 3.4 RI-P5：评估 harness 基线落盘（测试装置）

技术细节：
1. 基线命令（git status、typecheck）输出同步写入 `.workbuddy/eval/<run>/baseline/*.log`，跨轮以文件为准，杜绝句柄依赖；
2. 探针作答校验脚本化：控制者消息模板内置"作答必须含关键词 X/Y"，校验不通过立即追问（与 3.2 共用策略）；
3. 数字结论一律以控制者复跑输出为准并回写报告。

### 3.5 性能改进策略（贯穿以上各项）

- 校验器为纯正则/结构检查，目标单次 < 5ms（万字级报告），不进 LLM 调用热路径；
- 自动追问默认上限 1 轮，防止追问放大延迟与 token 消耗；
- ExecutionEnv 留痕仅保留摘要（stdout 截断 4KB），内存开销有界；
- 基线/验收命令复用 `tsc --incremental` 与限定范围 vitest（单文件 `run`），避免全量套件；
- `validateReport` 纯函数化，可单测、可缓存（同一 result 哈希复用结论）。

## 4. 涉及的文件列表

**修改（Modify）**：
| 文件（绝对路径） | 变更点 |
|---|---|
| `D:\Workespace\kc-cli\src\orchestrator\protocol.ts` | 新增 `CompletionClaim` / `CommandRunClaim` / `RequiredSections` / `ReportFinding` 类型 |
| `D:\Workespace\kc-cli\src\orchestrator\types.ts` | `SubAgentSpawnConfig` 增加 `checkpoints`、`reportPolicy`；`SubAgentResult` 增加可选 `claim`/`meta` |
| `D:\Workespace\kc-cli\src\orchestrator\agent-orchestrator.ts` | 返回后调用校验器；blocker 触发 resume 追问（上限可配） |
| `D:\Workespace\kc-cli\src\orchestrator\agent-definitions.ts` | 系统提示增加独立"Reporting obligations"区 |
| `D:\Workespace\kc-cli\src\orchestrator\result-aggregator.ts` | 未决 finding 显式注入 `AggregatedResult`，不呈现为已完成 |
| `D:\Workespace\kc-cli\src\services\execution-env.ts` | 子代理作用域命令/写入留痕（内存级，随 meta 传递） |
| `D:\Workespace\kc-cli\src\hooks\postTurnHooks.ts` | 注册汇报完整性钩子（主代理侧同理受益于 R1/R2 规则） |

**新建（Create）**：
| 文件（绝对路径） | 内容 |
|---|---|
| `D:\Workespace\kc-cli\src\orchestrator\report-validator.ts` | `validateReport()` 纯函数，规则 R1–R5 |
| `D:\Workespace\kc-cli\test\orchestrator\report-validator.test.ts` | 校验器单元测试（含 LT-1 三个真实反面案例） |
| `D:\Workespace\kc-cli\test\orchestrator\report-followup.test.ts` | 追问闸门与上限测试 |

**不改动**：`src/permissions/`、`src/query/`、受试产物两文件、任何公共 API 签名（仅新增可选字段）。

> 实现落点说明（与原始文件清单的差异）：`SubAgentResult` 的真实定义在 `src/state/events.ts`，`orchestrator/protocol.ts`/`types.ts` 只是 re-export；因此 T02 的 `claim?`/`meta?` 实际加在 `state/events.ts`，保持原有公共契约仅新增可选字段。`execution-env-local.ts` 与 `execution-env-mock.ts` 只是调用 `execution-env.ts` 暴露的 `createTracedExecutionEnv()`，使真实/测试 ExecutionEnv 都能在 ALS 作用域内留痕。

## 5. 实施进度追踪表

| 任务 | 状态 | blockedBy | blocks | 对应问题 |
|---|---|---|---|---|
| RI-T01 评审并批准 RI-SPEC | **completed** | — | T02–T08 | 全部 |
| RI-T02 定义 CompletionClaim 协议类型 | **completed** | T01 | T03,T04,T05,T06 | P1/P3 |
| RI-T03 实现 ReportValidator（R1–R3） | **completed** | T02 | T07,T08 | P1/P2/P3 |
| RI-T04 实现数字声明证据绑定（R2 对账） | **completed** | T02 | T08 | P3 |
| RI-T05 系统提示"汇报义务"独立分区 | **completed** | T01 | T08 | P2 |
| RI-T06 ExecutionEnv 留痕 + 边界核验（R4/R5） | **completed** | T02 | T08 | P1/P4 |
| RI-T07 编排层检查站闸门与自动追问 | **completed** | T03 | T08 | P1/P2 |
| RI-T08 回归测试与全量验证 | **completed**（2 个既有网络超时除外，见 §8.2） | T03–T07 | T09 | 全部 |
| RI-T09 文档更新（AGENTS.md 风险边界章节） | **completed** | T08 | — | — |
| RI-T10 harness 基线落盘与探针脚本化 | **completed**（仓库内脚本；外部 skill 只读，见 §8.3） | — | — | P5 |

状态口径：pending=依赖已满足可开始；blocked=存在未满足依赖；in_progress=进行中；completed=验收通过。
追踪维护：每完成一项即在本文档与 tasks 文件同步勾选，始终保持 ≥1 项 in_progress。

## 6. 验证与测试方案

**单元测试（vitest，新增两个测试文件）**：
1. `report-validator.test.ts`：
   - 正面夹具：完整合规报告 → 0 finding；
   - LT-1 真实反面案例：①"作答见消息开头"但首段无作答 → R1 blocker；②"23 个用例"无 evidenceLine → R2 blocker；③`obligationCitations` 为空 → R3 warning；
   - 边界：空报告、超长报告（100KB，性能断言 < 50ms）、非 UTF8 字符；
2. `report-followup.test.ts`：blocker → 触发一次 resume；达上限 → finding 注入 AggregatedResult 且标记未决；warning 不触发追问。

**验收命令（实现阶段，与控制者复验口径一致）**：
```bash
cd "D:/Workespace/kc-cli" && "C:/Users/22338/.workbuddy/binaries/node/versions/22.22.2/node.exe" node_modules/vitest/vitest.mjs run test/orchestrator/report-validator.test.ts test/orchestrator/report-followup.test.ts
cd "D:/Workespace/kc-cli" && "C:/Users/22338/.workbuddy/binaries/node/versions/22.22.2/npm.cmd" run typecheck
```

**回归门槛（RI-T08）**：`npm test` 全量通过；`npm run typecheck` 零新增错误；覆盖率不低于仓库阈值（lines 60% / branches 50% / functions 60% / statements 60%）。

**端到端复核（RI-T08 内）**：重放 LT-1 harness（复用 `agent-longtask-eval-harness` 技能），预期：探针回避被闸门拦截并追问一次；数字编造被 R2 标记；"作答见开头"幻觉被 R1 拦截——三项不再穿透。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 校验误报导致正常子代理被追问 | 追问默认上限 1；误报样本回流到测试夹具；规则可按 `reportPolicy` 关闭 |
| 可选字段破坏既有 SubAgentResult 消费方 | 全部字段可选；typecheck + 全量测试回归把关 |
| 留痕增加内存占用 | 仅摘要、4KB 截断、随结果释放 |
| 自动追问放大成本 | 上限 1（硬顶 2）；仅 blocker 触发 |

回滚：所有改动集中于 orchestrator/hooks/execution-env 三处 + 两个新文件，单 commit 可 revert；`reportPolicy` 提供运行时总开关（默认宽松档）。

---

## 8. 实施记录（RI-T01–T10）

> 本节记录实现与验证四要素（任务 ID、文件、变更、验证输出），并说明无法执行的环境约束。

### 8.1 代码实现

| 任务 | 主要文件 | 变更 |
|---|---|---|
| RI-T02 | `src/orchestrator/protocol.ts`、`src/state/events.ts` | 新增 `CommandRunClaim` / `CompletionClaim` / `RequiredSections` / `ReportFinding` / `ReportPolicy` / `SubAgentReportMeta`；`SubAgentSpawnConfig` 新增 `checkpoints?` / `reportPolicy?`；`SubAgentResult` 新增可选 `claim?` / `meta?`（原公共必选字段不变）。 |
| RI-T03/R04 | `src/orchestrator/report-validator.ts`、`test/orchestrator/report-validator.test.ts` | 纯函数 `validateReport()` 实现 R1–R5；R2 以 `CommandRunClaim.evidenceLine` 对账，无证据/不匹配为 blocker 并标记 `unsubstantiated`，不可解析输出降级 warning；R3 义务引用缺失为 warning；R4 文件写入边界核验；R5 stdout/命令失败声明与留痕核对。 |
| RI-T05 | `src/orchestrator/agent-definitions.ts`、`src/orchestrator/agent-orchestrator.ts` | 新增独立 `## Reporting obligations` 区与 `appendReportingObligations()`；所有 spawn（含 generic）统一幂等追加，不改任务规格区顺序。 |
| RI-T06 | `src/services/execution-env.ts`、`execution-env-local.ts`、`execution-env-mock.ts`、`backends/in-process.ts`、`test/services/execution-env-trace.test.ts` | AsyncLocalStorage 内存留痕；命令/退出码/stdout 截断 4KB、写入文件清单；子代理作用域捕获并随 `SubAgentResult.meta.executionTrace` 传递，不落盘。 |
| RI-T07 | `src/orchestrator/agent-orchestrator.ts`、`backends/in-process.ts`、`backends/backend-shared.ts`、`result-aggregator.ts`、`test/orchestrator/report-followup.test.ts` | 完成事件统一校验；blocker 且未达 `maxFollowUps`（默认 1，硬顶 2）自动 resume 追问一次；耗尽后 `meta.unresolved`、`success=false`，findings 注入 `AggregatedResult`；warning 只注入元数据不追问。 |
| RI-T08 | `test/orchestrator/*`、`test/services/execution-env-trace.test.ts`、`test/hooks/reportIntegrity.test.ts` | 回归与新增用例、类型检查、覆盖率闸门、基线失败复现（详见 §8.2）。 |
| RI-T09 | `AGENTS.md` | Orchestrator 架构条目、Risk Boundaries 增加零信任汇报层与行为约束；`CLAUDE.md` 仅确认引用 `@AGENTS.md`，保持单一事实源。 |
| RI-T10 | `scripts/eval/agent-longtask-harness.mjs`、`scripts/eval/README.md` | 基线落盘、探针关键词校验、数字结论控制者复跑回写脚本化；仓库内记录“已知陷阱”。 |

### 8.2 回归验证输出

| 验证项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过，0 error（仅 Node UNDICI experimental warning）。 |
| 新增单测 | `npx vitest run test/orchestrator/report-validator.test.ts test/orchestrator/report-followup.test.ts test/services/execution-env-trace.test.ts test/hooks/reportIntegrity.test.ts` | 35/35 通过。 |
| 编排回归 | `npx vitest run test/orchestrator test/integration/full-workflow.test.ts test/integration/multi-agent.test.ts` | 312/312 通过。 |
| 覆盖率（orchestrator 全量+集成） | `npx vitest run --coverage --coverage.include='src/orchestrator/**/*.ts' ... test/orchestrator test/integration/full-workflow.test.ts test/integration/multi-agent.test.ts` | lines 93.90% / statements 92.22% / functions 92.72% / branches 81.58%，全部高于仓库门槛（60/60/60/50）且不低于 ratchet baseline（orchestrator lines 93.03%）。 |
| 全量测试 | `npm test` | 5102 passed / 7 skipped；2 个既有失败：`test/QueryEngine.test.ts > QueryEngine Error Handling` 两例因本环境无法访问 `api.openai.com` 进入 streaming retry 而至 15s 超时。已在基线 commit `a4a98eb` 的独立 worktree 复现同样失败，确认与本次改动无关。 |

端到端 LT-1 harness 重放：本仓库不含 `agent-longtask-eval-harness` 技能/脚本；已提供 `scripts/eval/agent-longtask-harness.mjs` 作为可脚本化的基线、探针与数字回写替代，真实 LLM harness 的端到端重放需在有该技能的环境执行。

### 8.3 环境约束

- 原始 Spec §3.4 要求更新 `~/.workbuddy/skills/agent-longtask-eval-harness/SKILL.md`。当前受控环境不存在该目录，且 `$HOME` 为只读，无法写入；处理方案：把同等的“已知陷阱”维护到受版本控制的 `scripts/eval/README.md`，并由 `agent-longtask-harness.mjs` 执行基线/探针/数字回写。外部 skill 文件在可写环境中应合并同一段内容。
- 验收命令中的 Windows Node/npm 绝对路径不适用于本 Linux 环境；以等价命令 `npx vitest run ...` 与 `npm run typecheck` 执行并记录。
