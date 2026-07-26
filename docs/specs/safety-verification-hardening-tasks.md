# kc-cli 结果验证与高风险操作安全机制加固 Task Breakdown

> Generated: 2026-07-24 | Based on `docs/specs/safety-verification-hardening-spec.md` v1.0
> Total Tasks: 7 | Phases: 3 | Source: 2026-07-24 对 toolExecutor / agent-orchestrator / permissions engine / Permission-System 及关联子系统的只读核查
> 整改范围：仅"结果验证 / 审批流程 / 回滚机制 / 恢复方案"四个评级为中等及以下的维度

---

## Task Dependency Graph

```
Phase 1 (P0 — 审批安全闸门):
  T1 非交互审批 fail-safe(H1)            [独立]

Phase 2 (P1 — 回滚与数据恢复):
  T2 文件写入原子化+备份(H2) ──┬──> T3 撤销栈+FileRestore(H3)
                              └──> T4 非Git回滚安全网(H4)
  T5 跨平台 type-check 修复(H5)          [独立]

Phase 3 (P2 — 审计证据与验收报告):
  T6 统一操作审计日志(M1)     ──> T7 通用任务收尾验收报告(M2)
```

依赖说明：
- **T2** 提供 `writeFileAtomic` 与 `.bak` 备份基础设施：T3 的还原走原子写、T4 的兜底依赖 `.bak` 快照，故 **T2 阻塞 T3、T4**。
- **T6** 产出的统一操作审计条目是 T7 收尾报告的数据源之一，故 **T6 阻塞 T7**。
- **T1、T5** 相互独立，可与其它任务并行推进。

---

## Phase 1: 审批安全闸门（P0）

### Task T1: Fail-safe non-interactive permission gate

- **Status:** `done`
- **Subject (imperative):** Add a fail-safe default policy so non-interactive `ask` decisions do not silently proceed
- **Subject (continuous):** Adding a fail-safe default policy so non-interactive `ask` decisions do not silently proceed
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.1.1（对应 H1）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [x] `ToolExecutor` 新增 `noninteractiveAskPolicy: 'deny' | 'allow' | 'proceed'`（默认 `'deny'`）
  - [x] `executeSingle`（`toolExecutor.ts:299-326`）在 `behavior === 'ask'` 且 `permissionRequestHandler == null` 时按策略决策，默认返回 `Permission denied (non-interactive)`
  - [x] CLI 增加 `--dangerously-skip-permissions`（语义等价 `proceed`），放行必须显式选择
  - [x] 放行决策记 `logger` 显式日志（含 tool 与 sessionId）
  - [x] 交互路径（已注册 handler）与 `acceptEdits` 语义完全不变
  - [x] 确认 ACP/IM 无头入口继承默认 deny（`acp/handlers.ts`、`im/im-bridge.ts`）
  - [x] 新增单测：无 handler 下 `ask` 默认被拒；`proceed`/CLI 开关下放行且有日志
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/executors/**`、`test/permissions/**` 无回归）
- **Files:**
  - MODIFY: `src/executors/toolExecutor.ts`（ask 分支 fail-safe + 策略字段）
  - MODIFY: `src/bootstrap/cli-config.ts`（`--dangerously-skip-permissions`）
  - MODIFY: `src/bootstrap/config.ts`（`noninteractiveAskPolicy` 配置项）
  - MODIFY: `src/bootstrap/Bootstrap.ts`（注入策略）
  - 关联: `src/acp/handlers.ts`, `src/im/im-bridge.ts`
  - NEW: `test/executors/noninteractive-ask.test.ts`

---

## Phase 2: 回滚与数据恢复（P1）

### Task T2: Make file writes atomic with backups

- **Status:** `done`
- **Subject (imperative):** Make FileWrite/FileEdit atomic and back up overwritten content before writing
- **Subject (continuous):** Making FileWrite/FileEdit atomic and backing up overwritten content before writing
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.2.1（对应 H2）
- **Dependencies:**
  - blockedBy: none
  - blocks: T3, T4
- **Checklist:**
  - [x] `ExecutionEnv.fs` 新增 `writeFileAtomic(path, content)`：同目录 `*.tmp-<rand>` 写入后 `rename` 原子替换
  - [x] 写前对已存在目标生成时间戳备份 `.kc-cli/backups/<relpath>.<ts>.bak`，保留数量默认 5、滚动清理
  - [x] `FileWriteTool`（`index.ts:51`）、`FileEditTool`（`index.ts:69`）改用 `writeFileAtomic`
  - [x] 成功结果 metadata 追加 `backupPath`；备份失败记 warn 并标记 `backupFailed:true`（不阻断写入）
  - [x] `execution-env-mock.ts` 对齐新接口
  - [x] `.gitignore` 忽略 `.kc-cli/backups/`
  - [x] 新增单测：写入中断不损坏目标（tmp 残留）；覆盖写生成 `.bak`；`backupPath` 入 metadata；滚动清理生效
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/tools/**` 无回归，含 Windows/*nix rename 双端）
- **Files:**
  - MODIFY: `src/services/execution-env.ts`（接口）
  - MODIFY: `src/services/execution-env-local.ts`（原子写 + 备份实现）
  - MODIFY: `src/services/execution-env-mock.ts`（mock 对齐）
  - MODIFY: `src/tools/FileWriteTool/index.ts`, `src/tools/FileEditTool/index.ts`
  - MODIFY: `.gitignore`
  - NEW: `test/services/write-atomic-backup.test.ts`

---

### Task T3: Add session undo stack and FileRestore tool

- **Status:** `done`
- **Subject (imperative):** Add a session-scoped operation journal and a FileRestore tool to undo edits
- **Subject (continuous):** Adding a session-scoped operation journal and a FileRestore tool to undo edits
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.2.2（对应 H3）
- **Dependencies:**
  - blockedBy: T2
  - blocks: none
- **Checklist:**
  - [x] 新增 `FileOperationJournal`（会话级，每个 QueryEngine 实例独立持有），记录 `{seq, filePath, backupPath, oldContent, newContent, turn, ts}`
  - [x] QueryEngine `executingPhase` 写操作成功后写入 journal（`operation` 按 FileWrite/FileEdit 区分）
  - [x] 新增 `FileRestore` 工具：`undo-last` / `restore <file>` / `list`，还原走 `writeFileAtomic` 且本身入 journal（可再撤销）
  - [x] `FileRestore` 归类写操作（`isDestructive`），`ask` 权限与 T1 fail-safe 一致；`restore` 经 `assertPathWithinWorkspace` 校验
  - [x] `tools.ts` + `registry.ts` 注册 FileRestore（eager / HIGH，模型可见）
  - [x] journal 通过 `ToolUseContext.journal?` 可选注入，随会话/子 Agent 隔离，互不串扰
  - [x] 新增单测：`undo-last` 精确还原；`restore` 还原到会话起点；撤销可再撤销；新建文件撤销即删除；journal 隔离；权限分类（`test/tools/file-restore.test.ts`，8 项全通过）
  - [x] `npm run typecheck` 通过；`npm test` 相关用例通过（既有 Windows 沙箱后端缺失导致的 QueryEngine 构造期失败为环境问题，与本任务无关）
- **Files:**
  - NEW: `src/state/file-operation-journal.ts`
  - NEW: `src/tools/FileRestoreTool/index.ts`
  - MODIFY: `src/query/QueryEngine.ts`（executingPhase 记录 journal）
  - MODIFY: `src/tools.ts`（注册）
  - 关联: `src/executors/toolExecutor.ts`（写操作元数据回流）
  - NEW: `test/tools/file-restore.test.ts`

---

### Task T4: Surface rollback safety net for non-Git workspaces

- **Status:** `done`
- **Subject (imperative):** Detect non-Git workspaces and surface a rollback safety-net warning instead of failing silently
- **Subject (continuous):** Detecting non-Git workspaces and surfacing a rollback safety-net warning instead of failing silently
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.2.3（对应 H4）
- **Dependencies:**
  - blockedBy: T2
  - blocks: none
- **Checklist:**
  - [x] `Bootstrap` 启动探测 `git rev-parse --is-inside-work-tree`（`isInsideGitRepo`），结果存入状态（`GlobalState.isGitRepo`）
  - [x] 非 Git 工作区一次性告警（Bootstrap 启动横幅）：自动暂存/提交不可用，回滚依赖 `.kc-cli/backups/`（FileRestore）
  - [x] `autoStageFile`/`autoCommitAll`（`utils/git.ts`）失败从静默改为 `logger.warn` 去抖记录首个错误（`resetGitWarnDebounce` 供测试）
  - [x] 确认非 Git 工作区下 T2 的 `.bak` 兜底可正常回滚（FileRestore 走 `writeFileAtomic`，不依赖 Git）
  - [x] QueryEngine 在 `isGitRepo === false` 时跳过 `autoStageFile`，避免无谓 `git add` 与噪声告警
  - [x] Git 工作区行为不变（真实仓库无告警，单测覆盖）
  - [x] 新增单测：非 Git 探测；git 失败被 warn（去抖）；真 Git 仓库不误报（`test/utils/git-safety-net.test.ts`，6 项全通过；已加固异步隔离：`autoStageFile` fire-and-forget 的晚到 warn 不再泄漏至鄰近用例，多次重跑确定性通过）
  - [x] `npm run typecheck` 通过；`npm test` 相关用例通过（Bootstrap `compose()` 与 `findProjectRoot` 的失败为既有 Windows 环境问题，与本任务无关）
- **Files:**
  - MODIFY: `src/bootstrap/Bootstrap.ts`（Git 探测 + 告警）
  - MODIFY: `src/utils/git.ts`（`isInsideGitRepo` + 失败 warn 去抖 + `resetGitWarnDebounce`）
  - MODIFY: `src/bootstrap/state.ts`（`GlobalState.isGitRepo`；即 Bootstrap/QueryEngine `getState()` 所用状态）
  - MODIFY: `src/query/QueryEngine.ts`（非 Git 跳过 autoStage）
  - NEW: `test/utils/git-safety-net.test.ts`

---

### Task T5: Fix cross-platform type-check verification

- **Status:** `done`
- **Subject (imperative):** Fix pre-exit type-check verification to run cross-platform without bash dependency
- **Subject (continuous):** Fixing pre-exit type-check verification to run cross-platform without bash dependency
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.2.4（对应 H5）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [x] `verifyTypeCheckBeforeExit`（`QueryEngine.ts`）改跨平台 spawn（`spawn(command, { shell:true, windowsHide:true })`，Windows→cmd.exe / *nix→/bin/sh），保留 `isStaticCommandSafe` allowlist + 元字符拒绝
  - [x] 区分 spawn 基础设施失败（`ENOENT` 等）与 type-check 结果：仅 `code===0` 判 `typecheck_pass`；spawn 失败经 `child.on('error')` 归类 `typecheck_infra_error` 并记 warn，绝不等价通过
  - [x] 保持 `verificationTimeout` 超时语义，超时（`SIGTERM`/`child.killed`）明确标 `timeout` 且不误判通过/失败
  - [x] 新增 `typeCheckStrict` 配置（`protocol.ts`）：默认 `false` 时 infra 失败让路（不阻断），`true` 时 infra 失败阻断退出以暴露验证缺口
  - [x] 新增单测：跨平台按退出码判定（`npx tsc --version`→pass）；类型错误阻止退出并回注失败详情；spawn 基础设施失败（ENOENT）与验证失败可区分；超时让路（`test/query/typecheck-cross-platform.test.ts`，12 项全通过）
  - [x] 在 Windows 端实测门禁真实运行（本机 Windows 25H2 spawn 经 cmd.exe 真实执行 `npx tsc`；`shell:true` 使同一路径在 *nix 走 /bin/sh）
  - [x] `npm run typecheck` 通过；`npm test` 相关用例通过（`test/query/typecheck-cross-platform.test.ts` 12/12）
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`（`verifyTypeCheckBeforeExit` 跨平台 + 失败分类）
  - MODIFY: `src/query/protocol.ts`（`PatchGuaranteeConfig.typeCheckStrict`）
  - NEW: `test/query/typecheck-cross-platform.test.ts`

---

## Phase 3: 审计证据与验收报告（P2）

### Task T6: Add a unified operation audit log

- **Status:** `done`
- **Subject (imperative):** Add a unified, persisted operation audit log for high-risk tool executions
- **Subject (continuous):** Adding a unified, persisted operation audit log for high-risk tool executions
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.3.1（对应 M1）
- **Dependencies:**
  - blockedBy: none
  - blocks: T7
- **Checklist:**
  - [x] 新增 `OperationAuditLog`（ring buffer maxEntries=5000 + 异步 serialized 落盘 `.kc-cli/audit/operations-<date>.jsonl`），复用 `AuditLog`（`agp/audit-log.ts`）的 ring buffer + 持久化模式
  - [x] `toolExecutor.executeSingle` 收尾（wrapper 委派 `executeSingleImpl` 后单点记录）记录高风险工具 `{sessionId, tool, inputSummary, permissionDecision, sandboxed, isError, durationMs, backupPath?, timedOut?, ts}`；仅审计 8 个高风险工具（`AUDITED_TOOLS`），只读工具排除
  - [x] 仅记摘要与元数据（path/command/url/args）；`redactAuditSummary` 单行折叠 + 200 字符截断，绝不落文件内容/敏感全文
  - [x] 异步落盘（fire-and-forget，`record()` 仅同步入内存并 enqueue serialized append，工具热路径不 await 磁盘）+ 优雅关闭 flush（`OperationAuditLog` 自注册 `process.once('beforeExit')`，复用 `CacheManager` 惯用法；并在 `executePostTurnHooksSync` 收尾 drain）
  - [x] 提供 `audit query`（`query()` / `queryOperationAudit()` 按 session/tool/时间窗/失败状态/limit 过滤）
  - [x] `.gitignore` 忽略 `.kc-cli/audit/`
  - [x] 附带修复 `executeWithTimeout` 元数据回流缺陷：executor 层此前剥离工具 `metadata`/`message`，导致 T3 journal 在真实流程收到 null `backupPath`/`oldContent`；现保留，惠及 T3（journal 真正落地）与 T6（audit `backupPath`）
  - [x] 新增单测：写/删/命令类工具产出条目；脱敏生效；关闭 flush 完整；query 按 session/tool/时间/失败/limit 检索正确；ring buffer 滚动；per-date JSONL 落盘（`test/services/operation-audit-log.test.ts`，19 项全通过）
  - [x] 异步落盘不显著增加工具延迟：`record()` 同步路径仅一次数组 push + Promise 链接，磁盘 append 全程 fire-and-forget 不阻塞（设计上非阻塞，无需额外基准）
  - [x] `npm run typecheck` 通过；`npm test` 相关用例通过（`test/services/operation-audit-log.test.ts` 19/19、`test/hooks/postTurnHooks.test.ts` 23/23；`test/executors` 因本修复由 13→16 通过，其余失败为既有 Windows 沙箱后端缺失环境问题，与本任务无关）
- **Files:**
  - NEW: `src/services/operation-audit-log.ts`
  - MODIFY: `src/executors/toolExecutor.ts`（收尾记录 + `executeWithTimeout` 元数据回流修复）
  - MODIFY: `src/hooks/postTurnHooks.ts`（关闭序列 drain audit flush）
  - MODIFY: `.gitignore`
  - NEW: `test/services/operation-audit-log.test.ts`

---

### Task T7: Generate a task-completion acceptance report

- **Status:** `done`
- **Subject (imperative):** Generate a structured acceptance report at task completion summarizing changes and verification
- **Subject (continuous):** Generating a structured acceptance report at task completion summarizing changes and verification
- **Spec:** `docs/specs/safety-verification-hardening-spec.md` Section 3.3.2（对应 M2）
- **Dependencies:**
  - blockedBy: T6
  - blocks: none
- **Checklist:**
  - [x] 任务进入 `completed` 前（`createCompleteEvent`，`QueryEngine.ts:1596`；调用点 `QueryEngine.ts:710`）汇总 `{modifiedFiles[], backups[], typeCheck, tests, turnCount, tokens, operationCounts}`
  - [x] 数据源复用 `modifiedFiles`（`QueryEngine.ts:166`）、`fileJournal.list()` 备份、T6 审计条目（`queryOperationAudit`）、门禁结果（`lastTypeCheckGate`/`lastTestGate`）、`budgetEnforcer.getSessionUsage()` token，**不新增 LLM 调用**（`buildAcceptanceReport` 为纯函数）
  - [x] 报告随 `agent:complete` 事件发出（`events.ts` 加 `report?: AcceptanceReport`），best-effort 写入 `.kc-cli/reports/<session>-<ts>.md`（`writeAcceptanceReport` fire-and-forget，`void` 调用不阻塞退出）
  - [x] 未开启 type-check/无测试时如实标注 `ran:false`（`skippedGate()` → `result:'skipped'`）；门禁 `ran` 仅在 pass/fail 有定论时为 true，timeout/infra_error/not_found 均如实标 `ran:false`，不产出虚假"已验证"结论
  - [x] 报告以 `sessionId` 关联会话（事件负载 `report.sessionId` 与落盘文件名 `<sanitized-session>-<ts>.md` 双向携带；`getReportSessionId` 从 `getState().sessionId` 解析，回退 stateStore）；`.gitignore` 忽略 `.kc-cli/reports/`
  - [x] 空任务（零修改）报告合理（`modifiedFiles`/`backups` 空数组、门禁 `skipped`、Markdown 渲染 `_No files modified._`）
  - [x] 新增单测：报告含变更文件与验证结果；状态如实标注；backup 去重；空任务；Markdown 渲染与落盘 sanitize（`test/query/completion-report.test.ts`，11 项全通过）
  - [x] `npm run typecheck` 通过；`npm test` 相关用例通过（`test/query/completion-report.test.ts` 11/11；type-only 循环导入 `events.ts ↔ completion-report.ts` 经 tsc 校验无运行时问题）
- **Files:**
  - NEW: `src/query/completion-report.ts`（`buildAcceptanceReport`/`formatAcceptanceReportMarkdown`/`writeAcceptanceReport`/`skippedGate` 纯函数 + 类型）
  - MODIFY: `src/query/QueryEngine.ts`（门禁结果捕获字段 + `createCompleteEvent(turnCount)` 汇总并随 complete 事件发出）
  - MODIFY: `src/state/events.ts`（`agent:complete` 加 `report?: AcceptanceReport`）
  - MODIFY: `.gitignore`（忽略 `.kc-cli/reports/`）
  - 关联: `src/services/operation-audit-log.ts`（T6 数据源）
  - NEW: `test/query/completion-report.test.ts`

---

## Progress Summary

| Task | Priority | Status | blockedBy | blocks |
|---|---|---|---|---|
| T1 非交互审批 fail-safe | P0 | `done` | — | — |
| T2 文件写入原子化+备份 | P1 | `done` | — | T3, T4 |
| T3 撤销栈+FileRestore 工具 | P1 | `done` | T2 | — |
| T4 非 Git 回滚安全网 | P1 | `done` | T2 | — |
| T5 跨平台 type-check 修复 | P1 | `done` | — | — |
| T6 统一操作审计日志 | P2 | `done` | — | T7 |
| T7 通用任务收尾验收报告 | P2 | `done` | T6 | — |

> 进度维护约定：始终保持至少一个任务处于 `in_progress`。完成 T1 后，将下一个待办（建议独立的 T5，或解锁链起点 T2）置为 `in_progress`；完成 T2 后 T3/T4 解锁，完成 T6 后 T7 解锁。
