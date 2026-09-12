# AGP 受控实验运行时（Experiment Runtime）Spec

> 依据：`docs/specs/product-identity.md` v3.3 承诺、`docs/specs/audit-remediation-round3-spec.md` H8/T09、`docs/specs/harness-evolution-hardening-spec.md`、2026-09-13 对 `src/agp/**` / `bootstrap` / `prompts` / `query` 的只读核查
> Generated: 2026-09-13 | Version: 1.0（设计已批准，待实施） | Status: `pending implementation`
> Scope: `src/experiments/**`、`scripts/agp/**`、`scripts/eval/**`、`src/query/**`、`src/api/prompts/**`、`src/bootstrap/**`、`test/experiments/**`、`test/agp-lab/**`
> 原则基线：**默认关闭 · 离线演化 · 证据晋升 · 会话锁定 · 可回滚 · 不阻塞主任务**

---

## 1. Executive Summary

当前 `src/agp/**` 是一个 **write-only 注册表**：`Bootstrap` 初始化 `GlobalRegistry`，`instruction-surfaces.ts` 把 Prompt 资源注册进去，但运行时从不从注册表读回任何内容；SEPL 闭环已在 audit round3 T09 中删除，剩下 10 个文件 / ~3577 行基础设施，默认 `evolution.enabled=false`。它既不服务 v3.3「可核验交付」承诺，也制造了影子真相源。

本 Spec 的决策是：**不复活在线自演化闭环**，而是把 AGP 中真正可用的部分收窄为 **离线受控实验运行时**：

1. 核心只依赖一个轻量 `ExperimentRuntime` 端口；默认关闭，无实验时行为字节等价于现状。
2. 实验的候选生成、版本管理、真实评估、接受门、证据全部在 `scripts/agp/**` 离线实验室完成；core 不 import 实验室。
3. 运行时只读取已晋升的 **immutable overlay**，首批只开放两类对象：conditional Prompt surface 与 `RuntimeControlPolicy` 的有界字段。
4. 任何晋升必须绑定固定 held-in / held-out 任务集上的可复现评估证据；未过门禁只能留在 candidate/rejected 状态。
5. 借这次改造把 `src/agp/**` 连同 `bootstrap/config/state/logger/event-bus/tool-protocol/runtime-control/instruction-surfaces` 的残留全部移出或删除。

### 1.1 现状证据对照

| 维度 | 证据 |
|---|---|
| 注册有写入方、无读取方 | `Bootstrap.ts:197-237` 初始化 registry 并注册 Prompt；核心运行路径无 `registry.get()` 消费 |
| 演化闭环不可达 | `onEvolve` 从未赋值；静态值图 19/28 agp 文件不可达；`agp.strategies` 覆盖率 0%（audit round3 H8） |
| 默认不演化 | `bootstrap/config.ts:160` `evolution.enabled=false`；`tracingEnabled=true` 但只有可选 runtime-control trace feed |
| 评估缺失 | `harness-evolution-hardening-spec.md`：无真实 evaluator、无 held-in/held-out、failure mining 仅按错误字符串计数、improve 为占位 |
| 耦合残留 | core 直接 import AGP 的点：`instruction-surfaces.ts`、`postTurnHooks.ts`、`memory/integration.ts`、`bootstrap/state.ts`；另有 tool protocol 字段、evolution event、state `evolving`、logger `agp` |
| 产品不匹配 | `product-identity.md` 明确 v3.3 不是自演化 Agent；pre-v3.3 已记录「自进化非 v3.3 路线图承诺」 |

### 1.2 设计决策

- **保留概念**：版本谱系、overlay 注册、证据记录、回滚、热替换的“可逆变更”思想。
- **改造形态**：从“在线自演化系统”降级为“离线实验运行时 + 运行时只读 overlay”。
- **依赖方向反转**：core 定义端口，AGP 实现端口；core 不再 import `src/agp/**`。
- **首批只接低风险面**：Prompt 文本与有界策略参数；不接权限、沙箱、执行器、评估器、UI、核心架构。
- **没有评估就不晋升**：先有固定任务集与确定性指标，再谈候选和自动化。

---

## 2. Goals / Non-Goals

### 2.1 Goals

| ID | Goal |
|---|---|
| G1 | 核心 `src/experiments/**` 提供默认关闭的 `ExperimentRuntime` 端口、catalog 读取、会话锁定解析和 baseline 回退 |
| G2 | `scripts/agp/**` 离线实验室提供版本化 overlay、候选生成、评估、接受门、晋升/回滚与决策日志 |
| G3 | 在固定 held-in/held-out 长任务 eval 上建立可复现指标：verified task rate、no-patch rate、turns、budget |
| G4 | 首个竖切打通一个 conditional Prompt surface（`failure-recovery`），候选通过评估后可被 QueryEngine 实际读取 |
| G5 | 每个晋升 variant 绑定 evidenceRef；运行报告能追溯 session 实际使用的 variant |
| G6 | 删除 `src/agp/**` 及残留；core 对 AGP 的 import/coverage/config/文档全部清零 |

### 2.2 Non-Goals

- 不把 SEPL 泛型算子、`ContextManager`、`ServerInterface`、`DynamicManager`、5 类资源全局 registry 接回核心。
- 不做运行时在线 auto-evolve；candidate 不能在运行中生成或晋升。
- 不允许 overlay 修改代码、命令、工具实现、测试任务、评估器、权限、沙箱、SSRF、protected paths。
- 不承诺插件/IM/ACP 生态扩张，不改变 v3.3 产品承诺边界。
- 不在本 Spec 内实现多模型排行榜或 SWE-bench 全量提交。

---

## 3. Architecture

### 3.1 边界与数据流

```
离线（scripts/agp/**）                                  在线核心（src/**）
┌──────────────────────────────────────────────┐      ┌────────────────────────────────────┐
│ candidate generator                          │      │ Bootstrap / QueryEngine            │
│      │                                       │      │      │ resolve at session start   │
│      ▼                                       │      │      ▼                              │
│ version-store ──► evaluator ──► gate ──► cat │─────►│ ExperimentRuntime (catalog reader)  │
│      ▲                            │      │    │      │      │                              │
│      │                            ▼      │    │      │      ▼                              │
│ decision-log / evidence-store ◄── rejected│    │      │ Prompt surface / RuntimePolicy    │
│                                          │    │      │      │                              │
│                                          ▼    │      │      ▼                              │
│                                   catalog + active pointer │ completion report + run outcomes  │
└──────────────────────────────────────────────┘      └────────────────────────────────────┘
                                                        │
                                                        ▼
                                               .kc-cli/experiments/runs/*.jsonl
```

关键约束：catalog 的写路径只存在于实验室；`ExperimentRuntime` 对 catalog 只读。

### 3.2 核心端口

`src/experiments/protocol.ts` 只定义稳定契约，不 import `src/agp`、实验室或 QueryEngine：

```ts
export type ArtifactKind = 'prompt-surface' | 'runtime-policy';

export interface VariantRef {
  artifactId: string;
  variantId: string;
  baseHash: string;
  evidenceRef: string;
}

export interface ResolvedVariant<T> {
  value: T;
  artifactId: string;
  variantId: string | null; // null = baseline
  baseHash: string;
  source: 'baseline' | 'experiment';
}

export interface ExperimentRuntime {
  /** 会话创建时调用一次，返回锁定后的 assignment 快照 */
  initialize(): void;
  resolvePromptSurface(name: string, base: string): ResolvedVariant<string>;
  resolveRuntimePolicy(base: RuntimeControlPolicy): ResolvedVariant<RuntimeControlPolicy>;
  getAssignments(): readonly VariantRef[];
  recordRunOutcome(outcome: RunOutcome): Promise<void>;
}
```

`src/experiments/runtime.ts` 提供 `FileExperimentRuntime`：

- `config.experiments.enabled=false`（默认）时返回 baseline no-op，不做磁盘 IO。
- 启用时只读 `.kc-cli/experiments/catalog.json`；解析用 zod，非法/缺字段/未知版本 → 记 warn + 全量 baseline，不抛错。
- `initialize()` 在会话开始时把 active variant 快照进内存；会话中途不再重读 catalog。
- `resolvePromptSurface/resolveRuntimePolicy` 校验 `baseHash`；与当前代码 baseline 不一致时回退 baseline（防止过期 overlay）。
- `recordRunOutcome()` 采用追加 JSONL，失败只记日志，绝不影响主流程。

### 3.3 Catalog 与存储格式

目录：

```
.kc-cli/experiments/
├── catalog.json                 # 唯一运行时读取入口
├── evidence/
│   └── <evidenceHash>.json      # 不可变评估证据
├── runs/
│   └── <sessionId>.jsonl        # runtime outcome（可能被实验室读取）
└── decisions/
    └── decisions.jsonl          # append-only 晋升/回滚/拒绝日志
```

`catalog.json` 顶层格式：

```json
{
  "format": "kc.experiments.v1",
  "updatedAt": 0,
  "artifacts": {
    "prompt-surface:failure-recovery": {
      "kind": "prompt-surface",
      "baseHash": "sha256:...",
      "active": "cand-20260913-01",
      "variants": [
        {
          "variantId": "cand-20260913-01",
          "parentVariantId": null,
          "status": "promoted",
          "payload": "## Failure Recovery\n...",
          "evidenceRef": "sha256:...",
          "provenance": { "source": "manual", "labRunId": "..." }
        }
      ]
    },
    "runtime-policy:default": { "...": "..." }
  }
}
```

要求：

- `baseHash` 由 baseline 值的 canonical JSON / text 计算，用于检测代码基线漂移。
- `evidenceRef` 指向 `evidence/<hash>.json`，不可变；catalog 写入必须 `temp + rename` 原子替换。
- `status` ∈ `candidate | promoted | retired | rejected`；运行时只认 `promoted`，且只认 `active` 指向的版本。
- catalog 不存原始工具输出、密钥、完整会话；证据中的 stdout 截断 ≤ 4KB。

### 3.4 运行时读取路径

首批只接两个位置：

| 位置 | 接入点 | 数据形态 | 约束 |
|---|---|---|---|
| Conditional Prompt surface | `QueryEngine` 的 `conditionalInjection` 段（ephemeral，最后一段） | `string`，单 surface ≤ 2KB | 只允许 `CONDITIONAL_SURFACES` 中 `evolvable=true` 的表面；不得改 static prefix，保护 KV 缓存 |
| Runtime policy | `RuntimeControlHandler` 构造参数 | `RuntimeControlPolicy` 的 allowlist 字段 | `enabled` 不由 overlay 决定；数值有界；非法值整包回退 baseline |

写入时序：

1. `Bootstrap` 创建 `ExperimentRuntime`（仅 `config.experiments.enabled` 时），放进 scoped state。
2. QueryEngine 构造时调用 `initialize()` 锁定 assignment。
3. 每轮 streaming 前，conditional injection 用锁定的 overlay 文本替换对应 surface 的 baseline 文本。
4. 运行结束（成功/失败/预算停止）后 `recordRunOutcome()` 追加一行 JSONL。
5. completion report 带 `assignments` 与 `evidenceRefs`，供报告校验与后续 canary 统计。

### 3.5 离线实验室流水线

`scripts/agp/**`（Node + tsx，允许 type-only import `src/experiments/protocol.ts`；core 永不 import 该目录）：

1. **`version-store.ts`**：从旧 `version-manager.ts` 改造为文件型不可变版本谱系（variant 列表、parent、状态、rollback 目标）。
2. **`artifact-adapter.ts`**：从旧 `prompt-adapter.ts` 改造为「baseline 代码 → 可 overlay 描述 + baseHash + 验证规则」的适配器；删除重复的 default system prompt 生成。
3. **`candidate-generator.ts`**：手工 JSON 候选为主，可选 LLM 离线提案；每个候选必须带 audit 四元组（目标失败模式/修改面/预期效果/回归风险）。
4. **`evaluator-backend.ts` / `long-task-backend.ts`**：在隔离 workspace 中运行 baseline 与 candidate，采集 patch、验证命令、退出码、turns、成本。
5. **`acceptance-gate.ts`**：纯函数门禁；输入两份 split 指标，输出 accept/reject + 理由。
6. **`catalog-writer.ts` / `promotion.ts`**：证据落盘、catalog 原子更新、rollback、decision log。
7. **`cli.ts`**：`status`、`list`、`evaluate`、`promote`、`rollback`、`report`。

### 3.6 Evaluator 与接受门

**任务集**：`eval/sets/*.json`，格式 `kc.experiment_eval.v1`，held-in / held-out 在运行前固定且不相交；候选与生成器不可见 held-out。

**指标**（每 split 聚合）：

```ts
interface SplitResult {
  tasks: number;
  verifiedTaskRate: number;  // 主指标：patch 非空且验证命令 exit 0
  noPatchRate: number;       // 守卫：越低越好
  avgTurns: number;
  avgCostUsd: number;
  safetyViolations: number;  // 权限/沙箱/路径/敏感操作违规，必须为 0
}
```

**非回退门**（首版严格版，对齐 Self-Harness 思路）：

```
accept =
  candidate.safetyViolations === 0 &&
  ΔheldIn  >= 0 &&
  ΔheldOut >= 0 &&
  (ΔheldIn > 0 || ΔheldOut > 0) &&
  candidate.noPatchRate <= baseline.noPatchRate &&
  candidate.avgCostUsd  <= baseline.avgCostUsd * 1.2
```

`Δ` 取 repeats >= 3 的均值；任一门不满足 → candidate 标记 `rejected` 并归档证据，绝不晋升。若评估噪声导致同一 candidate 在同 split 上不可复现，视为评估不可用，停止后续自动化（见 §5.3 kill criteria）。

### 3.7 晋升、回滚与 canary

- 晋升必须由 `d2` 存在且可解析的 evidence 文件触发；`--yes` 显式确认后才能把 `active` 指向 candidate。
- `promoted` 版本不可原地修改；任何新候选必须有新的 `variantId` 与 parentVariantId。
- rollback = 将 `active` 指向同 artifact 的上一个 promoted variant；decision log 记录操作者、时间、理由。
- canary 为可选第二阶段：catalog 可带 `rollout: { mode: 'canary', percent: 5 }`；按 sessionId 的稳定 hash 分桶；只读取 canary 状态，不自动修改 active。
- 运行时回归只通过人工 rollback 或显式配置的自动 rollback（P2 再评估）；首版默认人工。

### 3.8 当前代码接入点

| 文件 | 改动 |
|---|---|
| `src/experiments/protocol.ts` | NEW：端口、类型、zod schema |
| `src/experiments/catalog.ts` | NEW：只读解析 + 校验 + baseHash |
| `src/experiments/runtime.ts` | NEW：`FileExperimentRuntime` / no-op 默认 |
| `src/bootstrap/config.ts` | 新增 `experiments` 配置；默认 `enabled=false`；`agp` 配置最终删除 |
| `src/bootstrap/Bootstrap.ts` | 删除 `initAgpPhase`/AGP checkpoint；仅 enable 时创建 experiment runtime |
| `src/bootstrap/state.ts` | 删除 `agpRegistry`；可选放 `experimentRuntime` |
| `src/bootstrap/cli-config.ts` | `--experiment <artifact=variant>`、`--no-experiments`；默认不加载 catalog |
| `src/query/QueryEngine.ts` | session 初始化锁定 overlay；conditional injection 走 resolver；结束追加 run outcome |
| `src/query/QueryEngineRuntimeControl.ts` | 删除 AGP trace feed；构造时接收已解析 policy |
| `src/api/prompts/instruction-surfaces.ts` | 删除 AGP import / registration bridge；保留 `evolvable` 作为 overlay allowlist 标记 |
| `src/query/completion-report.ts` | 输出 `assignments` 与 `evidenceRefs` |
| `src/orchestrator/report-validator.ts` | 校验 assignment/evidence 字段形状（不改变既有 R1–R5 语义） |
| `scripts/eval/agent-longtask-harness.mjs` | 扩展为可记录单任务指标与 split 汇总 |
| `evaluation/swe_bench/**` | 可选外部 evaluator backend；实验通过环境变量注入 variant pin |

### 3.9 安全与威胁模型

| 威胁 | 防线 |
|---|---|
| overlay 注入 prompt injection / 操作指令 | 仅允许声明式 allowlist 表面；schema + 长度 + 禁用模式校验；不允许 URL/命令代码字段 |
| candidate 修改评估器/任务集 | 评估器和 held-out 任务由实验室固定，候选进程无权写入；评估在独立 workspace |
| 过期 overlay 在代码基线变化后歪曲行为 | runtime 校验 `baseHash`，不匹配回退 baseline 并 warn |
| 实验导致越权/沙箱绕过 | overlay 不进入 permissions/sandbox/protectedPaths/SSRF/executor 配置；硬编码 frozen 列表 |
| 成本失控 | evaluator 受 `BudgetEnforcer`/maxCost 限制；catalog 禁止无 evidence 晋升 |
| 晋升后大面积回归 | 会话锁定、canary 百分比、单命令 rollback、decision log |
| catalog 损坏导致启动失败 | 解析失败全量 baseline；run outcome 写失败只 warn |
| 运行时不确定性破坏测试 | 默认关闭；启用时只在 ephemeral 段；新增确定性单测覆盖 baseline/no-op 等价 |

### 3.10 迁移与清理（AGP 退场）

将旧 AGP 分为“可回收”和“删除”两类：

**可回收/改造（移入 `scripts/agp/**`）**

- `version-manager.ts` → 文件型 `version-store.ts`（lineage/rollback/diff 语义保留为测试资产）。
- `dynamic-manager.ts` 的序列化/原子写思路 → `catalog-writer.ts`。
- `prompt-adapter.ts` 的“代码 Prompt → 资源描述”思路 → `artifact-adapter.ts`。
- `trace-manager.ts` 的事件分类可参考，但不再做在线 TraceManager；评估证据统一用 `RunOutcome` / `SplitResult`。

**删除（不迁移）**

- `registry.ts`、`context-manager.ts`、`server-interface.ts`、`types.ts`、`protocol.ts` 中 5 类资源通用模型与 evolution config。
- 所有 `src/agp` 内未被 core 消费的文件和测试。
- core 中所有 AGP 残留：Bootstrap `initAgpPhase`、config `agp`、state `agpRegistry`、state `evolutionState`/`evolving`、tool protocol AGP 字段、event-bus evolution 事件、`broadcastEvolution`、RuntimeControl trace feed、logger `agp`、instruction-surfaces registration、`memory.failureBridging` 与 `registerFailureBridgingHook`（旧 SEPL 证据类型不再作为 core 依赖）。

迁移完成后 grep 守卫：`rg "from '.*agp|src/agp" src` 必须为零命中。

---

## 4. Detailed Design

### 4.1 Allowlist：首批可 overlay 对象

| Artifact ID | 类型 | 允许字段 | 验证 |
|---|---|---|---|
| `prompt-surface:bootstrap-first-turn` | Prompt | 完整文本 | 非空、≤2KB、无密钥/命令注入模式、`evolvable=true` |
| `prompt-surface:failure-recovery` | Prompt | 完整文本 | 同上 |
| `runtime-policy:default` | Policy | `maxSameCallRetries` 0–5、`retryIntervention` soft/hard、`maxReadOnlyStreak` 1–20、`maxTotalToolMessages` 0–200、`redirectInstruction` ≤1KB | zod strict + 数值边界 |

首版不支持：static Prompt surface、工具实现、memory 参数、预算参数、并发度、权限/沙箱参数。

### 4.2 运行时解析伪代码

```
initialize():
  if !enabled: assignments = {}; return
  catalog = loadCatalog(catalogPath)
  for artifact in catalog.artifacts:
      active = promoted variant only
      if !active: continue
      if active.baseHash !== baselineHash(artifact): warn; continue
      assignments[artifact.id] = { variantId: active.variantId, payload, evidenceRef }

resolvePromptSurface(name, base):
  assignment = assignments["prompt-surface:" + name]
  if none: return { value: base, source: "baseline", variantId: null }
  return { value: assignment.payload, source: "experiment", ... }

resolveRuntimePolicy(base):
  assignment = assignments["runtime-policy:default"]
  if none: return baseline
  return mergeAllowlisted(base, assignment.payload)
```

### 4.3 RunOutcome 契约

```ts
interface RunOutcome {
  runId: string;
  sessionId: string;
  taskId?: string; // eval backend 写入；普通会话缺省回退 sessionId
  artifactAssignments: VariantRef[];
  success: boolean;
  verified: boolean;
  patchFiles: string[];
  verificationCommand?: string;
  verificationExitCode?: number;
  turns: number;
  noPatch: boolean;
  costUsd?: number;
  errorCode?: string;
  timestamp: number;
}
```

`recordRunOutcome` 写 `.kc-cli/experiments/runs/<sessionId>.jsonl`；字段不含完整消息、工具输出或密钥。

### 4.4 Evaluator Backend

```ts
interface EvaluatorBackend {
  name: string;
  evaluate(variant: VariantPin, split: EvalSplit, opts: EvalOptions): Promise<SplitResult>;
}
```

实现顺序：

1. `mock-longtask-backend`：固定 MockLLM + 本地 fixture 任务，验证流水线与门禁，不跑真实模型。
2. `swebench-backend`：包装 `evaluation/swe_bench/adapter.ts`，每个实例在独立 worktree 中运行，注入 variant pin/禁用 canary，读取 patch + FAIL_TO_PASS 结果。
3. 真实长任务 backend（可选）：复用 `scripts/eval/agent-longtask-harness.mjs` 的 baseline/probe/number 工具；默认需显式 enable。

### 4.5 失败与降级策略

- catalog 不存在/损坏/版本未知：全量 baseline，warn。
- `RuntimeControlPolicy` overlay 任一字段非法：整包 baseline，warn。
- Prompt overlay 命中禁用模式/超长：baseline，warn。
- `recordRunOutcome` 写失败：只 warn，不阻断 completion。
- 评估任一 backend 不可用：gate 返回 `blocked`，不产生晋升。
- 运行时无 experiments 配置：no-op，启动零额外 IO。

---

## 5. Acceptance Criteria

### 5.1 Functional AC

- [ ] AC1：`config.experiments.enabled=false` 时，system prompt、RuntimeControlPolicy、启动路径与现状字节/行为等价；现有测试零回归。
- [ ] AC2：`grep`/ESLint 守卫证明 core 不再 import `src/agp/**`；旧 AGP 从 src 树移除，knip/coverage 同步。
- [ ] AC3：固定 held-in/held-out eval 可重复运行；同一 baseline 在 repeats 内产生稳定 `SplitResult`（指标可比较）。
- [ ] AC4：一个 `failure-recovery` 候选通过 gate 后晋升，QueryEngine 在下一次会话实际使用该 overlay，session assignment 可在 completion report 中看到；rollback 后恢复 baseline。
- [ ] AC5：所有 promoted variant 都有不可变 evidenceRef；没有 evidence 的晋升命令被拒绝。
- [ ] AC6：catalog 损坏、baseHash 不匹配、非法 policy 值三种情况下均自动回退 baseline 且主流程不受影响。
- [ ] AC7：overlay 无法修改 frozen 列表中的任何配置；测试覆盖 schema/长度/边界/禁用模式。
- [ ] AC8：run outcome 证据可追溯到 variant，用于 canary 报告；写失败不致 fatal。

### 5.2 产品指标

以 v3.3 承诺为准，实验室至少一个真实 surface 的候选满足：

- `verifiedTaskRate` 在 held-in 或 held-out 上提升；
- held-in 与 held-out 均不回退；
- `noPatchRate` 不上升；
- `safetyViolations = 0`；
- 单任务成本不超过 baseline 的 1.2x（评估预算可另行设定）。

### 5.3 Kill / Stop Criteria

- T1/T5 后连续两轮同一 candidate 的结果不可复现（同 split 指标方差不可接受）：停止接入运行时，AGP 保持 archived。
- 三个候选均无法在固定 eval 上带来非回退提升：停止晋升路径，只保留离线报告，不进入 Phase 3。
- 评估成本超预算或触发安全违规：当日终止实验，保留 evidence 与 decision log。
- 实现过程中发现必须修改 permissions/sandbox/protectedPaths/executor 才能让实验成立：立即停止，重新评审。

---

## 6. Risks & Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| 固定 eval 过小，候选过拟合 | 假晋升 | held-in/held-out 分离；repeats>=3；禁止候选读取 held-out |
| 长任务运行成本高 | 评估不可持续 | 先用 mock/本地 fixture 验证；真实 backend 显式开启并受 budget 限 |
| Prompt overlay 影响 KV cache | 性能回退 | overlay 只进 ephemeral 最后一段；static prefix 不动 |
| ReAct 行为噪声 | gate 难判 | 先做确定性 mock 流水线；真实评估带重复与人工确认 |
| 旧 AGP 删除影响未知调用方 | 回归 | T13 前先完成 grep/typecheck/test；迁移后可回收资产留在 scripts |
| 研究代码再次回流 src | 架构回退 | core 只保留端口；实验室只能 type-only import core protocol；CI 守卫反向依赖 |
| 运行 outcome 泄露 | 隐私 | 只写摘要字段，stdout 截断 4KB，no secrets |

---

## 7. Task Mapping

实施拆解见 `docs/specs/agp-experiment-runtime-tasks.md`（13 tasks / 4 phases）：

- Phase 0：固定 eval 基线、core protocol 与只读 runtime。
- Phase 1：离线实验室、候选、评估、门禁、晋升/回滚、端到端演示。
- Phase 2：运行时 Prompt/Policy overlay 读取、evidence 绑定、canary。
- Phase 3：`src/agp/**` 与残留清理、文档与验收。

**MVP 建议顺序**：T1 → T2 → T3 → T4/T5 → T6 → T7 → T8 → T9，随后 T13 收口。T10/T11/T12 在 T9 跑通后推进。
