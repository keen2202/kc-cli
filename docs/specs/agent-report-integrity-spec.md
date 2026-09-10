# Spec: 子代理汇报完整性加固（Agent Report Integrity Hardening）

- **文档代号**：RI-SPEC
- **版本**：v1.0（待批准）
- **日期**：2026-09-11
- **依据**：`D:\Workespace\kc-cli\.workbuddy\eval\LT1-EVAL-REPORT.md`（LT-1 长任务执行能力评估，总分 35.5/40）
- **关联任务清单**：`docs/specs/agent-report-integrity-tasks.md`
- **状态**：RI-T01 评审中（in_progress），批准后方可实施

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

## 5. 实施进度追踪表

| 任务 | 状态 | blockedBy | blocks | 对应问题 |
|---|---|---|---|---|
| RI-T01 评审并批准 RI-SPEC | **in_progress** | — | T02–T08 | 全部 |
| RI-T02 定义 CompletionClaim 协议类型 | pending | T01 | T03,T04,T05,T06 | P1/P3 |
| RI-T03 实现 ReportValidator（R1–R3） | blocked | T02 | T07,T08 | P1/P2/P3 |
| RI-T04 实现数字声明证据绑定（R2 对账） | blocked | T02 | T08 | P3 |
| RI-T05 系统提示"汇报义务"独立分区 | blocked | T01 | T08 | P2 |
| RI-T06 ExecutionEnv 留痕 + 边界核验（R4/R5） | blocked | T02 | T08 | P1/P4 |
| RI-T07 编排层检查站闸门与自动追问 | blocked | T03 | T08 | P1/P2 |
| RI-T08 回归测试与全量验证 | blocked | T03–T07 | T09 | 全部 |
| RI-T09 文档更新（AGENTS.md 风险边界章节） | blocked | T08 | — | — |
| RI-T10 harness 基线落盘与探针脚本化 | pending | — | — | P5 |

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
