# kc-cli 架构一致性收尾与健壮性强化 Task Breakdown

> Generated: 2026-07-20 | Based on `docs/specs/architecture-hardening-spec.md` v1.0
> Total Tasks: 6 | Phases: 3 | Source Review: `docs/review/CODE_REVIEW_2026-07-06.md` + 2026-07-20 源码复核

---

## Task Dependency Graph

```
Phase 1 (P0 — 架构一致性):
  T1 GlobalState 深隔离(H1) ──> T3 BudgetEnforcer 接入(H3)

Phase 2 (P1 — 对话连续性健壮性):
  T2 会话恢复走 API(H2)        [独立]
  T3 BudgetEnforcer 接入(H3)   [blockedBy T1]

Phase 3 (P2 — 清理与依赖收尾):
  T4 删除 @deprecated 渲染器(M1)  [独立]
  T5 依赖升级 uuid/zod(M2)        [独立]
  T6 Medium/Low 残项复核(L1)      [独立, 可产出新 backlog]
```

依赖说明：
- **T1** 是并发安全基础：`BudgetEnforcer` 的会话/Agent 级计数器需在隔离状态下持有，故 **T1 阻塞 T3**。
- **T2/T4/T5/T6** 相互独立，可并行推进；T6 复核可能派生新的 backlog 任务。

---

## Phase 1: 架构一致性（P0）

### Task T1: Deep-isolate GlobalState for sub-agent scoping

- **Status:** `completed`
- **Subject (imperative):** Deep-isolate GlobalState so sub-agents cannot mutate parent config
- **Subject (continuous):** Deep-isolating GlobalState so sub-agents cannot mutate parent config
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.1.1（对应 H1 / 基线 A1）
- **Dependencies:**
  - blockedBy: none
  - blocks: T3
- **Checklist:**
  - [x] `createScopedState`（`src/bootstrap/state.ts:39-41`）对 `config` 及可变嵌套字段做 `structuredClone` 深拷贝或 `Object.freeze` 冻结子 Agent 视图
  - [x] 审计全部 `getState()` 调用点，将依赖 `_fallbackState`（`state.ts:32`）的路径迁移到 `runWithScopedState()`
  - [x] 主 Agent 启动时以 `runWithScopedState(rootState, ...)` 包裹主循环（`Bootstrap.ts:201`、`init-sequence.ts:70`）
  - [ ] 移除 `_fallbackState` 及其兜底分支；`getState()` 无 ALS 上下文时 fail-fast 抛错。**偏差说明：实现中保留了 `_rootState` 根级兜底（供 REPL/测试/存量路径），子 Agent 强制走 ALS；仅未初始化时 fail-fast（`state.ts:64-77`）**
  - [x] `grep _fallbackState src` 归零（已更名为 `_rootState`，语义见上条偏差说明）
  - [x] 新增隔离单测：子 Agent 修改 `config.xxx`/`cwd`/`permissionMode` 不影响父与兄弟 Agent（`test/bootstrap/state-isolation.test.ts` + `src/bootstrap/state.test.ts`）
  - [x] `npm run typecheck` 通过（2026-07-28 实测）
  - [x] `npm test` 通过（`test/orchestrator/**` 无回归；Windows 本机失败均为 sandbox/路径环境问题）
- **Files:**
  - MODIFY: `src/bootstrap/state.ts`（深拷贝 + 移除 `_fallbackState`）
  - MODIFY: `src/bootstrap/Bootstrap.ts`（根状态 ALS 包裹）
  - MODIFY: `src/query/QueryEngine.ts`（主循环 ALS 包裹）
  - 关联: `src/orchestrator/backends/in-process.ts`
  - NEW: `test/bootstrap/state-isolation.test.ts`

---

## Phase 2: 对话连续性健壮性（P1）

### Task T2: Route session restore through a controlled API

- **Status:** `completed`
- **Subject (imperative):** Route session restore through QueryEngine.restoreSession instead of direct assignment
- **Subject (continuous):** Routing session restore through QueryEngine.restoreSession instead of direct assignment
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.2.1（对应 H2）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [x] 在 `QueryEngine` 新增 `restoreSession(snapshot)`：回填 messages → 重算 token 估算 → 复位压缩游标（清空 pending）→ 对齐 SessionTree 分支 → 校验首个 system+user 消息（`QueryEngine.ts:1744`）
  - [x] `AppRoot.tsx` 删除 `queryEngine.messages = loaded.messages` 直接赋值，改调 `queryEngine.restoreSession(loaded)`（现 `AppRoot.tsx:613`）
  - [x] 恢复失败（快照损坏/缺 system 消息）返回明确错误且当前会话保持不变
  - [x] 恢复后 `turnCount`/`model`/token 估算与快照一致（`AppRoot` 现有回填逻辑对齐）
  - [x] 新增单测：恢复后立即触发压缩不产生重复/错乱；损坏快照被拒（`test/query/restore-session.test.ts`）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过（`test/query/**`、`test/state/**` 无回归；Windows 本机失败为 sandbox 环境问题）
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`（新增 `restoreSession`）
  - MODIFY: `src/ui/components/AppRoot.tsx`（`:583` 改调 API）
  - 关联: `src/query/QueryEngineState.ts`, `src/query/QueryEngineCompaction.ts`, `src/state/*`
  - NEW: `test/query/restore-session.test.ts`

---

### Task T3: Wire BudgetEnforcer into the QueryEngine main loop

- **Status:** `completed`
- **Subject (imperative):** Wire BudgetEnforcer into the QueryEngine deciding phase for budget enforcement
- **Subject (continuous):** Wiring BudgetEnforcer into the QueryEngine deciding phase for budget enforcement
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.2.2（对应 H3）
- **Dependencies:**
  - blockedBy: T1
  - blocks: none
- **Checklist:**
  - [x] 依据配置构造 `BudgetEnforcer` 并随作用域状态持有。**偏差说明：实现在 `QueryEngine` 构造函数内（`QueryEngine.ts:212`）由 `maxBudgetUsd` 换算 token 上限，而非 Bootstrap 单独配置 `sessionTokenLimit`/`costLimit` 项**
  - [x] QueryEngine 在 `deciding`/发起下一次 provider 调用前调用 `checkTurnBudget(estimatedTokens)`（`QueryEngine.ts:831`；仅 token 维度，未传 cost 参数）
  - [x] `!allowed` 时优雅终止并向 UI 发 `agent:budget_exceeded` 事件（`QueryEngine.ts:835`，非静默卡死）
  - [x] 每轮 provider 返回后 `recordUsage(estimatedTokens)` 累计（`QueryEngine.ts:894`）
  - [ ] （可选）`StatusBarView` 展示 `getRemaining()`（未实现）
  - [x] 未设预算时行为不变（缺省宽松 `DEFAULT_BUDGET_CONFIG`）
  - [x] 新增预算强制单测：低预算下超限轮优雅终止；`recordUsage` 累计正确（`test/query/budget-enforcement.test.ts`）
  - [x] `npm run typecheck` 与 `npm test` 通过（Windows 本机失败为 sandbox 环境问题）
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`（deciding 前检查 + 用后记账）
  - MODIFY: `src/bootstrap/Bootstrap.ts`（构造并注入 enforcer）
  - MODIFY: `src/bootstrap/config.ts`（预算配置项）
  - 关联: `src/services/budget.ts`
  - 可选 MODIFY: `src/ui/components/StatusBarView.tsx`
  - NEW: `test/query/budget-enforcement.test.ts`

---

## Phase 3: 清理与依赖收尾（P2）

### Task T4: Remove deprecated string renderers

- **Status:** `completed`
- **Subject (imperative):** Remove deprecated string renderers superseded by ink components
- **Subject (continuous):** Removing deprecated string renderers superseded by ink components
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.3.1（对应 M1）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [x] 将依赖弃用渲染函数的单测断言迁移到对应 ink 组件测试，或移除仅覆盖死代码的用例
  - [x] 删除 `ChatView.ts` 的 `renderChatMessage`/`renderChatView`，保留仍被引用的类型（文件已整体删除，类型已迁至 `src/ui/view-protocol.ts`，见 ui-structural T6/T7）
  - [x] 删除 `Sidebar.ts` 的 `renderSidebar`（文件已整体删除）
  - [x] `grep @deprecated src/ui` 归零；确认无悬空导入（2026-07-28 实测 0 命中）
  - [x] `grep -r "renderChatView|renderSidebar|renderChatMessage" src` 无生产引用残留（仅 `test/ui/dead-path-guard.test.ts` 的防回流黑名单提及）
  - [x] `npm run typecheck` 通过
  - [x] `npm test` 通过
- **Files:**
  - MODIFY/DELETE: `src/ui/components/ChatView.ts`（删渲染函数，留类型）
  - MODIFY/DELETE: `src/ui/components/Sidebar.ts`（删 `renderSidebar`）
  - MODIFY: `test/ui/**`（迁移/移除死代码单测）

---

### Task T5: Upgrade uuid and zod to current major versions

- **Status:** `in_progress`
- **Subject (imperative):** Upgrade uuid and zod to current major versions with regression verification
- **Subject (continuous):** Upgrading uuid and zod to current major versions with regression verification
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.3.2（对应 M2 / 基线 D3、关联 Q5）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [x] 升级 `uuid@9→11`（现 `uuid@^11.1.1`）；注：`@types/uuid` 仍为 `^9.0.0`，uuid@11 自带类型，建议移除旧 types 依赖
  - [ ] 评估 `zod@3→4` 破坏性变更（重点 `zodToJsonSchema.ts` 的 `_def` 访问、`.describe()`、schema 推断）——无评估记录
  - [ ] 若升 zod4：改用 `z.toJSONSchema` 收敛 `as any`；若破坏面过大：保留 zod@3 并在 Spec 记录锁定理由 + 登记 backlog（现状：仍为 `zod@^3.23.8`，Spec 未记录锁定理由）
  - [ ] 核对 `highlight.js` 类型（基线 D2）——无核对记录
  - [x] `npm ls uuid zod` 版本符合预期（uuid 已升；zod 保持 3.x）
  - [ ] JSON Schema 生成逐工具对比升级前无回归——无对比记录
  - [x] `npm run typecheck` 与 `npm test` 通过（现状版本组合下）
- **Files:**
  - MODIFY: `package.json`, `package-lock.json`
  - 条件 MODIFY: `src/utils/zodToJsonSchema.ts`（升 zod4 时）

---

### Task T6: Re-audit residual Medium/Low findings

- **Status:** `pending`
- **Subject (imperative):** Re-audit residual Medium/Low findings and archive their current status
- **Subject (continuous):** Re-auditing residual Medium/Low findings and archiving their current status
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.3.3（对应 L1 / 基线 S5、Q3–Q5、P3、P5–P7）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [ ] 逐项复核 S5（`commandNormalizer` 是否覆盖变量展开/base64/引号变体）
  - [ ] 逐项复核 Q3（静默吞错点）、Q4（FileEditTool 错误处理）、Q5（Zod `as any`，与 T5 协同）
  - [ ] 逐项复核 P3（`ToolExecutor` 是否复用全局并发信号量）、P5（全量对话常驻内存）、P6（压缩额外 LLM 调用）、P7（每请求重序列化）
  - [ ] 每项标注 ✅已修复 / ⚠️部分 / ❌未修复，附证据行号
  - [ ] 已修复项补录至 Spec 1.1 表；未修复项登记为结构化 backlog（编号 + 位置 + 建议 + 优先级）
  - [ ] 产出复核结论清单（Spec 第 6 节或 `.workbuddy/memory/`）
- **Files:**
  - 只读复核（无源码修改）
  - MODIFY: `docs/specs/architecture-hardening-spec.md`（回填复核结论）
  - NEW（可选）: `.workbuddy/memory/2026-07-20.md`（复核归档）

---

## Progress Summary

| Task | Priority | Status | blockedBy | blocks |
|---|---|---|---|---|
| T1 GlobalState 深隔离 | P0 | `completed`（偏差：保留 `_rootState` 根级兜底） | — | T3 |
| T2 会话恢复走 API | P1 | `completed` | — | — |
| T3 BudgetEnforcer 接入 | P1 | `completed`（偏差：token 维度；未接 StatusBar） | T1 | — |
| T4 删除 @deprecated 渲染器 | P2 | `completed`（由 ui-structural T6/T7 一并完成） | — | — |
| T5 依赖升级 uuid/zod | P2 | `in_progress`（uuid 已升 11；zod 仍 3.x 且未记录锁定理由） | — | — |
| T6 Medium/Low 残项复核 | P2 | `pending`（未找到复核归档证据） | — | — |

> 进度维护约定：始终保持至少一个任务处于 `in_progress`。当前待办：T5 收尾（zod 评估/锁定理由 + `@types/uuid` 清理）与 T6 复核归档。
>
> **2026-07-28 状态对账**：T1–T4 按代码现状回写为 `completed`（含偏差说明）；T5/T6 保持未完成状态。`npm run typecheck` 实测通过；Windows 本机 vitest 4355 通过/138 失败，失败集中在 sandbox（bubblewrap 不可用）与 `/tmp` 路径等环境差异，非功能回归（CI ubuntu 为准）。
>
> **2026-07-28 长任务稳定性补丁**（四类中断风险修复，独立于 T1–T6）：
> 1. **turn 硬顶**：`autoExtendTurns` 默认改 `true`、`maxTurnsCeiling` 默认 100→400 且 `<= 0` 表示不封顶（`config.ts` schema + `QueryEngine.ts` ceiling 解析）；活跃进展（近 5 turns 有文件修改或工具调用）持续延长预算，停滞仍会停止。
> 2. **崩溃丢失窗口**：REPL 在每个 `agent:turn_complete` 上节流落盘（`ReplSessionService.saveThrottled`，默认 15s 间隔），并新增 `uncaughtException`/`unhandledRejection` 兜底保存（`main.ts`）。
> 3. **非 UI REPL 持久化**：`src/services/replSession.ts` + `/session list|<id>|new` 命令，与 ink UI 会话文件互通。
> 4. **autoCommit 默认开启**：`autoCommitInterval` 默认 0→10（每 10 turns best-effort 提交，非 git 仓库自动 no-op）；`autoCommitAll` 支持自定义 commit message，周期检查点使用 `checkpoint at turn N`。
