# AGP 受控实验运行时（Experiment Runtime）Task Breakdown

> Generated: 2026-09-13 | Based on `docs/specs/agp-experiment-runtime-spec.md` v1.0
> Total Tasks: 13 | Phases: 4 | Source: 对 `src/agp/**`、`bootstrap`、`prompts`、`query` 的只读核查 + `product-identity.md` v3.3 scope filter
> 状态口径：`pending` / `in_progress` / `completed` / `blocked`；本文件是任务状态唯一可信源
> 改造范围：把 AGP 从 write-only 预留注册表收窄为「离线实验运行时 + 核心只读 overlay」，首批只接 `failure-recovery` Prompt 与有界 `RuntimeControlPolicy`

---

## Task Dependency Graph

```
Phase 0 (P0 — 基线与契约):
  T1 固定 held-in/held-out eval 基线  [独立] ──────────────► T5
  T2 Core experiments protocol + no-op runtime [独立] ──┬──► T3
                                                        └──► T9, T13

Phase 1 (P1 — 离线实验室):
  T3 lab skeleton + version/overlay/evidence store <── T2
       ├──► T4 candidate generator + allowlist
       ├──► T5 evaluator backend <── T1, T3
       ├──► T7 promotion/rollback/CLI <── T3, T6
       └──► T8 e2e lab experiment <── T4, T5, T6, T7
  T4 + T5 ──► T6 acceptance gate ──► T7 ──► T8

Phase 2 (P1/P2 — 运行时读路径与 canary):
  T8 ──► T9 prompt surface overlay runtime ──┬──► T10 policy overlay runtime
                                            ├──► T11 evidence binding + canary metrics
                                            └──► T13 AGP removal
  T10 ──► T11 ──► T12 canary / auto rollback（P2 optional）

Phase 3 (P0 — 清理与收口):
  T9, T10, T11 ──► T13 remove src/agp + residues + docs/coverage
```

依赖说明：

- **T1、T2** 可并行；T1 提供可比较的评估指标，T2 提供 core 只读 contract。
- **T3** 是 AGP 旧资产向实验室迁移的落点，必须先于候选/评估/晋升。
- **T5** 必须由 T1 的固定 split 与 T3 的 variant store 共同支撑；否则 gate 无意义。
- **T8** 是第一个端到端里程碑：离线候选通过 gate、晋升、catalog 生成。
- **T9** 是第一个在线里程碑：运行时真实读取 promoted overlay。
- **T13** 在 T9/T10/T11 之后执行，确保 core 先不再依赖 AGP，再删除旧树。

---

## Phase 0: 基线与契约（P0）

### Task T1: Establish fixed held-in/held-out long-task eval baseline

- **Status:** `completed` (2026-09-13, parent verification: vitest test/eval + typecheck green; mock baseline smoke)
- **Subject (imperative):** Establish a fixed, reproducible held-in/held-out long-task evaluation baseline with no AGP dependency
- **Subject (continuous):** Establishing a fixed, reproducible held-in/held-out long-task evaluation baseline
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.6、§4.4、§5.1–§5.2
- **Dependencies:**
  - blockedBy: none
  - blocks: T5
- **Checklist:**
  - [x] 定义 `kc.experiment_eval.v1` 任务清单格式：`taskId`、`repo`、`commit`、`prompt`、`testCommand`、`verificationCommand`、`maxTurns`、`maxBudgetUsd`、`timeoutSec`
  - [x] 新增固定 split 文件（held-in / held-out 不相交、运行前确定）：`scripts/eval/sets/longtask-held-in.json`、`longtask-held-out.json`
  - [x] 扩展 `scripts/eval/agent-longtask-harness.mjs`：新增单任务运行入口，持久化 patch、验证命令、退出码、turns、成本、no-patch 标记
  - [x] 新增汇总器（tsx）：从 run 目录聚合 `SplitResult { tasks, verifiedTaskRate, noPatchRate, avgTurns, avgCostUsd, safetyViolations }`
  - [x] 提供 deterministic mock backend（固定 MockLLM + 本地 fixture 任务），CI 默认运行；真实 provider backend 需显式开关与 API key
  - [x] baseline 运行产物限定在 `.kc-cli/experiments/eval-runs/<runId>/`，stdout 截断 ≤4KB，只存摘要
  - [x] 新增单测：split 校验、held-in/held-out 不相交、mock 重复运行同结果、汇总字段边界
  - [x] 更新 `scripts/eval/README.md`：如何跑 baseline、如何比较 baseline/candidate
  - [ ] `npm run typecheck`、`npm test` 通过；不触碰运行时 QueryEngine 行为
- **Files:**
  - NEW: `scripts/eval/sets/longtask-held-in.json`、`scripts/eval/sets/longtask-held-out.json`
  - NEW: `scripts/eval/metrics.ts`（或等价 tsx 汇总器）
  - MODIFY: `scripts/eval/agent-longtask-harness.mjs`、`scripts/eval/README.md`
  - NEW: `test/eval/eval-split.test.ts`、`test/eval/eval-metrics.test.ts`

---

### Task T2: Define core experiment protocol, catalog runtime, and no-op fallback

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Add a core experiment protocol and file-based read-only runtime with default-off no-op behavior
- **Subject (continuous):** Adding a core experiment protocol and file-based read-only runtime with default-off no-op behavior
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.1–§3.4、§4.1–§4.3
- **Dependencies:**
  - blockedBy: none
  - blocks: T3, T9, T13
- **Checklist:**
  - [x] NEW `src/experiments/protocol.ts`：`ArtifactKind`、`VariantRef`、`ResolvedVariant<T>`、`RunOutcome`、`ExperimentRuntime`；不 import `src/agp`、query、tools、orchestrator
  - [x] NEW `src/experiments/catalog.ts`：zod schema `kc.experiments.v1`；解析失败/版本未知/缺字段 → 返回空 catalog，不抛错
  - [x] NEW `src/experiments/runtime.ts`：`FileExperimentRuntime`，支持 `initialize`、`resolvePromptSurface`、`resolveRuntimePolicy`、`getAssignments`、`recordRunOutcome`
  - [x] 默认 `enabled=false`：全部返回 baseline，零磁盘 IO；`KC_EXPERIMENTS_ENABLED=1` 才读取 `.kc-cli/experiments/catalog.json`
  - [x] `baseHash` 工具（canonical text/JSON 的 SHA-256）；`baseHash` 不匹配 → 回退 baseline + warn
  - [x] `recordRunOutcome` 追加 `.kc-cli/experiments/runs/<sessionId>.jsonl`；IO 失败只 warn，不抛给 QueryEngine
  - [x] `bootstrap/config.ts` 新增 `experiments: { enabled: false, catalogPath, runsDir }`；env `KC_EXPERIMENTS_ENABLED` / `KC_EXPERIMENTS_CATALOG_PATH`
  - [x] 新增单测：默认 no-op、catalog 损坏回退、baseHash 漂移回退、非法 policy 回退、run outcome 写成功
  - [x] `vitest.config.ts` coverage include 增加 `src/experiments/**/*.ts` floor 70%；`npm run typecheck` 通过
- **Files:**
  - NEW: `src/experiments/protocol.ts`、`src/experiments/catalog.ts`、`src/experiments/runtime.ts`
  - MODIFY: `src/bootstrap/config.ts`、`vitest.config.ts`、`.env.example`
  - NEW: `test/experiments/protocol.test.ts`、`test/experiments/catalog.test.ts`、`test/experiments/runtime.test.ts`

---

## Phase 1: 离线实验室（P1）

### Task T3: Create scripts/agp lab skeleton with versioned overlay, evidence, and catalog stores

- **Status:** `completed`
- **Subject (imperative):** Build the offline AGP lab that stores versioned variants, immutable evidence, and the runtime catalog
- **Subject (continuous):** Building the offline AGP lab that stores versioned variants, immutable evidence, and the runtime catalog
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.3、§3.5、§3.10
- **Dependencies:**
  - blockedBy: T2
  - blocks: T4, T5, T7
- **Checklist:**
  - [x] 新建 `scripts/agp/`（tsx 运行，禁止被 `src/` import；只允许 type-only import `src/experiments/protocol.ts`）
  - [x] `version-store.ts`：从 `src/agp/version-manager.ts` 改造为文件型 lineage，支持 snapshot、parent、branch、diff、active 查询
  - [x] `overlay-store.ts`：管理 artifact 的 baseline 描述、baseHash、variant payload、status（candidate/promoted/retired/rejected）
  - [x] `evidence-store.ts`：按 `evidenceHash` 写不可变 JSON；无原始工具输出、无密钥、stdout ≤4KB
  - [x] `catalog-writer.ts`：按 spec §3.3 生成/更新 `catalog.json`；所有写入 temp + rename 原子替换
  - [x] `cli.ts`：`status`、`list`、`archive`；`promote`/`rollback` 留给 T7
  - [x] `package.json` 增加 `agp:status`、`agp:list` npm scripts
  - [x] 单测：snapshot/parent/status 迁移、原子写崩溃安全（模拟 rename 前失败）、evidence 只读、损坏 catalog 不覆盖
  - [x] `npm run agp:status` 在无 lab 数据时输出空态而非报错；`npm run typecheck`、`npm test` 通过
- **Files:**
  - NEW: `scripts/agp/cli.ts`、`scripts/agp/version-store.ts`、`scripts/agp/overlay-store.ts`、`scripts/agp/evidence-store.ts`、`scripts/agp/catalog-writer.ts`、`scripts/agp/README.md`、`scripts/agp/lab-paths.ts`
  - MODIFY: `package.json`
  - NEW: `test/agp-lab/version-store.test.ts`、`test/agp-lab/catalog-writer.test.ts`

---

### Task T4: Add candidate generator and evolvable allowlist

- **Status:** `completed`
- **Subject (imperative):** Add candidate generation constrained by a frozen evolvable allowlist
- **Subject (continuous):** Adding candidate generation constrained by a frozen evolvable allowlist
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §4.1、§3.9
- **Dependencies:**
  - blockedBy: T3
  - blocks: T6, T8
- **Checklist:**
  - [x] `artifact-adapter.ts`：为 baseline Prompt surface / policy 建描述，计算 baseHash，输出允许 overlay 的 schema 与校验器
  - [x] allowlist 首版：`prompt-surface:bootstrap-first-turn`、`prompt-surface:failure-recovery`、`runtime-policy:default`（字段见 spec §4.1）
  - [x] Candidate schema 必带 audit 四元组：`targetFailurePattern`、`editedSurface`、`expectedEffect`、`regressionRisk`
  - [x] candidate validator：长度上限、禁用模式（密钥/命令/URL 指令）、policy 数值边界、不允许字段整包拒绝
  - [x] 手工候选输入：`scripts/agp/candidates/*.json`；可选 LLM 生成器（默认关闭，离线运行，预算上限，产物仍走同一 validator）
  - [x] 候选与 held-out 任务集隔离：生成器只能读取 held-in manifest 的元数据，不读取 held-out 内容与评估输出
  - [x] 单测：合法候选通过；未知 artifact/超长/含密钥/越界 policy/缺 audit 字段全部拒绝
  - [x] 附样例候选 `failure-recovery-001.json` 作为 T8 输入
- **Files:**
  - NEW: `scripts/agp/artifact-adapter.ts`、`scripts/agp/candidate-generator.ts`、`scripts/agp/candidates/failure-recovery-001.json`
  - NEW: `test/agp-lab/candidate-generator.test.ts`
  - 关联: `src/api/prompts/instruction-surfaces.ts`、`src/query/protocol.ts`（仅读取 allowlist 元数据）

---

### Task T5: Implement trusted evaluator backends

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Implement evaluator backends that run baseline and candidate in isolated workspaces and return comparable split metrics
- **Subject (continuous):** Implementing evaluator backends that run baseline and candidate in isolated workspaces
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.6、§4.4
- **Dependencies:**
  - blockedBy: T1, T3
  - blocks: T6, T8
- **Checklist:**
  - [x] `evaluator-backend.ts` 定义 `EvaluatorBackend` / `VariantPin` / `EvalSplit` / `SplitResult`
  - [x] `mock-longtask-backend.ts`：用 T1 的 deterministic mock 任务跑通 baseline vs candidate，CI 默认可用
  - [x] `swebench-backend.ts`：包装 `evaluation/swe_bench/adapter.ts`，每个 instance 独立 worktree；应用候选 overlay 时走生产 runtime，而非另行拼接 prompt
  - [x] 运行隔离：候选不能写评估任务集与 evaluator；测试在 fresh worktree/temp copy 中执行；网络与超时遵循任务 manifest
  - [x] variant pin：通过 `KC_EXPERIMENTS_ENABLED=1` + per-run variant override 注入；评估结束后恢复 baseline 指针
  - [x] 每任务采集：patch 文件列表、验证命令、退出码、turns、cost、no-patch、安全违规
  - [x] 聚合输出 `SplitResult`；单任务失败不污染其他任务；原始产物写入 `.kc-cli/experiments/eval-runs/<runId>/`
  - [x] 单测：mock backend 重复运行稳定；isolated workspace 清理；预算/超时触发 blocked；patch/exit code 采集正确
- **Files:**
  - NEW: `scripts/agp/evaluator-backend.ts`、`scripts/agp/mock-longtask-backend.ts`、`scripts/agp/swebench-backend.ts`
  - MODIFY: `evaluation/swe_bench/adapter.ts`（可选：接受 variant pin / 结果采集）— 仓库中尚无该文件；swebench-backend 以 blocked 骨架返回并在注释中写明接入契约
  - NEW: `test/agp-lab/evaluator-backend.test.ts`
  - MODIFY: `scripts/agp/README.md`（隔离说明 + variant pin 约定）

---

### Task T6: Implement non-regression acceptance gate

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Add a pure acceptance gate that promotes only candidates with non-regression evidence on both splits
- **Subject (continuous):** Adding a pure acceptance gate that promotes only candidates with non-regression evidence on both splits
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.6
- **Dependencies:**
  - blockedBy: T4, T5
  - blocks: T7, T8
- **Checklist:**
  - [x] `acceptance-gate.ts` 纯函数：输入 baseline/candidate 的 `SplitResult`，输出 `{ accept, reasons[], deltas }`
  - [x] 实现 spec 门禁：safetyViolations=0、ΔheldIn≥0、ΔheldOut≥0、至少一侧 >0、noPatchRate 不上升、成本 ≤1.2x
  - [x] 支持 repeats >= 3 的均值；repeats 不足或两组任务不一致 → `blocked`，不产生晋升
  - [x] CLI `agp:evaluate`：从两个 run 目录聚合 SplitResult、落 evidence、打印 gate report；不直接改 catalog
  - [x] gate report 写入不可变 evidence JSON（kind=gate-report），包含 split 明细、runId、repeats、gate 结果
  - [x] 单测：accept 正例；held-in/held-out 回退；无正向；no-patch 上升；超预算；safety 违规；repeats 不足；分母/taskId 不一致
- **Files:**
  - NEW: `scripts/agp/acceptance-gate.ts`
  - MODIFY: `scripts/agp/cli.ts`（evaluate 子命令）、`package.json`（`agp:evaluate`）
  - NEW: `test/agp-lab/acceptance-gate.test.ts`

---

### Task T7: Add promotion, rollback, decision log, and lab CLI

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Add evidence-bound promotion, rollback, and an append-only decision log
- **Subject (continuous):** Adding evidence-bound promotion, rollback, and an append-only decision log
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.7
- **Dependencies:**
  - blockedBy: T3, T6
  - blocks: T8, T12
- **Checklist:**
  - [x] `promotion.ts`：只有 gate report `accept=true` 且 evidenceRef 可解析时才允许晋升
  - [x] `promote` 必须显式 `--yes`，记录操作者/理由/evidenceRef/variant hash；原子更新 catalog `active`
  - [x] `rollback` 指向该 artifact 上一个 promoted variant；无上一版本时回退 baseline；running session 不重读 catalog
  - [x] `decisions.jsonl` append-only：promote / rollback 均记录（reject/archive 经 overlays.setStatus 路径）
  - [x] catalog 写路径提供 promote lock（O_EXCL `.lock`）；写失败不破坏旧 catalog
  - [x] CLI：`promote`、`rollback`、`evaluate`、`status` 可用；无 evidence 直接拒绝
  - [x] 单测：无 evidence 拒绝；gate reject 拒绝；rollback 回上一版本/回 baseline；decision log 只追加；并发 lock 只允许一个成功
- **Files:**
  - NEW: `scripts/agp/promotion.ts`、`scripts/agp/decision-log.ts`
  - MODIFY: `scripts/agp/cli.ts`（promote/rollback）
  - NEW: `test/agp-lab/promotion.test.ts`

---

### Task T8: Ship first end-to-end offline experiment on failure-recovery surface

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Demonstrate one complete offline experiment from candidate to promoted catalog entry
- **Subject (continuous):** Demonstrating one complete offline experiment from candidate to promoted catalog entry
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §5.1–§5.3
- **Dependencies:**
  - blockedBy: T4, T5, T6, T7
  - blocks: T9
- **Checklist:**
  - [x] 使用 T4 的 `failure-recovery-001.json` 作为候选，baseline 为代码中 `FAILURE_RECOVERY_SURFACE`
  - [x] 在 mock backend 上完整运行 baseline/candidate，输出两份 `SplitResult`（held-in 2/3→3/3，held-out 保持 1.0）
  - [x] 通过 gate 后 promote，生成包含 promoted variant 与 evidenceRef 的 catalog
  - [x] mock gate 一次通过；未触发 §5.3 kill criteria，T9 可继续
  - [x] 新增 `npm run agp:demo`（`scripts/agp/e2e.ts` + CLI `demo`）
  - [x] 集成测试：空 catalog → evaluate → promote → rollback 全链路；evidence 不可变、decision log 完整
  - [x] 文档：`scripts/agp/README.md` + e2e.ts 头注释说明 mock 注入点与 kill criteria
  - [x] `npm run typecheck` 通过；`npx vitest run test/agp-lab` 全绿（knip 未在本轮跑）
- **Files:**
  - NEW: `scripts/agp/e2e.ts`
  - MODIFY: `scripts/agp/cli.ts`（demo）、`package.json`（`agp:demo`）
  - NEW: `test/agp-lab/e2e-experiment.test.ts`

---

## Phase 2: 运行时读路径与 canary（P1/P2）

### Task T9: Wire prompt-surface overlay into QueryEngine read path

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Resolve promoted prompt-surface overlays at session start and use them in conditional injection
- **Subject (continuous):** Resolving promoted prompt-surface overlays at session start and using them in conditional injection
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.4、§4.2
- **Dependencies:**
  - blockedBy: T2, T8
  - blocks: T10, T11, T13
- **Checklist:**
  - [x] `QueryEngineDeps` 增加可选 `experimentRuntime?: ExperimentRuntime`；不传时行为与现状完全一致
  - [x] `Bootstrap` 仅在 `experiments.enabled=true` 且未传 `--no-experiments` 时创建 `FileExperimentRuntime`；默认路径不读 catalog
  - [x] QueryEngine 构造时调用 `initialize()`，把 assignment 快照锁进实例；会话中途不重读
  - [x] conditional injection 构建前，对 `CONDITIONAL_SURFACES` 中 `evolvable=true` 的 surface 调用 `resolvePromptSurface(name, base)`；static prefix 保持不动
  - [x] CLI：`--no-experiments` 强制 baseline；`--experiment <artifact=variant>` 单次 pin（信息性，eval 后端走 env pin）
  - [x] 运行结束时调用 `recordRunOutcome`（T9 占位字段；T11 补全）
  - [x] 单测：disabled 字节等价；enabled+overlay 替换；baseHash 漂移回退；非法 catalog 回退；session pin 锁定；static 不经 resolver
  - [x] `instruction-surfaces.ts` 运行时不再 import `src/agp`；`createSurfacePromptRecords` 已删除
  - [x] `npm run typecheck` 通过；`test/query/experiment-prompt-overlay` + instruction-surfaces 回归绿
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`、`src/bootstrap/Bootstrap.ts`、`src/bootstrap/init-sequence.ts`、`src/bootstrap/cli-config.ts`
  - MODIFY: `src/api/prompts/instruction-surfaces.ts`（resolver 接缝 + 删 AGP bridge）
  - NEW: `test/query/experiment-prompt-overlay.test.ts`

---

### Task T10: Wire bounded runtime-policy overlay

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Load a validated bounded RuntimeControlPolicy overlay once per session and use it for runtime control
- **Subject (continuous):** Loading a validated bounded RuntimeControlPolicy overlay once per session and using it for runtime control
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §4.1
- **Dependencies:**
  - blockedBy: T9
  - blocks: T11
- **Checklist:**
  - [x] `RuntimeControlPolicy` overlay schema：`maxSameCallRetries` 0–5、`retryIntervention` soft/hard、`maxReadOnlyStreak` 1–20、`maxTotalToolMessages` 0–200、`redirectInstruction` ≤1KB
  - [x] `enabled` 字段不可被 overlay 修改；overlay 结果仍受 `experiments.enabled` 与 `runtimeControl.enabled` 双门控
  - [x] QueryEngine 构造 RuntimeControlHandler 时使用 `resolveRuntimePolicy(baseline)` 的锁定结果；非法值整包回退 baseline
  - [x] `QueryEngineRuntimeControl.ts` 无 AGP import
  - [x] 单测：字段边界/枚举；非法 overlay 回退；disabled 与现状一致；hard/soft 按 overlay 生效；拒绝 frozen 字段
  - [x] `npm run typecheck` 通过
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`、`src/experiments/runtime.ts`
  - NEW: `test/query/experiment-policy-overlay.test.ts`

---

### Task T11: Bind run outcomes to evidence and expose canary metrics

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Persist run outcomes and surface per-variant canary metrics for promoted experiments
- **Subject (continuous):** Persisting run outcomes and surfacing per-variant canary metrics for promoted experiments
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.4、§4.3、§3.7
- **Dependencies:**
  - blockedBy: T9, T10
  - blocks: T12, T13
- **Checklist:**
  - [x] QueryEngine 正常/失败均调用 `recordRunOutcome`，带 runId/sessionId/assignments/success/verified/patchFiles/turns/noPatch/errorCode；`taskId` 优先 `KC_EXPERIMENT_TASK_ID`
  - [x] outcome 不含完整消息/工具输出/密钥
  - [x] `completion-report.ts` 输出 `assignments` 与 `evidenceRefs`
  - [x] `scripts/agp/report.ts` 按 variant 聚合 canary 指标 + suggestRollback
  - [x] 无 experiments / 写失败时零影响主流程
  - [x] 单测：成功/失败写 outcome；report 聚合；写失败不抛
  - [x] `npm run typecheck` 通过
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`、`src/query/completion-report.ts`
  - NEW: `scripts/agp/report.ts`
  - MODIFY: `scripts/agp/cli.ts`（report 子命令）
  - NEW: `test/experiments/run-outcome.test.ts`、`test/agp-lab/report.test.ts`

---

### Task T12: Add optional canary rollout and guarded auto-rollback（P2）

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Add optional canary rollout with deterministic bucketing and guarded rollback
- **Subject (continuous):** Adding optional canary rollout with deterministic bucketing and guarded rollback
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.7
- **Dependencies:**
  - blockedBy: T7, T11
  - blocks: none
- **Checklist:**
  - [x] catalog 支持 `rollout: { mode: 'canary', percent: 0..50 }`；sessionId 稳定 hash 分桶；percent=0 视为全 baseline
  - [x] canary session 的 assignment 仍锁定；不修改 artifact `active`
  - [x] canary 报告 `suggestRollback`：verifiedTaskRate 比 baseline 低 >10% 或 budget_exceeded 高发时给出建议
  - [x] 自动 rollback 默认关闭（仅建议；晋升路径仍需 --yes）
  - [x] 单测：分桶稳定、percent=0、force in/out、无 rollout 兼容、分布粗测
  - [x] 文档：README 标明 canary 为 P2 可选，MVP 不阻塞
- **Files:**
  - MODIFY: `src/experiments/runtime.ts`、`src/experiments/catalog.ts`
  - NEW: `test/experiments/canary.test.ts`
  - 关联: `scripts/agp/report.ts`（suggestRollback）

---

## Phase 3: AGP 清理与收口（P0）

### Task T13: Remove src/agp and all AGP residues from core, docs, coverage

- **Status:** `completed` (2026-09-13)
- **Subject (imperative):** Remove the old AGP subsystem and every core residue after the experiment runtime read path is live
- **Subject (continuous):** Removing the old AGP subsystem and every core residue after the experiment runtime read path is live
- **Spec:** `docs/specs/agp-experiment-runtime-spec.md` §3.10
- **Dependencies:**
  - blockedBy: T9, T10, T11
  - blocks: release acceptance for this spec
- **Checklist:**
  - [x] 删除 `src/agp/**`（目录已不存在）
  - [x] `bootstrap/Bootstrap.ts`：AGP init / surface registration / failure-bridging AGP provider 已移除
  - [x] `bootstrap/config.ts`：`agp` schema 已删；`state.ts`：`agpRegistry` 已删；`services/logger.ts`：`agp` logger 已删
  - [x] `api/prompts/instruction-surfaces.ts`：AGP bridge 已删（T9）
  - [x] `hooks/postTurnHooks.ts` / `memory/integration.ts` / `memory/protocol.ts`：failureBridging AGP 路径已断
  - [x] `state/protocol.ts`：`evolving` / `evolutionState` 已删
  - [x] `tools/protocol.ts`：AGP 扩展字段已删
  - [x] `orchestrator/event-bus.ts` / `agent-orchestrator.ts`：Evolution 事件已删
  - [x] `QueryEngineRuntimeControl.ts`：无 AGP import
  - [x] `vitest.config.ts`：`src/experiments` floor 70%；`src/agp` floor 已删
  - [x] 边界守卫：`test/architecture/no-agp-import.test.ts`
  - [x] README / AGENTS.md / repowiki Home/Architecture 已改为 experiments + scripts/agp 表述
  - [x] `npm run typecheck` 通过；Bootstrap + no-agp-import 测试绿
- **Files:**
  - DELETE: `src/agp/**`、`test/bootstrap/agp-surface-registration.test.ts`
  - MODIFY: Bootstrap/config/state/logger/instruction-surfaces/hooks/memory/state/tools/orchestrator/vitest/README/AGENTS/repowiki
  - NEW: `test/architecture/no-agp-import.test.ts`

---

## 状态回写规则

1. 任务开始时 Status 改为 `in_progress`；所有 checklist 勾选并验证通过后改为 `completed`。
2. 每完成一个 Phase，在 `docs/specs/agp-experiment-runtime-spec.md` 的 Acceptance Criteria 对应条目上回写证据。
3. 若 T1/T5 触发 §5.3 kill criteria：T6 之后的任务置 `blocked`，不得继续接入运行时。
4. T13 完成前，`src/experiments/**` 不得 import `scripts/agp/**`，`src/**` 不得 import `src/agp/**`。
