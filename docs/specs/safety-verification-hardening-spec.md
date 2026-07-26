# kc-cli 结果验证与高风险操作安全机制加固 Spec

> 基于 2026-07-24 对 `src/executors/toolExecutor.ts`、`src/orchestrator/agent-orchestrator.ts`、`src/permissions/engine.ts`、`docs/repowiki/Permission-System.md` 及关联子系统（`src/query/QueryEngine.ts`、`src/utils/git.ts`、`src/agp/**`、`src/tools/File*Tool/**`、`src/services/sessionManager.ts`）的只读核查编制
> Generated: 2026-07-24 | Version: 1.0 | Scope: `src/executors/**`、`src/query/**`、`src/tools/File*Tool/**`、`src/permissions/**`、`src/utils/git.ts`、`src/services/**`
> 原则基线：**默认安全 · 可回滚 · 可验证 · 可追溯** —— 只关闭"事后可核验与可恢复"侧的实质缺口，不引入新业务特性

---

## 1. Executive Summary

针对 kc-cli 在"任务结果验证"与"高风险操作安全机制"两方面的能力核查，**"防患于未然"侧（deny-first 权限引擎 + 沙箱强制 + SSRF/受保护路径拦截）设计扎实、绕过免疫机制完善（评级：强）**；但**"事后可核验与可恢复"侧存在四个维度评级为中等及以下**，本 Spec 仅针对这四个维度立项整改：

| 维度 | 核查评级 | 核心缺口 |
|---|---|---|
| 审批流程 | 中等 | 非交互/无头模式下 `ask` 决策静默放行（`toolExecutor.ts:303`，注释明示 "preserve legacy behavior (proceed)"） |
| 回滚机制 | 弱-中 | 用户文件编辑无原子写/无备份/无撤销；仅依赖 best-effort Git；AGP 版本化回滚不覆盖用户文件 |
| 结果验证 | 中等 | 测试门禁仅 SWE-bench（`state.failToPass`）触发；type-check 门禁 `spawn('bash',...)` 在 Windows 失效并静默放行 |
| 恢复方案 | 中等 | 无文件级备份/快照；非 Git 工作区回滚安全网静默失效；通用任务操作无统一审计链 |

- **P0（1）：** 非交互审批 fail-safe 默认策略——关闭"无 handler 即放行"的安全闸门缺口。
- **P1（4）：** 文件写入原子化+备份、会话级撤销栈+回滚工具、非 Git 工作区回滚安全网、跨平台 type-check 验证修复。
- **P2（2）：** 统一操作审计日志（持久化）、通用任务收尾验收报告。
- **Risk Profile:** Phase 1（Low–Medium，行为默认值收紧）/ Phase 2（Medium，触及文件写路径与执行器）/ Phase 3（Low–Medium，审计与报告增量）。
- **Total Estimated Effort:** 约 4–6 天。

### 1.1 核查证据对照（供追溯）

| 维度 | 评级 | 关键证据 |
|---|---|---|
| 高风险操作检测 | ✅ 强（不整改） | `checkSecurityCritical`（`engine.ts:336-419`）覆盖系统目录/受保护路径/SSRF/Sql；bypass 需 `KC_ALLOW_BYPASS=1`（`engine.ts:99-106`）；realpath 解析软链接（`engine.ts:328-334`） |
| 沙箱强制 | ✅ 强（不整改） | Bash/Run 执行器层强制包装 + HMAC 签名（`toolExecutor.ts:339-357`）；无后端则拒执行（`toolExecutor.ts:329-337`） |
| **审批流程** | ⚠️ **中等** | `ask` 仅在 `permissionRequestHandler` 存在时路由用户（`toolExecutor.ts:303`）；handler 仅由 UI 注册（`AppRoot.tsx:246`）；headless（ACP/IM/直接查询）无 handler → 放行 |
| **回滚机制** | ⚠️ **弱-中** | `FileEdit` 直接 `fs.writeFile`（`FileEditTool/index.ts:69`）；`FileWrite` 同（`FileWriteTool/index.ts:51`）；`oldContent` 仅入 metadata 供 diff 预览、无撤销消费；AGP `rollbackAll`（`sepl/commit.ts:208-225`）仅限自演化资源 |
| **结果验证** | ⚠️ **中等** | 测试门禁读 `state.failToPass`（`QueryEngine.ts:1346-1350`）；type-check 用 `spawn('bash',...)`（`QueryEngine.ts:1224`），spawn 失败 → catch → `canExit:true`（`QueryEngine.ts:1252-1254`） |
| **恢复方案** | ⚠️ **中等** | `autoStageFile`/`autoCommitAll` best-effort 静默失败（`utils/git.ts:132-159`）；无 `.bak`/快照；`AuditLog` 仅 AGP（`agp/audit-log.ts`）；`SessionManager` 仅恢复对话不恢复文件（`sessionManager.ts`） |

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| H1 | 非交互模式 `ask` 决策静默放行 | 审批流程 / 安全 | 无 handler 时 fall-through 到执行（`toolExecutor.ts:299-326`） | fail-safe：无 handler 时按可配置默认策略（默认 `deny`），或需显式 `--dangerously-skip-permissions` 才放行 |
| H2 | 文件写入无原子性 + 无备份 | 回滚 / 健壮性 | `FileWrite`/`FileEdit` 直接覆盖写，进程中断/写错即损坏 | 写前落 `.bak` 快照 + 原子写（temp→rename），失败可还原 |
| H3 | 缺少文件操作撤销/回滚能力 | 回滚 / 可用性 | `oldContent` 已捕获但无任何撤销消费 | 会话级操作撤销栈 + `FileRestore` 工具，可撤销上一次/指定编辑 |
| H4 | 非 Git 工作区回滚安全网静默失效 | 恢复 / 健壮性 | `autoStageFile`/`autoCommitAll` 静默吞错，用户无感知 | 启动检测工作区 Git 状态；非 Git 或写失败时告警并回退到 `.bak` 快照目录 |
| H5 | type-check 验证跨平台失效 | 结果验证 / 跨平台 | `spawn('bash',...)` 在 Windows 无 bash 时 spawn 报错 → 静默 `canExit:true` | 跨平台 spawn（不依赖 bash），spawn 失败与 type-check 失败区分处理，Windows 正常门禁 |
| M1 | 通用任务操作无统一审计链 | 可核验证据 / 可追溯 | `AuditLog` 仅覆盖 AGP 自演化，逐工具操作无持久化审计 | 统一操作审计日志（写/删/命令等高风险工具），ring buffer + 异步落盘，可按 session 追溯 |
| M2 | 通用任务缺乏收尾验收报告 | 结果验证 / 可核验证据 | 无预设测试且未触发 type-check 时无验收门禁与证据产出 | 任务收尾生成"变更文件 + 已运行验证命令 + 结果"结构化报告，随会话产出 |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 非交互审批 fail-safe 默认策略（H1） | 1 | High | 0.5d | Low–Medium |
| P1 | T2 文件写入原子化 + 备份（H2） | 2 | High | 1d | Medium |
| P1 | T3 会话级撤销栈 + FileRestore 工具（H3） | 2 | Medium | 1d | Medium |
| P1 | T4 非 Git 工作区回滚安全网（H4） | 2 | Medium | 0.5d | Low |
| P1 | T5 跨平台 type-check 验证修复（H5） | 2 | Medium | 0.5d | Low |
| P2 | T6 统一操作审计日志（M1） | 3 | Medium | 1d | Low |
| P2 | T7 通用任务收尾验收报告（M2） | 3 | Medium | 0.5d | Low |

---

## 3. Detailed Fix Proposals

### 3.1 Phase 1 — 审批安全闸门（P0）

#### 3.1.1 T1 — 非交互审批 fail-safe 默认策略（安全性增强 + 架构优化 · H1）🔴

**Problem:** `toolExecutor.executeSingle` 在权限结果为 `ask` 时，仅当 `this.permissionRequestHandler` 存在才路由用户裁决（`toolExecutor.ts:303`）；handler 只由 UI 在 `AppRoot.tsx:246` 注册。**无头/非交互路径（ACP 服务、IM 桥、程序化直接查询）从不注册 handler**，导致 `ask` 决策直接 fall-through 执行（代码注释明示 "Without a registered UI handler we preserve legacy behavior (proceed)"）。即在 `default` 模式下的写操作、受保护路径 `ask` 等在无头模式下**无人工确认即执行**，与 deny-first 安全基线不一致。

**Solution（安全性增强 + 架构优化）：**
1. 在 `ToolExecutor` 引入 `noninteractiveAskPolicy: 'deny' | 'allow' | 'proceed'` 配置（默认 `'deny'`），由 `Bootstrap`/CLI 配置注入。
2. 改造 `executeSingle`：当 `behavior === 'ask'` 且 `permissionRequestHandler == null` 时，按 `noninteractiveAskPolicy` 决策——默认 `deny`（返回 `Permission denied (non-interactive): ...`），仅当显式配置 `allow`/CLI `--dangerously-skip-permissions` 时才放行，并在日志显式记录放行决策与 session。
3. CLI 增加 `--dangerously-skip-permissions` 显式开关（语义等价于 `proceed`），确保"放行"必须是用户显式选择而非默认行为。
4. 交互路径（已注册 handler）行为完全不变；`acceptEdits` 对编辑自动通过的既有语义保留。

**验证：** 无头模式下 `default` 写操作在无 handler 时被拒并给出明确原因；配置 `--dangerously-skip-permissions` 后恢复放行并有日志；交互模式回归无变化。

**Files:** MODIFY `src/executors/toolExecutor.ts`（新增策略字段 + `ask` 分支 fail-safe）；MODIFY `src/bootstrap/cli-config.ts` / `src/bootstrap/config.ts`（`--dangerously-skip-permissions` 与配置项）；MODIFY `src/bootstrap/Bootstrap.ts`（注入策略）；关联 `src/acp/handlers.ts`、`src/im/im-bridge.ts`（确认无头入口继承默认 deny）。

---

### 3.2 Phase 2 — 回滚与数据恢复（P1）

#### 3.2.1 T2 — 文件写入原子化 + 备份（代码重构 + 健壮性 · H2）🔴

**Problem:** `FileWriteTool`（`index.ts:51`）与 `FileEditTool`（`index.ts:69`）均直接 `context.env.fs.writeFile(filePath, content)` 覆盖目标文件——**无原子性**（进程/信号中断可留下半截文件）、**无备份**（覆盖后原内容仅存于 tool 结果 metadata，无落盘）。一旦写入错误或崩溃，无本地回滚点。

**Solution（代码重构 + 健壮性）：**
1. 在 `ExecutionEnv.fs` 抽象层新增 `writeFileAtomic(path, content)`：写入同目录 `*.tmp-<rand>` 后 `rename` 原子替换（POSIX/Windows 均支持目录内 rename 原子性）。
2. 写前若目标已存在，生成时间戳备份至工作区隐藏目录 `.kc-cli/backups/<relpath>.<ts>.bak`（可配置保留数量，默认 5，超出滚动清理）。
3. `FileWrite`/`FileEdit` 改用 `writeFileAtomic`，并在成功结果 metadata 追加 `backupPath` 字段，供 T3 撤销与 UI 展示。
4. 备份为 best-effort 但**失败可感知**：备份失败时记 warn 且在 metadata 标记 `backupFailed:true`（不阻断写入，避免影响主流程）。

**验证：** 写入中断不产生半截文件（tmp 残留而非目标损坏）；覆盖写生成 `.bak`；`backupPath` 出现在 metadata；备份目录滚动清理生效；`FileEditTool` 现有单测无回归。

**Files:** MODIFY `src/services/execution-env.ts`、`src/services/execution-env-local.ts`（`writeFileAtomic` + 备份）；MODIFY `src/tools/FileWriteTool/index.ts`、`src/tools/FileEditTool/index.ts`（改用原子写 + 回填 `backupPath`）；MODIFY `src/services/execution-env-mock.ts`（mock 对齐）；MODIFY `.gitignore`（忽略 `.kc-cli/backups/`）。

#### 3.2.2 T3 — 会话级撤销栈 + FileRestore 工具（架构优化 + 可用性 · H3）🟡

**Problem:** `FileWrite`/`FileEdit` 已在 metadata 捕获 `oldContent`（`FileWriteTool/index.ts:62`、`FileEditTool/index.ts:79`），但**无任何撤销机制消费它**——仅用于 diff 预览。用户/Agent 无法"撤销上一次编辑"或回滚到会话开始前状态。

**Solution（架构优化 + 可用性）：**
1. 新增 `FileOperationJournal`（会话级操作日志，随作用域状态持有）：QueryEngine 在 `executingPhase` 记录每次 `FileWrite`/`FileEdit` 成功的 `{filePath, backupPath, oldContent, newContent, turn, ts}`（`QueryEngine.ts:1108-1120` 已有 modifiedFiles 追踪点，扩展为完整 journal）。
2. 新增 `FileRestore` 工具：支持 `undo-last`（撤销最近一次写/编辑）、`restore <file>`（还原指定文件到会话前/指定备份）、`list`（列出可撤销操作）。还原走 T2 的 `writeFileAtomic` 并本身入 journal（可再次撤销）。
3. `FileRestore` 归类为写操作，经权限引擎 `ask` 与 T1 fail-safe 一致处理；受保护路径仍 bypass-immune。
4. UI 提供快捷入口（可选，复用现有 overlay 模式），非本 Spec 强约束。

**验证：** `undo-last` 精确还原最近一次编辑内容与大小；`restore` 还原到备份内容；撤销操作本身可再撤销；journal 随会话隔离（子 Agent 不串扰）；新增撤销单测。

**Files:** NEW `src/state/file-operation-journal.ts`；NEW `src/tools/FileRestoreTool/index.ts`；MODIFY `src/query/QueryEngine.ts`（executingPhase 记录 journal）；MODIFY `src/tools.ts`（注册工具）；关联 `src/executors/toolExecutor.ts`（写操作元数据回流）。

#### 3.2.3 T4 — 非 Git 工作区回滚安全网告警（健壮性 · H4）🟡

**Problem:** 回滚兜底完全依赖 Git：`autoStageFile`（`utils/git.ts:132-140`）与 `autoCommitAll`（`utils/git.ts:146-159`）均**静默吞错**。若工作区非 Git 仓库或 git 不可用，安全网无声失效，用户误以为有 Git 历史可回退。

**Solution（健壮性 + 架构优化）：**
1. `Bootstrap` 启动时探测工作区是否为 Git 仓库（`git rev-parse --is-inside-work-tree`），结果存入状态。
2. 非 Git 工作区：启动横幅/状态栏一次性告警"未检测到 Git 仓库，自动暂存/提交安全网不可用，将依赖 `.kc-cli/backups/` 快照回滚"，并确保 T2 备份为唯一兜底、正常工作。
3. `autoStageFile`/`autoCommitAll` 失败从"静默"改为 `logger.warn` 记录首个错误（去抖，避免刷屏），可核查。
4. （可选）非 Git 工作区提供 `--init-shadow-git` 在 `.kc-cli/` 下初始化影子仓库承接自动提交，不污染用户目录。

**验证：** 非 Git 工作区启动有明确告警且不崩溃；`.bak` 兜底可回滚；git 失败被 warn 记录而非静默；Git 工作区行为不变。

**Files:** MODIFY `src/bootstrap/Bootstrap.ts`（Git 探测 + 告警）；MODIFY `src/utils/git.ts`（失败 warn 去抖）；关联 `src/ui/components/StatusBarView.tsx`（告警展示，可选）；关联 `src/state/types.ts`（`isGitRepo` 状态）。

#### 3.2.4 T5 — 跨平台 type-check 验证修复（安全性/正确性 · H5）🟡

**Problem:** 退出前 type-check 门禁通过 `spawn('bash', ['-c', command])`（`QueryEngine.ts:1224`）执行。**Windows 默认无 bash**，spawn 触发 `error` 事件 → `catch` → 返回 `{ canExit: true, reason: 'timeout' }`（`QueryEngine.ts:1252-1254`）——即**类型检查门禁在 Windows 上被静默跳过**，验证形同虚设（用户环境为 Windows 25H2，直接受影响）。

**Solution（安全性增强 + 跨平台正确性）：**
1. 将 `verifyTypeCheckBeforeExit` 的执行改为跨平台：直接 `spawn(runner, args, { shell: true })` 或按 `process.platform` 选择 shell（Windows→`cmd`/`powershell`，*nix→`bash`），复用 `isStaticCommandSafe`（`QueryEngine.ts:1187-1199`）allowlist 保持注入防护。
2. **区分 spawn 基础设施失败与 type-check 结果**：spawn 无法启动（`ENOENT` 等）不得等价于"通过"——记 warn 并按配置决定是否阻断（默认对"命令存在但环境缺失"give-way 放行，对"命令探测到但运行异常"提示）；`code===0` 才 `typecheck_pass`。
3. 保持 `verificationTimeout` 超时语义；超时明确标记 `timeout` 且不误判为通过验证。

**验证：** Windows 下 `npm run typecheck`/`tsc` 门禁真实运行并按退出码判定；类型错误时阻止退出并回注失败详情；跨平台（Linux/macOS/Windows）一致；spawn 缺失与验证失败在日志可区分。

**Files:** MODIFY `src/query/QueryEngine.ts`（`verifyTypeCheckBeforeExit` 跨平台 spawn + 失败分类）；关联 `src/query/protocol.ts`（如需新增 `typeCheckStrict` 配置项）。

---

### 3.3 Phase 3 — 审计证据与验收报告（P2）

#### 3.3.1 T6 — 统一操作审计日志（可核验证据 · M1）🟢

**Problem:** `AuditLog`（`agp/audit-log.ts`）仅记录 AGP 自演化周期，**通用任务的逐工具操作（尤其 `FileWrite`/`FileEdit`/`Bash`/`Run`/`Sql`/`WebFetch` 等高风险工具）无统一持久化审计链**，事后无法完整追溯"谁、何时、对什么、做了什么、结果如何"。

**Solution（可核验证据 + 性能）：**
1. 新增 `OperationAuditLog`（ring buffer + 异步批量落盘 `.kc-cli/audit/operations-<date>.jsonl`），复用 `AuditLog` 的 ring buffer/持久化模式（`agp/audit-log.ts:61-92,240-266`）避免重复造轮子。
2. 在 `toolExecutor.executeSingle` 收尾统一记录高风险工具的 `{sessionId, tool, inputSummary, permissionDecision, sandboxed, isError, durationMs, backupPath?, ts}`；只记摘要与元数据，**不落敏感文件全文**（受保护路径内容脱敏）。
3. 异步落盘（fire-and-forget + 优雅关闭时 flush，复用 `postTurnHooks` 的 `executePostTurnHooksSync` 收尾模式），避免阻塞工具主路径（性能）。
4. 提供 `audit query`（按 session/tool/时间/是否失败过滤）复用 `AuditLog.query` 的过滤签名。

**验证：** 写/删/命令类工具执行后产出审计条目；含权限决策与沙箱标记；敏感内容脱敏；异步落盘不影响工具延迟（基准对比）；优雅关闭 flush 完整；`audit query` 可按条件检索。

**Files:** NEW `src/services/operation-audit-log.ts`；MODIFY `src/executors/toolExecutor.ts`（收尾记录审计）；MODIFY `src/hooks/postTurnHooks.ts` 或关闭序列（flush）；关联 `.gitignore`（忽略 `.kc-cli/audit/`）。

#### 3.3.2 T7 — 通用任务收尾验收报告（结果验证 · M2）🟢

**Problem:** 测试门禁仅在 `state.failToPass` 有值（SWE-bench 场景）时触发（`QueryEngine.ts:1346-1350`）；普通开发任务若无预设测试且未触发 type-check，退出时**无验收证据产出**，只能依赖模型自述结论。

**Solution（结果验证 + 可核验证据）：**
1. 任务进入 `completed` 前（`QueryEngine.ts:656` 附近）生成结构化收尾报告：`{modifiedFiles[], backups[], typeCheck: {ran, command, result}, tests: {ran, command, result}, turnCount, tokens}`。
2. 报告来源复用现有信号：`modifiedFiles`（`QueryEngine.ts:151`）、T6 审计条目、type-check/test 门禁结果——不新增额外 LLM 调用（性能）。
3. 报告随 `agent:complete` 事件发出并可选写入 `.kc-cli/reports/<session>-<ts>.md`，供用户/CI 验收。
4. 未开启 type-check/无测试时报告如实标注 `ran:false`，避免虚假"已验证"结论（诚实性）。

**验证：** 任务收尾产出报告含变更文件与验证结果；type-check/test 状态如实标注；无额外 LLM 调用；报告可落盘并被 `SessionManager` 关联；空任务（零修改）报告合理。

**Files:** MODIFY `src/query/QueryEngine.ts`（`completed` 前汇总报告 + 随 complete 事件发出）；关联 `src/services/sessionManager.ts`（报告关联会话）、`src/services/operation-audit-log.ts`（T6 数据源）。

---

## 4. Impacted File List

| 文件 | 涉及任务 | 变更类型 |
|---|---|---|
| `src/executors/toolExecutor.ts` | T1,T3,T6 | MODIFY（ask fail-safe + journal 元数据 + 审计记录） |
| `src/bootstrap/cli-config.ts` | T1 | MODIFY（`--dangerously-skip-permissions`） |
| `src/bootstrap/config.ts` | T1 | MODIFY（`noninteractiveAskPolicy` 配置项） |
| `src/bootstrap/Bootstrap.ts` | T1,T4 | MODIFY（注入策略 + Git 探测告警） |
| `src/acp/handlers.ts`,`src/im/im-bridge.ts` | T1 | 关联（确认无头入口继承默认 deny） |
| `src/services/execution-env.ts` | T2 | MODIFY（`writeFileAtomic` 接口） |
| `src/services/execution-env-local.ts` | T2 | MODIFY（原子写 + 备份实现） |
| `src/services/execution-env-mock.ts` | T2 | MODIFY（mock 对齐） |
| `src/tools/FileWriteTool/index.ts` | T2,T3 | MODIFY（原子写 + `backupPath`） |
| `src/tools/FileEditTool/index.ts` | T2,T3 | MODIFY（原子写 + `backupPath`） |
| `src/state/file-operation-journal.ts` | T3 | NEW（会话级操作日志） |
| `src/tools/FileRestoreTool/index.ts` | T3 | NEW（撤销/还原工具） |
| `src/tools.ts` | T3 | MODIFY（注册 FileRestore） |
| `src/query/QueryEngine.ts` | T3,T5,T7 | MODIFY（journal 记录 + type-check 跨平台 + 收尾报告） |
| `src/query/protocol.ts` | T5 | 条件 MODIFY（`typeCheckStrict`） |
| `src/utils/git.ts` | T4 | MODIFY（失败 warn 去抖） |
| `src/state/types.ts` | T4 | MODIFY（`isGitRepo` 状态） |
| `src/ui/components/StatusBarView.tsx` | T4 | 可选 MODIFY（Git/预算告警展示） |
| `src/services/operation-audit-log.ts` | T6 | NEW（统一操作审计） |
| `src/hooks/postTurnHooks.ts` | T6 | MODIFY（关闭序列 flush 审计） |
| `src/query/completion-report.ts` | T7 | NEW（验收报告纯函数构建/渲染/落盘） |
| `src/state/events.ts` | T7 | MODIFY（`agent:complete` 加 `report?: AcceptanceReport`） |
| `src/services/sessionManager.ts` | T7 | 关联（报告以 `sessionId` 关联会话，无代码改动；事件负载与落盘文件名双向携带 sessionId） |
| `.gitignore` | T2,T6,T7 | MODIFY（忽略 `.kc-cli/backups/`、`.kc-cli/audit/`、`.kc-cli/reports/`） |

---

## 5. Implementation Progress Tracker

> 状态核对基准：本 Spec 创建于 2026-07-24；实现完成后回填 ✅ 与完成日期，附 `npm run typecheck` + `npm test` 通过证据。

| Task | 描述 | Phase | Priority | Status | 完成日期 |
|---|---|---|---|---|---|
| T1 | 非交互审批 fail-safe 默认策略（H1） | 1 | P0 | ✅ done | 2026-07-24 |
| T2 | 文件写入原子化 + 备份（H2） | 2 | P1 | ✅ done | 2026-07-24 |
| T3 | 会话级撤销栈 + FileRestore 工具（H3） | 2 | P1 | ✅ done | 2026-07-24 |
| T4 | 非 Git 工作区回滚安全网（H4） | 2 | P1 | ✅ done | 2026-07-24 |
| T5 | 跨平台 type-check 验证修复（H5） | 2 | P1 | ✅ done | 2026-07-24 |
| T6 | 统一操作审计日志（M1） | 3 | P2 | ✅ done | 2026-07-24 |
| T7 | 通用任务收尾验收报告（M2） | 3 | P2 | ✅ done | 2026-07-24 |

---

## 6. Verification & Test Plan

### 6.1 通用门禁
- `npm run typecheck` 无错误；`npm test` 全绿（`vitest.config.ts`）。
- 现有测试不回归；T1–T3、T5–T7 新增针对性单测。
- **跨平台专项：** T2（原子 rename）、T5（type-check spawn）需在 Windows 与 *nix 双端验证。

### 6.2 分任务验证要点
- **T1：** 无头模式 `default` 写操作在无 handler 时默认被拒并给出原因；`--dangerously-skip-permissions` 恢复放行且有日志；交互模式回归无变化。
- **T2：** 写入中断不留半截目标文件；覆盖写生成 `.bak`；`backupPath` 入 metadata；备份滚动清理生效。
- **T3：** `undo-last` 精确还原；`restore` 还原到备份；撤销可再撤销；journal 会话隔离。
- **T4：** 非 Git 工作区启动明确告警且不崩溃；git 失败被 warn；`.bak` 兜底可回滚。
- **T5：** Windows 下 type-check 真实运行并按退出码判定；类型错误阻止退出；spawn 缺失与验证失败可区分。
- **T6：** 高风险工具执行产出审计条目（含权限决策/沙箱标记）；敏感内容脱敏；异步落盘不增显著延迟；关闭 flush 完整。
- **T7：** 收尾报告含变更文件与验证结果，type-check/test 状态如实标注；无额外 LLM 调用；可落盘并关联会话。

### 6.3 回归范围
- 权限与执行器（`test/permissions/**`、`test/executors/**`）、文件工具（`test/tools/**`）、查询引擎验证/压缩（`test/query/**`）、会话持久化（`test/services/**`）、编排隔离（`test/orchestrator/**`）全跑。

---

## 7. Assumptions

- `noninteractiveAskPolicy` 默认 `deny`；显式 `--dangerously-skip-permissions` 或配置 `allow` 时方可无头放行，视为用户自担风险。
- `.kc-cli/backups/` 备份保留数量默认 5、可配置；备份为工作区内隐藏目录，不进入版本控制。
- T5 对"命令存在但运行环境缺失"默认 give-way 放行（避免误伤无 type-check 项目），仅对"命令探测到且异常退出"阻断；如需严格模式以 `typeCheckStrict` 开启。
- 操作审计仅记摘要与元数据，受保护路径内容脱敏，不落敏感全文。
- 本轮不改动已评为"强"的权限引擎/沙箱核心决策顺序，仅在其外围补齐审批 fail-safe、回滚、验证与审计能力。
