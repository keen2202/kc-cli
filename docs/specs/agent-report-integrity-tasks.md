# Tasks: 子代理汇报完整性加固（Agent Report Integrity）

- **关联 Spec**：`docs/specs/agent-report-integrity-spec.md`（RI-SPEC v1.0）
- **依据报告**：`D:\Workespace\kc-cli\.workbuddy\eval\LT1-EVAL-REPORT.md`
- **状态口径**：pending（待开始）/ in_progress（进行中）/ completed（已完成）/ blocked（存在未满足依赖）
- **追踪规则**：始终保持 ≥1 项 in_progress；状态变更双向同步到 Spec §5 追踪表

## 总览

| ID | 任务 | Status | blockedBy | blocks |
|---|---|---|---|---|
| RI-T01 | 评审并批准 RI-SPEC | **in_progress** | — | RI-T02, RI-T03, RI-T04, RI-T05, RI-T06, RI-T07, RI-T08 |
| RI-T02 | 定义 CompletionClaim 协议类型 | pending | RI-T01 | RI-T03, RI-T04, RI-T06 |
| RI-T03 | 实现 ReportValidator（R1–R3） | blocked | RI-T02 | RI-T07, RI-T08 |
| RI-T04 | 实现数字声明证据绑定（R2 对账） | blocked | RI-T02 | RI-T08 |
| RI-T05 | 系统提示"汇报义务"独立分区 | blocked | RI-T01 | RI-T08 |
| RI-T06 | ExecutionEnv 留痕 + 边界核验（R4/R5） | blocked | RI-T02 | RI-T08 |
| RI-T07 | 编排层检查站闸门与自动追问 | blocked | RI-T03 | RI-T08 |
| RI-T08 | 回归测试与全量验证 | blocked | RI-T03, RI-T04, RI-T05, RI-T06, RI-T07 | RI-T09 |
| RI-T09 | 更新 AGENTS.md 风险边界与编排文档 | blocked | RI-T08 | — |
| RI-T10 | harness 基线落盘与探针脚本化 | pending | — | — |

---

## RI-T01 — 评审并批准 RI-SPEC

- **Status**：in_progress
- **Dependencies**：blockedBy = []；blocks = [RI-T02, RI-T03, RI-T04, RI-T05, RI-T06, RI-T07, RI-T08]
- **任务描述**：
  - Imperative：Review and approve the agent report integrity spec
  - Present continuous：Reviewing and approving the agent report integrity spec
- **Checklist**：
  - [ ] 评审 Spec §2 问题分类与 P0/P1/P2 优先级排序是否认可
  - [ ] 评审 Spec §3 五组修复方案（声明-证据绑定 / 检查站闸门 / 留痕 / harness / 性能）的技术可行性
  - [ ] 确认 Spec §4 涉及文件清单无遗漏、无误伤（尤其"不改动"清单）
  - [ ] 确认 Spec §1 非目标（不改受试产物、不引入 LLM-judge、不动 permissions）
  - [ ] 批准后在 Spec 头部标记 `v1.0（已批准）`，本任务置 completed，RI-T02/RI-T05 解锁为 pending
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md`（全文）

## RI-T02 — 定义 CompletionClaim 协议类型

- **Status**：pending
- **Dependencies**：blockedBy = [RI-T01]；blocks = [RI-T03, RI-T04, RI-T06]
- **任务描述**：
  - Imperative：Define the CompletionClaim protocol types
  - Present continuous：Defining the CompletionClaim protocol types
- **Checklist**：
  - [ ] `src/orchestrator/protocol.ts` 新增 `CommandRunClaim` / `CompletionClaim` / `RequiredSections` / `ReportFinding` 类型
  - [ ] `src/orchestrator/types.ts` 的 `SubAgentSpawnConfig` 增加 `checkpoints?` 与 `reportPolicy?`；`SubAgentResult` 增加可选 `claim?` / `meta?`（向后兼容，不改既有必选字段）
  - [ ] 类型导出遵循 protocol-first 惯例（公共类型集中于 protocol.ts）
  - [ ] `npm run typecheck` 零新增错误
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.1、§4

## RI-T03 — 实现 ReportValidator（规则 R1–R3）

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T02]；blocks = [RI-T07, RI-T08]
- **任务描述**：
  - Imperative：Implement the ReportValidator with rules R1–R3
  - Present continuous：Implementing the ReportValidator with rules R1–R3
- **Checklist**：
  - [ ] 新建 `src/orchestrator/report-validator.ts`（纯函数 `validateReport()`，目录命名风格对齐 `result-aggregator.ts`）
  - [ ] R1 必需节段缺失 → blocker；R2 计数声明无 `evidenceLine` → blocker；R3 义务引用缺失 → warning
  - [ ] 单次校验 < 5ms（万字报告），无 LLM 调用
  - [ ] 新建 `test/orchestrator/report-validator.test.ts`：正面夹具 + LT-1 三个真实反面案例 + 边界夹具，全绿
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.1、§6

## RI-T04 — 实现数字声明证据绑定（R2 对账）

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T02]；blocks = [RI-T08]
- **任务描述**：
  - Imperative：Implement claim-evidence binding for numeric claims
  - Present continuous：Implementing claim-evidence binding for numeric claims
- **Checklist**：
  - [ ] 计数声明（如"N 个用例"）必须可解析出数值并与 `CommandRunClaim.evidenceLine` 对账
  - [ ] 无证据或对账不符 → blocker 并标注 `unsubstantiated`
  - [ ] 对账逻辑容错：不可解析的输出降级为 warning 而非 blocker
  - [ ] 单元测试覆盖编造数字、真实数字、不可解析三种路径
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.1、§6

## RI-T05 — 系统提示"汇报义务"独立分区

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T01]；blocks = [RI-T08]
- **任务描述**：
  - Imperative：Separate reporting obligations into a dedicated prompt section
  - Present continuous：Separating reporting obligations into a dedicated prompt section
- **Checklist**：
  - [ ] `src/orchestrator/agent-definitions.ts` 的子代理系统提示增加独立 `## Reporting obligations` 区
  - [ ] 区内声明：完成声明必须引用义务出处；无输出时只能报"依据退出码"，禁止精确数字
  - [ ] 不改动任务规格区的既有内容与顺序
  - [ ] 对应快照/单测（如存在 prompt 组装测试）同步更新并通过
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.2

## RI-T06 — ExecutionEnv 留痕 + 边界核验（R4/R5）

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T02]；blocks = [RI-T08]
- **任务描述**：
  - Imperative：Implement execution tracing and boundary attestation
  - Present continuous：Implementing execution tracing and boundary attestation
- **Checklist**：
  - [ ] `src/services/execution-env.ts` 在子代理作用域记录命令摘要（命令、退出码、stdout ≤4KB）与写入文件清单，随 `SubAgentResult.meta` 传递
  - [ ] 留痕仅内存级、有界截断，不落盘
  - [ ] validator 规则 R4：claim 文件清单 vs 留痕写入，未声明写入或漏报 → blocker
  - [ ] validator 规则 R5：环境类声明与留痕矛盾 → warning
  - [ ] 单元测试覆盖越界写入检出与误报豁免
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.3、§6

## RI-T07 — 编排层检查站闸门与自动追问

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T03]；blocks = [RI-T08]
- **任务描述**：
  - Imperative：Implement the checkpoint gate and auto follow-up in the orchestrator
  - Present continuous：Implementing the checkpoint gate and auto follow-up in the orchestrator
- **Checklist**：
  - [ ] `agent-orchestrator.ts` 在子代理返回后调用 `validateReport()`；blocker 且未达 `maxFollowUps`（默认 1，硬顶 2）→ 自动生成追问并 resume
  - [ ] 追问耗尽仍有 blocker → finding 注入 `AggregatedResult` 并显式标记未决（`result-aggregator.ts`）
  - [ ] warning 不触发追问，仅注入元数据
  - [ ] 新建 `test/orchestrator/report-followup.test.ts`：追问一次、上限拦截、未决标注三路径全绿
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.2、§6

## RI-T08 — 回归测试与全量验证

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T03, RI-T04, RI-T05, RI-T06, RI-T07]；blocks = [RI-T09]
- **任务描述**：
  - Imperative：Run regression tests and full verification
  - Present continuous：Running regression tests and full verification
- **Checklist**：
  - [ ] 限定范围测试（Spec §6 两条命令原文）通过并留存输出
  - [ ] `npm run typecheck` 零新增错误
  - [ ] `npm test` 全量通过，覆盖率不低于阈值（lines 60 / branches 50 / functions 60 / statements 60）
  - [ ] 重放 LT-1 harness 端到端复核：探针回避被拦截、数字编造被标记、合规幻觉被拦截
  - [ ] 验证结果四要素（任务 ID、文件、变更、验证输出）写入 Spec §5 追踪表
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §6

## RI-T09 — 更新 AGENTS.md 风险边界与编排文档

- **Status**：blocked
- **Dependencies**：blockedBy = [RI-T08]；blocks = []
- **任务描述**：
  - Imperative：Update AGENTS.md and orchestrator docs for the integrity layer
  - Present continuous：Updating AGENTS.md and orchestrator docs for the integrity layer
- **Checklist**：
  - [ ] `AGENTS.md` 的 Orchestrator 条目补充汇报完整性层（validator / gate / 留痕）
  - [ ] `AGENTS.md` Risk Boundaries 章节补充"零信任汇报"行为约束
  - [ ] CLAUDE.md 不重复内容（遵循单一事实源原则，仅确认引用有效）
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3、§4

## RI-T10 — harness 基线落盘与探针脚本化

- **Status**：pending（独立于 RI-T01，可随时开始）
- **Dependencies**：blockedBy = []；blocks = []
- **任务描述**：
  - Imperative：Harden the eval harness with file-based baselines and scripted probes
  - Present continuous：Hardening the eval harness with file-based baselines and scripted probes
- **Checklist**：
  - [ ] 基线命令输出同步写入 `.workbuddy/eval/<run>/baseline/*.log`，跨轮以文件为准
  - [ ] 探针作答关键词校验脚本化，未命中立即追问
  - [ ] 数字结论以控制者复跑输出为准并回写
  - [ ] 同步更新 `~/.workbuddy/skills/agent-longtask-eval-harness/SKILL.md` 的"已知陷阱"一节
- **Spec Documentation**：`docs/specs/agent-report-integrity-spec.md` §3.4
