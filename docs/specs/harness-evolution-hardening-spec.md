# kc-cli 自进化闭环加固（Self-Harness 对标）Spec

> 基于 2026-07-28 对 [qzzqzzb/Self-Harness](https://github.com/qzzqzzb/Self-Harness)（arXiv:2606.09498《Self-Harness: Harnesses That Improve Themselves》官方实现）的深度调研，以及对 kc-cli `src/agp/**`（SEPL 进化循环）、`src/api/prompts/**`、`src/query/**`、`src/executors/**`、`src/memory/**` 的只读核查编制
> Generated: 2026-07-28 | Version: 1.0 | Scope: `src/agp/**`、`src/api/prompts/**`、`src/query/**`、`src/memory/**`、`src/executors/toolExecutor.ts`
> 原则基线：**经验性状态转移（Empirical State Transition）** —— 任何 harness/prompt/策略的自动变更必须声明：改变什么行为、修改哪个面、什么证据驱动、什么评估结果支持晋升。所有新能力默认关闭，零行为变化向后兼容。

---

## 1. Executive Summary

Self-Harness 提出"评估 → 失败签名聚类 → 有界提案 → 双 split 回归验收 → 晋升/归档"的自改进闭环，在 Terminal-Bench-2.0 上对三个模型均取得显著且不回退的提升（最高相对提升 138%）。kc-cli 的 AGP/SEPL 模块（`src/agp/sepl/`）与其属同一范式，且**基础设施更完整**（版本谱系、自动回滚、七阶段审计、热替换、沙箱、预算控制均已具备），但在五个关键环节存在实质差距，另有四项工程模式值得移植：

| 维度 | Self-Harness | kc-cli 现状 | 差距评级 |
|---|---|---|---|
| 评估真实性 | 真实基准 + 确定性验证器 | `evaluate.ts` 纯启发式打分（估计影响 ± 风险加减分） | 🔴 致命 |
| 回归验收门 | held-in/held-out 双 split 非回退规则 | 允许 -0.1 回退、无 held-out 概念 | 🔴 缺失 |
| 失败挖掘 | (终端原因, 因果地位, 行为机制) 三元签名确定性聚类 | `trace-manager.ts` 按错误消息字符串计数 | 🟠 只有症状无机制 |
| 提示词注入 | 谓词触发的条件式中间件（按运行时状态按需注入） | `prompt-builder.ts` 静态拼接 | 🟠 缺失 |
| 运行时控制 | 重试纪律 / 探索循环熔断 / 工具消息上限 + 重定向 | 有超时/并发/权限，无跨轮行为策略 | 🟠 部分缺失 |
| 提案质量 | LLM 并行 K 候选 + 审计四元组 | `improve.ts` 占位实现（追加提示文本、数值随机扰动） | 🟠 占位且有害 |
| 与基准打通 | eval 桥直连 Terminal-Bench | QueryEngine 的 SWE-bench 机制与 SEPL 互不相连 | 🟡 断链 |

- **P0（3）：** 声明式指令面 + 条件式提示注入、运行时控制策略（重试纪律/循环熔断）、结构化失败签名。三项互相独立、可并行、均不触碰 UI red lines。
- **P1（2）：** 非回退回归验收门（纯函数，可 100% 单测）、EvaluatorBackend 抽象 + held-in/held-out 评估集。
- **P2（3）：** LLM 驱动提案器、候选谱系补全 + 版本化数据契约、失败签名→记忆桥接。
- **关键安全依赖：** LLM 提案器（T6）**必须**在真实回归门（T4/T5）就位后才允许启用——提案可以大胆，晋升必须有经验证据。当前 SEPL 的启发式评估配上激进提案器会导致未经验证的变更被提交。
- **Risk Profile:** Phase 1（Low，默认关闭 + 静态等价）/ Phase 2（Medium，引入真实执行评估）/ Phase 3（Medium，LLM 提案默认关闭）。
- **Total Estimated Effort:** 约 8–11 天。

### 1.1 调研证据对照（供追溯）

| 来源 | 关键证据 |
|---|---|
| Self-Harness 验收门 | `acceptance/scripts/run_acceptance_gate.py`：接受条件 `Δin ≥ 0 && Δho ≥ 0 && max(Δin,Δho) > 0`；repeats 平均；baseline/candidate 分母与 repeat id 硬校验（不可比即抛错）；输出版本化契约 `self_harness.acceptance_gate.v0` |
| Self-Harness 失败签名 | 论文 §3.2：`φ(r) = (c 终端验证器原因, q 因果地位, m 抽象行为机制)`，按签名精确一致确定性聚类；证据包不含处方（评估器与优化器分离） |
| Self-Harness 可编辑面 | `harnesses/qwen_tb2_final/repo_baseline.py`：`build_bootstrap/execution/verification/failure_recovery_instruction` 等声明式 `build_*` 函数；提案只能修改声明面 |
| Self-Harness 条件注入 | 同上：`_build_prompt_middleware(name, builder, predicate)` —— bootstrap 仅首轮注入（无 tool message 时）、failure-recovery 仅当上下文含工具错误、multimodal 仅当有图片输入 |
| Self-Harness 金规则 | 回归测试筛选保留的编辑：重试纪律（禁止同命令同参数重试）、探索循环熔断（连续 3 步无变更即换法）、产物优先恢复（缺失文件 1-2 步内直接创建）、依赖预检、`max_total_tool_messages` 上限 + 重定向 |
| kc-cli 评估缺口 | `src/agp/sepl/evaluate.ts:139-142`：`accepted = safetyPassed && primaryScore >= threshold && improvementDelta >= -0.1`（允许回退、无真实执行） |
| kc-cli 提案缺口 | `src/agp/sepl/improve.ts:193-226`：`template_rewrite` 仅追加一行提示文本；`variable_update` 为随机扰动（`Math.random()`） |
| kc-cli 挖掘缺口 | `src/agp/trace-manager.ts:384-389`：`failurePatterns` 按 `errorMessage ?? message` 字符串计数 |
| kc-cli 已有优势 | `version-manager.ts`（lineage/rollback/branch/diff）、`audit-log.ts`（七阶段审计 + 持久化）、`commit.ts`（基线快照 + autoRollback）、`sandboxManager`、`Semaphore`、`classifyToolError`（18 个稳定 ErrorCode） |

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| H1 | 提示词指令面未声明化、无条件式注入 | 架构 / 性能 | `PromptBuilder.buildSystemPrompt` 静态拼接全部指令段，failure-recovery 等指令常驻消耗 token 且时机不准 | 声明式 `InstructionSurface` 清单（bootstrap/execution/verification/failureRecovery），支持谓词触发按需注入，默认静态等价 |
| H2 | 缺少跨轮运行时控制策略 | 功能 / 健壮性 | 无重试纪律（同命令同参数反复失败重试不拦截）、无探索循环熔断、无工具消息上限重定向 | QueryEngine 层可配置的 `RuntimeControlPolicy`：重试拦截（软/硬）、只读循环熔断注入、`maxTotalToolMessages` 重定向 |
| H3 | 失败挖掘只有字符串计数 | 功能 / 可追溯 | `failurePatterns: Map<string, number>` 无法区分"症状"与"可复用失败机制"，Reflect 假设质量受限 | 三元失败签名 `(terminalCause, causalStatus, mechanism)` + 确定性聚类 + 证据包（不含处方） |
| H4 | SEPL 接受判定允许回退且无真实门禁 | 安全 / 正确性 | `evaluate.ts` 启发式打分 + 容忍 -0.1 回退 | 移植非回退验收门：`Δin ≥ 0 && Δho ≥ 0 && max > 0`，repeats 平均 + 分母一致性硬校验，纯函数实现 |
| H5 | 无真实评估器接口与评估集 | 架构 / 正确性 | Evaluate 不执行任何测试/基准；无 held-in/held-out 分割；与 QueryEngine 的 SWE-bench 链路断开 | `EvaluatorBackend` 接口 + vitest 子集首个实现 + 运行前固定的双 split 评估集，候选评估经沙箱隔离并行 |
| M1 | Improve 改进器为占位实现 | 功能 / 正确性 | 追加提示文本 / 数值随机扰动（可能有害） | LLM 驱动提案器（并行 K 候选，分支间多样、分支内最小），每提案附审计四元组（目标失败模式/修改面/预期效果/回归风险） |
| M2 | 候选谱系与数据契约不完整 | 可追溯 | 被拒候选未入审计；一轮多接受编辑无 MergeAccepted 语义；审计/序列化产物无格式版本标记 | AuditLog 新增 `rejected` 阶段 + 原因；VersionManager 合并提交语义；产物带 `kc.xxx.v1` 格式标记 |
| M3 | 失败经验未沉淀到记忆系统 | 功能 / 记忆 | TraceManager 失败记录与 memory 提取链路互不相通；feedback 记忆按文件名去重 | 证据包桥接 `extractMemoriesHybrid`，feedback 记忆按失败机制签名去重，存储分离"验证器级事实"与"推断机制" |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 声明式指令面 + 条件式提示注入（H1） | 1 | High | 1.5d | Low |
| P0 | T2 运行时控制策略（H2） | 1 | High | 1.5d | Low |
| P0 | T3 结构化失败签名 + 证据包（H3） | 1 | High | 1d | Low |
| P1 | T4 非回退回归验收门（H4） | 2 | High | 1d | Low |
| P1 | T5 EvaluatorBackend + 双 split 评估集（H5） | 2 | High | 2d | Medium |
| P2 | T6 LLM 驱动提案器（M1） | 3 | Medium | 2d | Medium |
| P2 | T7 候选谱系补全 + 版本化契约（M2） | 3 | Medium | 0.5d | Low |
| P2 | T8 失败签名→记忆桥接（M3） | 3 | Medium | 1d | Low |

---

## 3. Detailed Fix Proposals

### 3.1 Phase 1 — 运行时行为增强（P0，三项独立可并行）

#### 3.1.1 T1 — 声明式指令面 + 条件式提示注入（架构优化 + 性能改进 · H1）🔴

**Problem:** `PromptBuilder.buildSystemPrompt`（`src/api/prompts/prompt-builder.ts:35-98`）将所有指令段静态拼接进 system prompt：失败恢复类指令在无错误的轮次也常驻（浪费 token）；bootstrap 类指令在深轮次仍存在（时机失准）。同时指令面未声明化，AGP 的 `prompt-adapter.ts` 无法将其注册为可进化资源——PromptBuilder 与 AGP 注册表处于断开状态。

**Solution（架构优化 + 性能改进）：**
1. 新增 `src/api/prompts/instruction-surfaces.ts`：定义 `InstructionSurface { name, category: 'bootstrap'|'execution'|'verification'|'failureRecovery', build(ctx), predicate?(runtime), evolvable }`（类型入 protocol 文件，遵循 protocol-first 惯例）。
2. 将现有 PromptBuilder 各分段（planning/toolUse/languageInfo 验证提示等）重组为指令面清单；**默认所有面无 predicate、静态拼接，`buildSystemPrompt` 输出字节等价**（快照测试保证）。
3. QueryEngine turn 循环支持条件注入：`failureRecovery` 面仅当最近工具结果含 `isError` 时注入；`bootstrap` 面仅首轮注入。条件段追加为**最后一条 system 段**以最大化 KV 前缀缓存复用（用 `kvCacheMetrics` 验证命中率不劣化）。
4. 通过 `createPromptRecord`（`src/agp/adapters/prompt-adapter.ts`）将 evolvable 面注册为 AGP Prompt 资源，打通 PromptBuilder 与 AGP 注册表。
5. 配置 `promptSurfaces.conditionalInjection`（默认 `false`），走既有配置优先级链（defaults < user < project < env `KC_*` < CLI）。

**验证：** 开关关闭时 system prompt 与现状字节等价；开关开启时错误轮次注入 failureRecovery 段、正常轮次不注入；AGP 注册表能列出 evolvable 指令面；KV 缓存命中率不劣化。

**Files:** NEW `src/api/prompts/instruction-surfaces.ts`；MODIFY `src/api/prompts/prompt-builder.ts`、`src/query/QueryEngine.ts`（条件注入点）、`src/bootstrap/config.ts`（配置项）；关联 `src/agp/adapters/prompt-adapter.ts`。

---

#### 3.1.2 T2 — 运行时控制策略（功能增强 + 健壮性 · H2）🔴

**Problem:** kc-cli 有单工具超时、双层并发信号量、turn budget（`estimateTaskComplexity`），但缺少 Self-Harness 实验中被跨模型回归验证有效的三条跨轮行为策略：① 同命令同参数失败后反复重试不被拦截；② 连续多轮只读探索（Grep/FileRead/Glob）无写操作不被纠偏；③ 工具消息总量无上限与重定向。这正是长任务"卡死在无效循环"的主因之一（与项目记忆中"长期任务中断风险"结论一致）。

**Solution（功能增强）：**
1. 新增 `RuntimeControlPolicy` 类型（入 `src/query/protocol.ts` Benchmark Optimization 分节旁）：`{ enabled, maxSameCallRetries, retryIntervention: 'soft'|'hard', maxReadOnlyStreak, maxTotalToolMessages, redirectInstruction }`，默认 `enabled: false`。
2. QueryEngine 层维护 `(toolName, inputHash)` 近期调用环形历史：检测到同调用连续失败 ≥ N 次时，`soft` 模式向下一轮注入重试纪律指令（复用 T1 注入机制，独立文本兜底），`hard` 模式直接拒绝执行并返回结构化原因。
3. 只读循环熔断：连续 `maxReadOnlyStreak` 轮仅调用只读工具时注入"停止探索、转向实施与验证"指令。
4. `maxTotalToolMessages` 触顶后注入重定向指令（引导收敛产出），与既有 turn budget 互补不冲突。
5. `classifyToolError` 结果追加"上次相同调用也失败"上下文（轻量增强，独立于开关生效于错误输出文本）。
6. 全部事件记入 TraceManager（category `decision`），供 T3 失败签名与 SEPL Reflect 消费。

**验证：** 模拟同命令同参数连续失败，soft 注入指令 / hard 拒绝；连续只读轮触发熔断注入；开关关闭时行为与现状完全一致；`test/query/**` 无回归。

**Files:** MODIFY `src/query/protocol.ts`（类型）、`src/query/QueryEngine.ts`（策略执行点）、`src/bootstrap/config.ts`（配置项）、`src/utils/errorClassifier.ts` 或等价错误分类模块（重复失败上下文）；关联 `src/executors/toolExecutor.ts`、`src/agp/trace-manager.ts`。

---

#### 3.1.3 T3 — 结构化失败签名 + 证据包（功能增强 + 可追溯 · H3）🔴

**Problem:** `TraceManager.generateExecutionSummary`（`trace-manager.ts:384-389`）的 `failurePatterns` 按错误消息字符串计数——两次 timeout 可能需要完全不同的干预（探索超时 vs 下载超时），而字符串计数无法区分；Reflect 的五类启发式假设因此只能基于症状而非机制。

**Solution（功能增强，对齐论文 §3.2）：**
1. 在 `src/agp/sepl/protocol.ts` 新增 `FailureSignature { terminalCause: ErrorCode | string, causalStatus: 'direct'|'contributing'|'incidental', mechanism: FailureMechanism }`；`FailureMechanism` 为有限枚举：`retry_loop | missing_artifact | exploration_stall | schema_invalid | timeout_unbounded | permission_blocked | env_missing_dependency | unknown`。
2. `terminalCause` 复用 `KCError` 的 18 个稳定 ErrorCode 与 `classifyToolError` 分类结果；`mechanism` 由确定性规则从 trace 序列推断（如：同 `(toolName, inputHash)` 连续失败 ≥ 2 → `retry_loop`；`ENOENT`/`no such file` → `missing_artifact`；连续只读 ≥ N → `exploration_stall`）。
3. 按签名**精确一致**聚类，产出 `EvidenceBundle { clusters: [{ signature, count, representativeEvents, sharedSymptoms }] }`——**不含处方**，保持评估器与优化器分离。
4. `ReflectOperator` 消费证据包替代字符串计数（保留旧路径作为 fallback，`buildTraceSpace` 签名向后兼容）。

**验证：** 构造重试循环 / 缺失文件 / 探索停滞三类 trace 序列，签名与聚类结果确定且可复现；同 terminalCause 不同 mechanism 分入不同簇；Reflect 假设引用证据包字段；既有 `test/orchestrator/**`、SEPL 相关测试无回归。

**Files:** MODIFY `src/agp/sepl/protocol.ts`（类型）、`src/agp/trace-manager.ts`（签名推断 + 聚类）、`src/agp/sepl/reflect.ts`（消费证据包）；NEW `test/services/failure-signature.test.ts`（或 `test/orchestrator/` 下对应位置）。

---

### 3.2 Phase 2 — 真实评估与回归门禁（P1）

#### 3.2.1 T4 — 非回退回归验收门（安全增强 + 正确性 · H4）🔴

**Problem:** `EvaluateOperator.evaluateCandidate`（`evaluate.ts:139-142`）的接受判定 `improvementDelta >= -0.1` 允许回退，且分数来源是启发式估计而非真实执行。Self-Harness 的核心安全设计——"晋升必须有经验证据 + 任何 split 不许回退"——完全缺失。

**Solution（安全增强，逐条移植 `run_acceptance_gate.py` 规则）：**
1. NEW `src/agp/sepl/acceptance-gate.ts`：纯函数 `runAcceptanceGate(baseline, candidate, opts): GateDecision`。
2. 接受规则：`Δin ≥ 0 && Δho ≥ 0 && max(Δin, Δho) > 0`（所有 split 非回退，至少一个提升）。
3. 每 split 固定 repeats（默认 2）取平均 pass_rate；**分母一致性硬校验**：baseline 与 candidate 的 `(repeat, total)` 序列必须完全一致，不可比即抛出 `KCError`（新 ErrorCode 或复用既有校验类错误码），宁可拒绝比较也不产出误导性结论。
4. 输出版本化 JSON 契约 `format: "kc.acceptance_gate.v1"`（含 rule、splits 明细、decision、reason），持久化到 `.kc-cli/audit/`。
5. `CommitOperator` 接入：当 `SEPLConfig.acceptanceGate.enabled`（默认 `false`）时以门禁结论覆盖启发式判定；关闭时行为不变。

**验证：** 纯函数 100% 分支覆盖单测——improve/drop/unchanged 三态、分母不一致抛错、repeats 数不符抛错、`reason` 文本正确；门禁产物 JSON schema 校验；开关关闭时 SEPL 既有测试无回归。

**Files:** NEW `src/agp/sepl/acceptance-gate.ts`、`test/services/acceptance-gate.test.ts`（或 spec 对应测试目录）；MODIFY `src/agp/sepl/protocol.ts`（GateDecision/SplitResult 类型 + SEPLConfig 扩展）、`src/agp/sepl/commit.ts`（接入点）。

---

#### 3.2.2 T5 — EvaluatorBackend + 双 split 评估集（架构优化 + 正确性 · H5）🟠

**Problem:** Evaluate 不执行任何真实测试；无 held-in/held-out 概念；QueryEngine 的 SWE-bench 基准机制（`query/protocol.ts` v3.3 分节）与 SEPL 互不相连。没有真实评估器，T4 的门禁无数据可比，T6 的 LLM 提案无法安全启用。

**Solution（架构优化，评估器/优化器分离）：**
1. 在 `src/agp/sepl/protocol.ts` 定义 `EvaluatorBackend { evaluate(candidateState, split, opts): Promise<SplitResult> }`，`SplitResult` 结构与 T4 门禁输入对齐（`{ split, repeats: [{repeat, passed, total}] }`）。
2. 首个实现 `VitestEvaluatorBackend`：以项目内指定测试子集为验证器，经 `ExecutionEnv.Shell` 执行、沙箱包装、每候选独立运行避免环境污染（对应论文"each task starts from a fresh benchmark environment"）。
3. 评估集定义文件 `.kc-cli/evolution-eval.json`：held-in / held-out 任务列表**运行前固定、跨候选不变**；提供示例配置。
4. K 个候选并行评估，复用 `utils/semaphore.ts` 控并发；受 `services/budget.ts` 预算约束。
5. `EvaluateOperator` 支持注入 `EvaluatorBackend`（未注入时保持现有启发式路径，向后兼容）。
6. 预留 `SweBenchEvaluatorBackend` 接口占位（不在本期实现），作为与 QueryEngine 基准链路打通的挂点。

**验证：** 用 MockShell 模拟测试执行验证 SplitResult 组装正确；真实小型 vitest 子集端到端跑通 baseline vs candidate 比较并送入 T4 门禁；并行评估受信号量约束；未注入 backend 时 SEPL 行为不变。

**Files:** MODIFY `src/agp/sepl/protocol.ts`（EvaluatorBackend/SplitResult）、`src/agp/sepl/evaluate.ts`（注入点）；NEW `src/agp/sepl/evaluator-vitest.ts`、`test/services/evaluator-backend.test.ts`；NEW `.kc-cli/evolution-eval-example.json`（示例，仿 `sandbox-config-example.json` 惯例）。

---

### 3.3 Phase 3 — 提案质量与谱系闭环（P2）

#### 3.3.1 T6 — LLM 驱动提案器（功能增强 · M1）🟠

**Problem:** `ImproveOperator` 默认改进器是占位实现：`template_rewrite` 仅追加一行 `[Refinement] ...` 提示文本；`variable_update` 对数值做 `Math.random()` 扰动——后者在无真实评估兜底时可能有害。

**Solution（功能增强，硬依赖 T3/T4/T5）：**
1. 新增 `LLMProposer`：输入 T3 证据包 + 当前可进化状态，经隔离 LLM 调用（复用 memory LLM 提取的隔离与预算模式，`services/budget.ts` 约束）并行生成 K 个候选编辑（默认 K=3）。
2. 提案约束对齐论文 §3.3：**分支间多样**（不同失败机制/不同修改面/不同假设，拒绝措辞变体）；**分支内最小**（只修改解决目标机制所需的面，禁止大范围重写）；只允许修改 T1 声明的 evolvable 指令面与注册表中 `evolvability=1` 的资源。
3. 每个提案强制附带审计四元组 `{ targetFailurePattern, editedSurface, expectedEffect, regressionRisk }`，写入 `AuditLog` proposal 阶段 details。
4. **启用闸门：** `LLMProposer` 仅在 `acceptanceGate.enabled && evaluatorBackend != null` 时可被启用（代码级强制，不只是文档约定）；否则回退到既有默认改进器。移除 `variable_update` 的随机扰动（改为不变更）。
5. 测试用 `MockLLMClient` 预设提案响应与畸形响应（校验解析健壮性）。

**验证：** 提案缺少审计四元组即被拒收；未满足启用闸门时构造 `LLMProposer` 抛错或降级并记日志；K 候选互异性校验；MockLLM 畸形输出不崩溃；随机扰动路径已移除的回归测试。

**Files:** NEW `src/agp/sepl/llm-proposer.ts`、`test/services/llm-proposer.test.ts`；MODIFY `src/agp/sepl/improve.ts`（注册 LLM 改进器 + 移除随机扰动）、`src/agp/sepl/protocol.ts`（ProposalAudit 类型）、`src/agp/audit-log.ts`（proposal details 扩展）。

---

#### 3.3.2 T7 — 候选谱系补全 + 版本化数据契约（可追溯 · M2）🟡

**Problem:** 被拒候选未入审计（论文要求 "rejected candidates are logged without changing the active harness"）；一轮多个接受编辑无 MergeAccepted 语义；`audit-log.json`、AGP 序列化状态无格式版本标记，未来演进无兼容判据。

**Solution（可追溯）：**
1. `AuditEntry.phase` 联合类型新增 `'rejected'`，`CommitOperator` 拒绝路径记录候选 + 拒绝原因（门禁 reason 透传）。
2. `VersionManager` 新增 `mergeAccepted(type, name, records[], commitMessage)`：一轮多个接受编辑合并为单个新版本快照，commitMessage 记录来源候选清单。
3. 持久化产物统一加 `format` 字段：`kc.audit_log.v1`、`kc.agp_state.v1`、`kc.acceptance_gate.v1`（T4 已定义）；load 路径对缺失 format 的旧文件宽容兼容。

**验证：** 拒绝候选后审计可查 `rejected` 条目及原因；merge 后 lineage 单节点且 diff 正确；旧格式文件加载不报错；`test/orchestrator/**` 审计相关测试无回归。

**Files:** MODIFY `src/agp/audit-log.ts`、`src/agp/version-manager.ts`、`src/agp/sepl/commit.ts`、`src/agp/dynamic-manager.ts`（format 字段）。

---

#### 3.3.3 T8 — 失败签名→记忆桥接（功能增强 · M3）🟡

**Problem:** TraceManager 的失败记录与 memory 提取链路（`extractMemoriesHybrid`）互不相通；feedback 类记忆按文件名去重，同一失败机制反复以不同措辞入库或被漏记。

**Solution（功能增强，依赖 T3）：**
1. post-turn 钩子（`src/hooks/postTurnHooks.ts` 注册路径）将 T3 证据包中 `count ≥ 阈值` 的失败簇转为 feedback 类型 `MemoryEntry`：frontmatter 增加 `signature` 字段（`terminalCause/mechanism` 序列化），正文分离"验证器级事实"与"推断机制"两节。
2. 去重从文件名升级为签名匹配：同 mechanism + terminalCause 的既有记忆做合并更新（计数递增、证据追加）而非新建。
3. `relevanceSearch` 对含 `signature` 的记忆增加机制匹配加权（在既有关键词打分上叠加，不改变无签名记忆的评分路径）。
4. 配置 `memory.failureBridging`（默认 `false`）。

**验证：** 同一失败机制两次会话仅产生一条记忆且计数为 2；无签名旧记忆检索评分不变；开关关闭时记忆提取行为与现状一致；`test/memory/**` 无回归。

**Files:** MODIFY `src/memory/integration.ts`、`src/memory/relevanceSearch.ts`、`src/memory/types.ts`（signature 字段）、`src/hooks/postTurnHooks.ts`（桥接钩子注册）；NEW `test/memory/failure-bridging.test.ts`。

---

## 4. 涉及文件总览

| 类型 | 文件 | 任务 |
|---|---|---|
| NEW | `src/api/prompts/instruction-surfaces.ts` | T1 |
| NEW | `src/agp/sepl/acceptance-gate.ts` | T4 |
| NEW | `src/agp/sepl/evaluator-vitest.ts` | T5 |
| NEW | `src/agp/sepl/llm-proposer.ts` | T6 |
| NEW | `.kc-cli/evolution-eval-example.json` | T5 |
| MODIFY | `src/api/prompts/prompt-builder.ts` | T1 |
| MODIFY | `src/query/QueryEngine.ts` | T1, T2 |
| MODIFY | `src/query/protocol.ts` | T2 |
| MODIFY | `src/bootstrap/config.ts` | T1, T2 |
| MODIFY | `src/agp/sepl/protocol.ts` | T3, T4, T5, T6 |
| MODIFY | `src/agp/trace-manager.ts` | T3 |
| MODIFY | `src/agp/sepl/reflect.ts` | T3 |
| MODIFY | `src/agp/sepl/evaluate.ts` | T5 |
| MODIFY | `src/agp/sepl/improve.ts` | T6 |
| MODIFY | `src/agp/sepl/commit.ts` | T4, T7 |
| MODIFY | `src/agp/audit-log.ts` | T6, T7 |
| MODIFY | `src/agp/version-manager.ts` | T7 |
| MODIFY | `src/agp/dynamic-manager.ts` | T7 |
| MODIFY | `src/memory/integration.ts` / `relevanceSearch.ts` / `types.ts` | T8 |
| MODIFY | `src/hooks/postTurnHooks.ts` | T8 |
| NEW(test) | `test/services/failure-signature.test.ts` 等 6+ 个测试文件 | T1–T8 |

---

## 5. 实施进度追踪表

> 状态唯一可信源为 `docs/specs/harness-evolution-hardening-tasks.md`，本表须随任务推进同步回写。

| Task | 问题 | Phase | Status | 完成日期 |
|---|---|---|---|---|
| T1 声明式指令面 + 条件式提示注入 | H1 | 1 | completed | 2026-07-28 |
| T2 运行时控制策略 | H2 | 1 | completed | 2026-07-28 |
| T3 结构化失败签名 + 证据包 | H3 | 1 | completed | 2026-07-28 |
| T4 非回退回归验收门 | H4 | 2 | completed | 2026-07-28 |
| T5 EvaluatorBackend + 双 split 评估集 | H5 | 2 | completed | 2026-07-28 |
| T6 LLM 驱动提案器 | M1 | 3 | completed | 2026-07-28 |
| T7 候选谱系补全 + 版本化契约 | M2 | 3 | completed | 2026-07-28 |
| T8 失败签名→记忆桥接 | M3 | 3 | completed | 2026-07-28 |

---

## 6. 验证与测试方案

### 6.1 通用门禁（每任务必过）

- `npm run typecheck` 通过（tsc --noEmit）。
- `npm test` 通过，覆盖率不低于项目阈值（lines 60% / branches 50% / functions 60% / statements 60%）。
- 所有新能力开关默认关闭时，既有测试套件**零回归**（byte-equivalent 承诺：T1 的 system prompt 快照对比、T5 的 SEPL 无 backend 路径）。
- 不触碰 UI red lines：不新增 `useInput`、不改 `src/ui/layout.ts` 策略、不从组件文件导入数据契约。

### 6.2 分层测试策略

| 层级 | 覆盖对象 | 手段 |
|---|---|---|
| 纯函数单测 | T4 验收门（100% 分支）、T3 签名推断/聚类 | vitest，无 mock 依赖 |
| Mock 集成 | T5 SplitResult 组装（MockShell）、T6 提案解析（MockLLMClient 正常/畸形响应） | 既有 `MockFileSystem`/`MockShell`/`MockLLMClient` |
| 端到端 | T5 vitest 子集 baseline vs candidate → T4 门禁 accepted/rejected 全链路 | `test/integration/`，沙箱可用环境 |
| 快照/等价 | T1 关闭态 prompt 字节等价、T2 关闭态行为等价 | 快照测试 + 既有套件 |
| 回归证据 | Windows 本机测试基线偏差（沙箱后端缺失类失败）须与项目记忆中的既有基线对照，不得引入新失败 | `npm test` 输出对照 |

### 6.3 验收演练（Phase 2 完成后）

以一次受控进化循环做端到端验收：注入含 `retry_loop` 失败的 trace → T3 产出证据包 → 默认改进器生成候选 → T5 双 split 评估 → T4 门禁裁决 → Commit 晋升或回滚 → T7 审计链完整可查（trigger→hypothesis→proposal→evaluation→decision→version/rejected）。

---

## 7. 兼容性与风险

| 风险 | 缓解 |
|---|---|
| 条件注入破坏 KV 前缀缓存 | 条件段固定追加为最后一条 system 段；`kvCacheMetrics` 验证命中率；默认关闭 |
| 运行时控制策略误伤正常重试 | 默认 `soft`（注入指令不拦截）；`hard` 需显式配置；同调用判定含 inputHash 精确匹配 |
| 真实评估耗时/成本 | repeats 默认 2、评估集小型化、`budget.ts` 预算约束、Semaphore 并发控制 |
| LLM 提案不可控 | 代码级启用闸门（必须有真实门禁 + backend）；提案只能改声明面；非回退门 + autoRollback 双保险 |
| 与 SEPL 默认关闭现状冲突 | 无冲突：SEPL 默认关闭维持，本 Spec 全部能力再加独立开关，双重默认关闭 |
