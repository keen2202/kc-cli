# Product Identity — kc-cli v3.3

> 状态：已决策（v3.3 scope filter）
> 日期：2026-09-13
> 用途：回答产品身份三个问题，并作为 v3.3 期间源码「留 / 移」的唯一裁决标准。
> 与本文冲突的 README、AGENTS.md、repowiki 或旧 roadmap 表述，实施时以本文为准更新。

---

## 1. kc-cli 替代/补充的是什么工作流

**Claude Code 优化 human-in-the-loop 的结对编程；kc-cli 优化 human-out-of-the-loop 的任务交付。**

所以 kc-cli 不是「本地版 Claude Code」，而是 **Agent 的无人值守执行/验收运行时**：把一次编码任务变成可调度、可限权、可限价、可核验的 job。

不是声称 Claude Code 不能无头运行；它的产品重心是交互式结对。真正迫使我换工具的是**约束组合**：模型/数据边界 + 无人值守默认拒绝 + 预算/轮次硬闸门 + 过程证据。四项同时成立时，Claude Code 的默认形态不合适。

我会不用 Claude Code 而用 kc-cli 的场景：

| 场景 | 为什么 Claude Code 不适合 | kc-cli 靠什么接住 |
|---|---|---|
| 代码/模型不能走 Anthropic 云（合规、内网、air-gapped，或必须用 Ollama/DeepSeek/Qwen/GLM 等） | 供应商与网络边界不匹配 | provider 可换；本地/私有模型可跑；数据只去指定边界 |
| CI、夜间、服务器上的批处理 issue 修复 | 无 TTY、无人按 y/n；交互式 REPL 不是调度单元 | `--print`/`--json`；非交互 `ask` 默认 deny；退出码可编程 |
| 单次运行有硬预算、轮次和 provider 约束 | 订阅/交互模式难做 per-job cost cap | budget / max-turns 硬闸门，超限优雅停止并如实报告 |
| 审计要求过程证据而非聊天记录 | 对话摘要不是审计产物 | 命令+退出码+文件写入对账；可回滚；完成声明绑定证据 |
| 任务长，要跨多轮甚至跨会话，且人不在场 | 无法随时纠偏 | planning、compaction、steering、session resume、长时间内存稳定 |

**选择边界**：云服务合规允许、人在回路、需要最强模型做开放式探索时，Claude Code 仍是更合理的选择；kc-cli 不承诺在结对编程体验上取胜。

---

## 2. v3.3 的唯一用户承诺

**交给它一个编码任务后离开，你收到的是可核验的交付——一个通过项目验证的 diff，或一份明确说清为什么没完成的报告。不存在「它说完成了，但你拿到的是空 diff、红测试或编造的数字」。**

JTBD：

> 当我把一个 issue 交给夜间/CI 任务而不是盯着终端时，我希望回来能直接验收：要么拿到通过项目自身测试/类型检查的改动，要么看到明确的未完成原因和卡点；不需要逐条复核它的自述。

可验证的验收信号（v3.3 must-pass）：

1. **不以空 patch 完成**：固定高难度 eval 上 no-patch 率 39% → <15%，平均轮次 72 → <50（`docs/guides/2026-06-29-benchmark-optimization-plan.md` 的目标）。
2. **完成必须有验证**：标记 `completed` 的运行必须给出 changed files、验证命令、退出码；测试/类型检查未通过或未运行，只能标 `unresolved` / `unverified`。
3. **声明必须可对账**：数字、文件写入、命令结论必须绑定 evidence；无法对账的声明按 blocker 处理，未决子代理不得渲染为 completed（RI-SPEC）。
4. **无人值守默认安全**：无权限 handler 时 `ask` 默认 deny；无沙箱后端默认拒执行；高风险操作可审计、可回滚。
5. **长会话稳定**：60 轮基准堆内存曲线趋平；预算/轮次耗尽时输出明确停止原因，而不是静默冻结。

**v3.3 明确不是**：自演化 Agent、AGP/SEPL、provider 数量军备竞赛、更华丽的 TUI、插件/IM/ACP 生态扩张、无人监管的 swarm。

---

## 3. 源码去留裁决

**判定规则**：唯一承诺只保护最短路径 `任务输入 → 执行 → 真实验证 → 证据化汇报 → 可回滚交付`。不在这条路径上、又没有当前生产调用者的模块，不留在 `src/`。

### 3.1 因承诺必须留在 src

| 能力包 | 核心目录/文件 | 对应承诺中的哪一步 |
|---|---|---|
| 任务主循环 | `src/bootstrap/**`（核心初始化，3.2 移出的周边除外）、`src/query/**`、`src/state/**`（核心状态；`session-tree.ts` 属冻结面） | planning→stream→decide→execute→verify→complete；压缩、预算、session、退出码 |
| 真实行动与回滚 | `src/tools/**` 的读写/搜索/Git/Run/任务类工具、`src/executors/**`、`src/Tool.ts`、`src/services/execution-env*.ts`、`services/file-lock.ts`、`state/file-operation-journal.ts`、`FileRestoreTool`、`utils/run-command.ts`、`utils/git.ts` | 产生真实 diff，并且可以撤销 |
| 模型与成本约束 | `src/api/**`、`services/budget.ts`、`services/cache/**`、`services/cachePrefix.ts`、`utils/tokenEstimation.ts`、`services/sessionManager.ts`、`services/replSession.ts` | 受限环境能运行、长任务跑得完 |
| 无人值守安全边界 | `src/permissions/**`、`services/sandbox*.ts`、`utils/ssrf.ts`、`utils/toolResultBoundary.ts`、`services/operation-audit-log.ts` | 无人确认时默认拒绝；危险命令被隔离；行为可审计 |
| 可信汇报与验收 | `src/orchestrator/**`（含 report-validator、execution trace）、`query/completion-report.ts`、`hooks/postTurnHooks.ts` | 声明↔证据对账；未完成绝不伪装完成 |
| 长时记忆 | `src/memory/**`（完成去 AGP 化后） | 跨轮/跨会话复用上下文与失败教训 |
| 进程入口与机器可验收 | `src/main.ts`、`bootstrap/cli-config.ts`、`bootstrap/app.ts`、`utils/exit-codes.ts`、`services/logger.ts`、`bootstrap/profiler.ts` | headless 运行、机器可读输出、失败以非零码退出 |

辅助但同样关键：`services/error-classifier.ts`、`services/circuitBreaker.ts`、`services/stateValidator.ts`。

harness-evolution 的两项**保留**：`InstructionSurface` 条件注入与 `RuntimeControlPolicy`（重试纪律、只读循环熔断、工具消息上限）。它们直接服务「不空转、真交付」，与 AGP 是否保留无关。

### 3.2 应明确移出 src

1. **AGP（全部余量）**：`src/agp/**` 整体移出（迁往 `extensions/agp` 或归档/删除），v3.3 不再以「预留子系统」身份留在源码里。理由：默认配置下产品行为零消费者（只做空转初始化）；自演化不是 v3.3 承诺；audit round3 T09 已记录 SEPL 闭环移除。
   - 同步拆除残留：`bootstrap/Bootstrap.ts` 的 `initAgpPhase`/checkpoint、`bootstrap/config.ts` 的 `agp` 配置、`bootstrap/state.ts` 的 `agpRegistry`、`state/protocol.ts` 的 `evolutionState` 与 `evolving` 状态、`tools/protocol.ts` 的 AGP 扩展字段、`orchestrator/event-bus.ts` 与 `agent-orchestrator.ts` 的 evolution 事件/API、`query/QueryEngineRuntimeControl.ts` 的懒加载 trace feed、`api/prompts/instruction-surfaces.ts` 的 AGP registration bridge、`services/logger.ts` 的 `agp` logger。
   - `EvidenceBundle` / `EvidenceCluster` / `FailureSignature` 等纯数据契约若仍被 memory/report 使用，迁入核心 `memory/protocol.ts` 或 core runtime-evidence 协议，并改由核心执行/汇报轨迹生产；没有核心生产者的功能（如 `memory.failureBridging`，默认关闭的 P2）随 AGP 一起移出，不进入 v3.3 承诺。
2. **ACP**：`src/acp/**`（`--acp` server）移出为独立集成包。它是别的 agent/IDE 调 kc-cli 的协议面，不属于「把任务跑完并验收」本身。
3. **IM**：`src/im/**`（当前仅 Feishu）移出为 extension。`services/autoReconnect.ts` 的唯一生产消费者是 Feishu adapter，随 IM 一起移出；IM 启动不得再阻塞 bootstrap 主链。
4. **测试挂命且无生产消费者的周边服务**：`services/firstRun.ts`、`bootstrap/autoConfig.ts`、`services/sessionMetrics.ts`、`services/idleDetection.ts`、`services/healthCheck.ts`。只有测试引用、不服务承诺；移出 src 或删除，并同步清理只为其续命的 coverage 测试（沿用 audit round3 H9 的处置原则）。

### 3.3 保留但不承诺（冻结）

以下保留在 `src/` 以维持 v3.2 既有用户，但 v3.3 不为它们新增功能、不纳入验收标准，其失败不得阻塞主承诺：

- `src/ui/**` 的既有交互能力（富 TUI）；权限对话路径除外，它是安全边界的一部分。
- `src/lsp/**`、`src/mcp/**`、`src/plugins/**`。
- 非核心工具：`Web*`、`DeployTool`、`DockerTool`、`MonitorTool`、`SqlTool`。
- `commands/branch.ts`、`state/session-tree.ts` 的 branch/checkout/history。
- `services/userProfile.ts`、`services/behavioralAdapter.ts`。
- `metrics/**` 等可观察性附加项。

> ACP/IM 若未来获得独立、稳定的 job story，可以 extension 包或独立产品形式回归；在此之前，不允许再以「预留」名义占用 `src/`。
