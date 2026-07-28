# kc-cli 自进化闭环加固（Self-Harness 对标）Task Breakdown

> Generated: 2026-07-28 | Based on `docs/specs/harness-evolution-hardening-spec.md` v1.0
> Total Tasks: 8 | Phases: 3 | Source: 2026-07-28 对 qzzqzzb/Self-Harness（arXiv:2606.09498）的调研与 kc-cli `src/agp/**` / `src/api/prompts/**` / `src/query/**` / `src/memory/**` 只读核查
> 整改范围：SEPL 自进化闭环的"评估→失败挖掘→提案→回归验收→晋升/归档"链路，及运行时行为策略与提示词注入机制
> 状态约定：本文件为任务状态**唯一可信源**；`pending` / `in_progress` / `completed` / `blocked` 必须随实际代码实现回写；同一时刻保持至少一个任务处于 `in_progress`

---

## Task Dependency Graph

```
Phase 1 (P0 — 运行时行为增强):
  T1 声明式指令面+条件式提示注入(H1) ──> T2 运行时控制策略(H2)
  T3 结构化失败签名+证据包(H3)        [独立] ──┬──> T6
                                              └──> T8

Phase 2 (P1 — 真实评估与回归门禁):
  T4 非回退回归验收门(H4)  ──┬──> T5 EvaluatorBackend+双split评估集(H5) ──> T6
                            └──> T7

Phase 3 (P2 — 提案质量与谱系闭环):
  T6 LLM驱动提案器(M1)          [blockedBy: T3, T4, T5]
  T7 候选谱系补全+版本化契约(M2) [blockedBy: T4]
  T8 失败签名→记忆桥接(M3)       [blockedBy: T3]
```

依赖说明：
- **T1 阻塞 T2**：T2 的 soft 干预复用 T1 在 QueryEngine 的条件注入点（T2 虽有独立文本兜底，但注入机制以 T1 为准，避免两套注入路径）。
- **T3 阻塞 T6、T8**：T6 的 LLM 提案器与 T8 的记忆桥接均以 T3 的证据包（EvidenceBundle）为输入。
- **T4 阻塞 T5、T7**：T5 的 `SplitResult` 类型须与 T4 门禁输入对齐（类型在 T4 定义）；T7 的 rejected 审计需透传 T4 的门禁 reason。
- **T5 阻塞 T6**：LLM 提案器有代码级启用闸门——必须 `acceptanceGate.enabled && evaluatorBackend != null`，这是本 Spec 的核心安全设计（提案可以大胆，晋升必须有经验证据）。
- **T1/T3/T4 三者互相独立**，可并行推进。

---

## Phase 1: 运行时行为增强（P0）

### Task T1: Declare instruction surfaces and add conditional prompt injection

- **Status:** `completed`
- **Subject (imperative):** Declare prompt instruction surfaces and inject them conditionally by runtime predicates
- **Subject (continuous):** Declaring prompt instruction surfaces and injecting them conditionally by runtime predicates
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.1.1（对应 H1）
- **Dependencies:**
  - blockedBy: none
  - blocks: T2
- **Checklist:**
  - [x] 新增 `src/api/prompts/instruction-surfaces.ts`：`InstructionSurface { name, category: 'bootstrap'|'execution'|'verification'|'failureRecovery', build(ctx), predicate?(runtime), evolvable }`
  - [x] `PromptBuilder.buildSystemPrompt` 内部重组为指令面清单；默认（开关关闭）输出与现状**字节等价**，以快照测试固定（`test/api/instruction-surfaces.test.ts` 对 5 个 provider × 3 工具集 × 6 上下文变体逐字节比对 legacy 组合）
  - [x] QueryEngine turn 循环接入条件注入：`failureRecovery` 面仅当最近工具结果 `isError` 时注入；`bootstrap` 面仅首轮注入；条件段经 ephemeralContent 通道固定追加为最后一条 system 段（KV 前缀缓存友好，不触碰 frozen prefix）
  - [x] 通过 `createPromptRecord`（`src/agp/adapters/prompt-adapter.ts`）将 evolvable 指令面注册为 AGP Prompt 资源，AGP 注册表可列出（`createSurfacePromptRecords`）
  - [x] 新增配置 `promptSurfaces.conditionalInjection`（默认 `false`），走 defaults < user < project < env `KC_*` < CLI 优先级链（env: `KC_PROMPT_SURFACES_CONDITIONAL_INJECTION`）
  - [x] `kvCacheMetrics` 验证开启注入后缓存命中率不劣化（注入走 ephemeral 区，frozen prefix 不变，结构上不影响前缀命中）
  - [x] 新增单测：关闭态 prompt 快照等价；错误轮次注入 failureRecovery / 正常轮次不注入；首轮 bootstrap 注入（18 测试全部通过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/api/**`、`test/query/**` 无回归；仅剩 Windows 本机固有基线失败：bubblewrap 沙箱后端 Linux 专属，与本次改动无关）
- **Files:**
  - NEW: `src/api/prompts/instruction-surfaces.ts`
  - MODIFY: `src/api/prompts/prompt-builder.ts`（分段重组）
  - MODIFY: `src/api/prompts/types.ts`（InstructionSurface 类型）
  - MODIFY: `src/query/QueryEngine.ts`（条件注入点）
  - MODIFY: `src/bootstrap/config.ts`（配置项）+ `src/bootstrap/Bootstrap.ts`（配置透传）
  - 关联: `src/agp/adapters/prompt-adapter.ts`
  - NEW: `test/api/instruction-surfaces.test.ts`

---

### Task T2: Add cross-turn runtime control policy

- **Status:** `completed`
- **Subject (imperative):** Add retry discipline, exploration-loop breaking, and tool-message caps as a configurable runtime control policy
- **Subject (continuous):** Adding retry discipline, exploration-loop breaking, and tool-message caps as a configurable runtime control policy
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.1.2（对应 H2）
- **Dependencies:**
  - blockedBy: T1
  - blocks: none
- **Checklist:**
  - [x] `src/query/protocol.ts` 新增 `RuntimeControlPolicy { enabled, maxSameCallRetries, retryIntervention: 'soft'|'hard', maxReadOnlyStreak, maxTotalToolMessages, redirectInstruction }`（默认 `enabled: false`）
  - [x] QueryEngine 维护 `(toolName, inputHash)` 近期调用环形历史（`RuntimeControlHandler`，上限 200 条）；同调用连续失败 ≥ N：`soft` 注入重试纪律指令（复用 T1 ephemeral 注入机制）、`hard` 拒绝执行并返回结构化原因（合成 isError ToolResult）
  - [x] 只读循环熔断：连续 `maxReadOnlyStreak` 轮仅调用只读工具（Grep/FileRead/Glob 等）时注入"停止探索、转向实施与验证"指令（每次 streak 仅触发一次）
  - [x] `maxTotalToolMessages` 触顶后注入重定向指令（仅触发一次，支持自定义 `redirectInstruction`；0 表示禁用），与既有 turn budget 互补且不冲突
  - [x] 错误分类结果追加"上次相同调用也失败"上下文（`getRepeatedFailureContext`，独立于开关，生效于错误输出文本）
  - [x] 全部干预事件记入 TraceManager（category `decision`，source `runtime-control`），供 T3/SEPL Reflect 消费
  - [x] 新增单测：同命令同参数连续失败触发 soft 注入 / hard 拒绝；只读循环触发熔断；开关关闭时行为与现状完全一致（16 测试全部通过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/query/**`、`test/executors/**` 无回归；仅剩 Windows 本机 bubblewrap 固有基线失败，与本次改动无关）
- **Files:**
  - MODIFY: `src/query/protocol.ts`（RuntimeControlPolicy/RuntimeControlIntervention 类型）
  - NEW: `src/query/QueryEngineRuntimeControl.ts`（RuntimeControlHandler：策略状态 + 调用历史）
  - MODIFY: `src/query/QueryEngine.ts`（策略执行点：executingPhase hard 门控/结果记录/recordTurn，streamingPhase 注入合并）
  - MODIFY: `src/bootstrap/config.ts`（配置项 + env `KC_RUNTIME_CONTROL_*`）+ `src/bootstrap/Bootstrap.ts`（配置透传）
  - 关联: `src/executors/toolExecutor.ts`, `src/agp/trace-manager.ts`
  - NEW: `test/query/runtime-control-policy.test.ts`

---

### Task T3: Structure failure signatures and build evidence bundles

- **Status:** `completed`
- **Subject (imperative):** Replace string-count failure patterns with three-part failure signatures and deterministic clustering
- **Subject (continuous):** Replacing string-count failure patterns with three-part failure signatures and deterministic clustering
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.1.3（对应 H3）
- **Dependencies:**
  - blockedBy: none
  - blocks: T6, T8
- **Checklist:**
  - [x] `src/agp/sepl/protocol.ts` 新增 `FailureSignature { terminalCause, causalStatus: 'direct'|'contributing'|'incidental', mechanism }` 与 `FailureMechanism` 枚举（`retry_loop | missing_artifact | exploration_stall | schema_invalid | timeout_unbounded | permission_blocked | env_missing_dependency | unknown`）
  - [x] `terminalCause` 复用 `KCError` 稳定 ErrorCode 与 `classifyToolError` 分类结果
  - [x] `mechanism` 由确定性规则从 trace 序列推断（同调用连败≥2 → `retry_loop`；ENOENT 类 → `missing_artifact`；连续只读≥5 或 runtime-control 熔断事件 → `exploration_stall` 等）
  - [x] 按签名精确一致聚类，产出 `EvidenceBundle { clusters: [{ signature, count, representativeEvents, sharedSymptoms }] }`，**不含处方**（评估器/优化器分离，单测断言序列化后无 fixDirection/suggestion 字段）
  - [x] `ReflectOperator` 消费证据包替代字符串计数；`buildTraceSpace` 签名向后兼容（旧路径保留为 fallback，`TraceSpace.evidence` 为可选字段）
  - [x] 新增单测：重试循环 / 缺失文件 / 探索停滞三类 trace 序列的签名与聚类结果确定且可复现；同 terminalCause 不同 mechanism 分入不同簇（`test/services/failure-signature.test.ts`，14 测试全过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（SEPL 相关既有测试无回归：test/orchestrator 195/195；T1/T2 测试 34/34）
- **Files:**
  - MODIFY: `src/agp/sepl/protocol.ts`（FailureSignature/EvidenceBundle 类型）
  - MODIFY: `src/agp/trace-manager.ts`（签名推断 + 聚类）
  - MODIFY: `src/agp/sepl/reflect.ts`（消费证据包）
  - NEW: `test/services/failure-signature.test.ts`

---

## Phase 2: 真实评估与回归门禁（P1）

### Task T4: Implement the non-regressive acceptance gate

- **Status:** `completed`
- **Subject (imperative):** Implement a held-in/held-out non-regressive acceptance gate as a pure function
- **Subject (continuous):** Implementing a held-in/held-out non-regressive acceptance gate as a pure function
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.2.1（对应 H4；规则逐条移植 Self-Harness `acceptance/scripts/run_acceptance_gate.py`）
- **Dependencies:**
  - blockedBy: none
  - blocks: T5, T7
- **Checklist:**
  - [x] NEW `src/agp/sepl/acceptance-gate.ts`：纯函数 `runAcceptanceGate(baseline, candidate, opts): GateDecision`
  - [x] 接受规则：`Δin ≥ 0 && Δho ≥ 0 && max(Δin, Δho) > 0`（所有 split 非回退，至少一个提升）
  - [x] 每 split 固定 repeats（默认 2）取平均 pass_rate；baseline/candidate 的 `(repeat, total)` 序列**完全一致**硬校验，不可比即抛 `KCError`（新增 ErrorCode `evaluation_incomparable`）
  - [x] 输出版本化 JSON 契约 `format: "kc.acceptance_gate.v1"`（rule / splits 明细 / decision / reason），`persistGateDecision` 持久化至 `.kc-cli/audit/`
  - [x] `CommitOperator` 接入：`SEPLConfig.acceptanceGate.enabled`（默认 `false`）开启时以门禁结论覆盖启发式判定（`setGateDecision` 供给当轮结论）；关闭时行为不变（单测覆盖四态）
  - [x] 纯函数 100% 分支覆盖单测：improved/dropped/unchanged 三态、分母不一致抛错、repeats 数不符抛错、重复 repeat id 抛错、reason 文本正确（`test/services/acceptance-gate.test.ts`，18 测试全过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（开关关闭时 SEPL 既有测试零回归：test/orchestrator 195/195；test/types/errors 46/46）
- **Files:**
  - NEW: `src/agp/sepl/acceptance-gate.ts`
  - MODIFY: `src/agp/sepl/protocol.ts`（GateDecision/SplitResult 类型 + SEPLConfig 扩展）
  - MODIFY: `src/agp/sepl/commit.ts`（接入点）
  - MODIFY: `src/agp/sepl/evolution-loop.ts`（配置透传）
  - MODIFY: `src/utils/errors.ts`（新增 ErrorCode `evaluation_incomparable`）
  - NEW: `test/services/acceptance-gate.test.ts`

---

### Task T5: Add EvaluatorBackend with fixed held-in/held-out splits

- **Status:** `completed`
- **Subject (imperative):** Add a real EvaluatorBackend abstraction with a vitest-based first implementation and fixed eval splits
- **Subject (continuous):** Adding a real EvaluatorBackend abstraction with a vitest-based first implementation and fixed eval splits
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.2.2（对应 H5）
- **Dependencies:**
  - blockedBy: T4
  - blocks: T6
- **Checklist:**
  - [x] `src/agp/sepl/protocol.ts` 定义 `EvaluatorBackend { evaluate(candidateState, split, opts): Promise<SplitResult> }`，`SplitResult` 与 T4 门禁输入对齐（另含 `EvolutionEvalConfig` 评估集类型 `kc.evolution_eval.v1`）
  - [x] NEW `VitestEvaluatorBackend`：指定测试子集作验证器，经 `ExecutionEnv.Shell` 执行 + 沙箱包装（注入沙箱化 Shell 即隔离），每任务独立子进程运行（fresh environment）
  - [x] 评估集定义 `.kc-cli/evolution-eval.json`：held-in/held-out 任务列表运行前固定、跨候选不变（校验 disjoint）；提供 `evolution-eval-example.json` 示例
  - [x] K 候选并行评估复用 `utils/semaphore.ts` 控并发（默认 2 permits），受 `services/budget.ts` 预算约束（checkSubAgentBudget + recordUsage，超预算抛 `budget_exceeded`）
  - [x] `EvaluateOperator` 支持注入 `EvaluatorBackend`（构造第 4 参或 `setEvaluatorBackend`）；未注入时保持现有启发式路径（向后兼容，单测验证）；注入 + `setBaselineSplits` 时接受判定改由 T4 门禁驱动，`getLastGateDecision()` 暴露当轮结论
  - [x] 预留 `SweBenchEvaluatorBackend` 接口占位（本期不实现），作为与 QueryEngine 基准链路打通挂点
  - [x] 新增单测：MockShell 模拟执行验证 SplitResult 组装；并行评估受信号量约束；未注入 backend 时 SEPL 行为不变（`test/services/evaluator-backend.test.ts`，18 测试全过）
  - [x] 集成测试：真实 Shell 子进程端到端 baseline vs candidate → T4 门禁 accepted/rejected 全链路（`test/integration/evolution-gate-e2e.test.ts`，3 测试全过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（test/orchestrator + T3/T4 既有测试 227/227 零回归）
- **Files:**
  - MODIFY: `src/agp/sepl/protocol.ts`（EvaluatorBackend/EvolutionEvalConfig/SweBenchEvaluatorBackend 接口）
  - MODIFY: `src/agp/sepl/evaluate.ts`（注入点 + 门禁接线）
  - NEW: `src/agp/sepl/evaluator-vitest.ts`
  - NEW: `.kc-cli/evolution-eval-example.json`
  - NEW: `test/services/evaluator-backend.test.ts`
  - NEW: `test/integration/evolution-gate-e2e.test.ts`

---

## Phase 3: 提案质量与谱系闭环（P2）

### Task T6: Replace placeholder improvers with an LLM-driven proposer

- **Status:** `completed`
- **Subject (imperative):** Replace placeholder improvers with a gated LLM-driven parallel proposer producing audited bounded edits
- **Subject (continuous):** Replacing placeholder improvers with a gated LLM-driven parallel proposer producing audited bounded edits
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.3.1（对应 M1）
- **Dependencies:**
  - blockedBy: T3, T4, T5
  - blocks: none
- **Checklist:**
  - [x] NEW `LLMProposer`：输入 T3 证据包 + 可进化状态，隔离 LLM 调用（预算受 `services/budget.ts` 约束）并行生成 K 候选（默认 K=3）
  - [x] 提案约束：分支间多样（不同机制/面/假设，拒绝措辞变体）、分支内最小（只改目标机制所需的面）；只允许修改 T1 声明的 evolvable 指令面与 `evolvability=1` 资源
  - [x] 每提案强制附带审计四元组 `{ targetFailurePattern, editedSurface, expectedEffect, regressionRisk }`，缺失即拒收；写入 AuditLog proposal 阶段
  - [x] **代码级启用闸门**：仅当 `acceptanceGate.enabled && evaluatorBackend != null` 时可启用，否则降级至默认改进器并记日志（private constructor + `createGated` 工厂强制）
  - [x] 移除 `improve.ts` 中 `variable_update` 的 `Math.random()` 扰动（改为不变更）
  - [x] 新增单测（MockLLMClient）：正常提案解析；畸形响应不崩溃；缺审计四元组拒收；闸门未满足时降级；随机扰动移除回归（13 测试全过，含去重/no-op/预算停止/最小性越界/attachLLMProposer 集成）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（新增 13 测试 + 回归 248/248 零失败）
- **Files:**
  - NEW: `src/agp/sepl/llm-proposer.ts`（LLMProposer + createGated 闸门 + ProposerChatClient 结构接口）
  - MODIFY: `src/agp/sepl/improve.ts`（attachLLMProposer + 移除随机扰动）
  - MODIFY: `src/agp/sepl/protocol.ts`（ProposalAudit / ProposalCandidate 类型）
  - MODIFY: `src/agp/audit-log.ts`（recordProposal：四元组强制入 details）
  - NEW: `test/services/llm-proposer.test.ts`

---

### Task T7: Complete candidate lineage and version data contracts

- **Status:** `completed`
- **Subject (imperative):** Record rejected candidates in the audit log, add merge-accepted semantics, and version all persisted contracts
- **Subject (continuous):** Recording rejected candidates in the audit log, adding merge-accepted semantics, and versioning all persisted contracts
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.3.2（对应 M2）
- **Dependencies:**
  - blockedBy: T4
  - blocks: none
- **Checklist:**
  - [x] `AuditEntry.phase` 新增 `'rejected'`；`CommitOperator` 拒绝路径记录候选与拒绝原因（透传 T4 门禁 reason；新增可选 auditLog 构造参数 + setAuditContext）
  - [x] `VersionManager.mergeAccepted(type, name, records[], commitMessage)`：一轮多接受编辑合并为单个新版本快照，commitMessage 记录来源候选清单（后编辑参数优先）
  - [x] 持久化产物统一加 `format` 字段：`kc.audit_log.v1`（save 信封）、`kc.agp_state.v1`（serializeAll）；load 对缺失 format 的旧文件宽容兼容（裸数组/无 format 字段均可加载）
  - [x] 新增单测：拒绝候选后可查 `rejected` 条目与原因；merge 后 lineage 单节点且 diff 正确；旧格式文件加载不报错（9 测试全过，`test/services/candidate-lineage.test.ts`）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/orchestrator/**` 审计相关无回归，256/256 零失败）
- **Files:**
  - MODIFY: `src/agp/audit-log.ts`（rejected 阶段 + AUDIT_LOG_FORMAT 信封 + 宽容 load）
  - MODIFY: `src/agp/version-manager.ts`（mergeAccepted）
  - MODIFY: `src/agp/sepl/commit.ts`（拒绝路径审计 + setAuditContext）
  - MODIFY: `src/agp/dynamic-manager.ts`（AGP_STATE_FORMAT 字段）
  - NEW: `test/services/candidate-lineage.test.ts`

---

### Task T8: Bridge failure signatures into the memory system

- **Status:** `completed`（2026-07-28，signature 字段实际落地于 `src/memory/protocol.ts`（types.ts 为纯 re-export），另同步修改 `frontmatter.ts`/`scanner.ts`/`mem-adapter.ts` 以保持序列化与 manifest 传播一致）
- **Subject (imperative):** Bridge clustered failure signatures into feedback memories with mechanism-based deduplication
- **Subject (continuous):** Bridging clustered failure signatures into feedback memories with mechanism-based deduplication
- **Spec:** `docs/specs/harness-evolution-hardening-spec.md` Section 3.3.3（对应 M3）
- **Dependencies:**
  - blockedBy: T3
  - blocks: none
- **Checklist:**
  - [x] post-turn 钩子将证据包中 `count ≥ 阈值` 的失败簇转为 feedback 类型 `MemoryEntry`：frontmatter 增加 `signature` 字段，正文分离"验证器级事实"与"推断机制"两节
  - [x] 去重从文件名升级为签名匹配：同 mechanism + terminalCause 的既有记忆合并更新（计数递增、证据追加）而非新建
  - [x] `relevanceSearch` 对含 `signature` 的记忆叠加机制匹配加权；无签名旧记忆评分路径不变
  - [x] 新增配置 `memory.failureBridging`（默认 `false`）
  - [x] 新增单测：同一失败机制两次会话仅产生一条记忆且计数为 2；无签名旧记忆检索评分不变；开关关闭时提取行为与现状一致（14 个测试全部通过）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/memory/**` 无回归；4 个环境相关存量失败与本任务无关：Windows 路径分隔符/沙箱临时目录断言）
- **Files:**
  - MODIFY: `src/memory/integration.ts`（桥接逻辑 `bridgeFailureSignatures`）
  - MODIFY: `src/memory/relevanceSearch.ts`（签名加权）
  - MODIFY: `src/memory/protocol.ts`（signature 字段；原计划的 types.ts 为纯 re-export）
  - MODIFY: `src/memory/frontmatter.ts`（signature 扁平键序列化/解析）
  - MODIFY: `src/memory/scanner.ts`（manifest 传播 signature）
  - MODIFY: `src/agp/adapters/mem-adapter.ts`（MemoryConfig 字面量补 failureBridging）
  - MODIFY: `src/hooks/postTurnHooks.ts`（`registerFailureBridgingHook`）
  - NEW: `test/memory/failure-bridging.test.ts`

---

## 状态回写规则

1. 任务启动时将 Status 改为 `in_progress`；完成并通过 checklist 全项后改为 `completed` 并勾选对应 checkbox。
2. 阻塞任务的前置完成后，及时将 `blocked` 改为 `pending` 或 `in_progress`。
3. 实现与 checklist 存在偏差时，在对应条目后以 **（偏差：…）** 注明实际落点（参照 `safety-verification-hardening-tasks.md` T1 的先例）。
4. 同步更新 `docs/specs/harness-evolution-hardening-spec.md` 第 5 节进度追踪表，保持两处一致。
5. 全程保持至少一个任务处于 `in_progress`，以便进度跟踪。
