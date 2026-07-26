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

- **Status:** `in_progress`
- **Subject (imperative):** Deep-isolate GlobalState so sub-agents cannot mutate parent config
- **Subject (continuous):** Deep-isolating GlobalState so sub-agents cannot mutate parent config
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.1.1（对应 H1 / 基线 A1）
- **Dependencies:**
  - blockedBy: none
  - blocks: T3
- **Checklist:**
  - [ ] `createScopedState`（`src/bootstrap/state.ts:39-41`）对 `config` 及可变嵌套字段做 `structuredClone` 深拷贝或 `Object.freeze` 冻结子 Agent 视图
  - [ ] 审计全部 `getState()` 调用点，将依赖 `_fallbackState`（`state.ts:32`）的路径迁移到 `runWithScopedState()`
  - [ ] 主 Agent 启动时以 `runWithScopedState(rootState, ...)` 包裹主循环（`Bootstrap.ts`/`QueryEngine.ts`）
  - [ ] 移除 `_fallbackState` 及其兜底分支；`getState()` 无 ALS 上下文时 fail-fast 抛错
  - [ ] `grep _fallbackState src` 归零
  - [ ] 新增隔离单测：子 Agent 修改 `config.xxx`/`cwd`/`permissionMode` 不影响父与兄弟 Agent
  - [ ] `npm run typecheck` 通过
  - [ ] `npm test` 通过（`test/orchestrator/**` 无回归）
- **Files:**
  - MODIFY: `src/bootstrap/state.ts`（深拷贝 + 移除 `_fallbackState`）
  - MODIFY: `src/bootstrap/Bootstrap.ts`（根状态 ALS 包裹）
  - MODIFY: `src/query/QueryEngine.ts`（主循环 ALS 包裹）
  - 关联: `src/orchestrator/backends/in-process.ts`
  - NEW: `test/bootstrap/state-isolation.test.ts`

---

## Phase 2: 对话连续性健壮性（P1）

### Task T2: Route session restore through a controlled API

- **Status:** `pending`
- **Subject (imperative):** Route session restore through QueryEngine.restoreSession instead of direct assignment
- **Subject (continuous):** Routing session restore through QueryEngine.restoreSession instead of direct assignment
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.2.1（对应 H2）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [ ] 在 `QueryEngine` 新增 `restoreSession(snapshot)`：回填 messages → 重算 token 估算 → 复位压缩游标（清空 pending）→ 对齐 SessionTree 分支 → 校验首个 system+user 消息
  - [ ] `AppRoot.tsx:583` 删除 `queryEngine.messages = loaded.messages` 直接赋值，改调 `queryEngine.restoreSession(loaded)`
  - [ ] 恢复失败（快照损坏/缺 system 消息）返回明确错误且当前会话保持不变
  - [ ] 恢复后 `turnCount`/`model`/token 估算与快照一致（`AppRoot` 现有回填逻辑对齐）
  - [ ] 新增单测：恢复后立即触发压缩不产生重复/错乱；损坏快照被拒
  - [ ] `npm run typecheck` 通过
  - [ ] `npm test` 通过（`test/query/**`、`test/state/**` 无回归）
- **Files:**
  - MODIFY: `src/query/QueryEngine.ts`（新增 `restoreSession`）
  - MODIFY: `src/ui/components/AppRoot.tsx`（`:583` 改调 API）
  - 关联: `src/query/QueryEngineState.ts`, `src/query/QueryEngineCompaction.ts`, `src/state/*`
  - NEW: `test/query/restore-session.test.ts`

---

### Task T3: Wire BudgetEnforcer into the QueryEngine main loop

- **Status:** `pending`
- **Subject (imperative):** Wire BudgetEnforcer into the QueryEngine deciding phase for budget enforcement
- **Subject (continuous):** Wiring BudgetEnforcer into the QueryEngine deciding phase for budget enforcement
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.2.2（对应 H3）
- **Dependencies:**
  - blockedBy: T1
  - blocks: none
- **Checklist:**
  - [ ] `Bootstrap` 依据 `config`（`sessionTokenLimit`/`costLimit`，缺省安全默认）构造 `BudgetEnforcer` 并随作用域状态持有
  - [ ] QueryEngine 在 `deciding`/发起下一次 provider 调用前调用 `checkTurnBudget(estimatedTokens, estimatedCostUsd)`
  - [ ] `!allowed` 时以 `KCError('budget_exceeded', reason)` 优雅终止本轮并向 UI 发预算耗尽事件（非静默卡死）
  - [ ] 每轮 provider 返回后 `recordUsage(actualTokens, costUsd)` 累计
  - [ ] （可选）`StatusBarView` 展示 `getRemaining()`
  - [ ] 未设预算时行为不变（默认宽松或关闭）
  - [ ] 新增预算强制单测：低预算下超限轮优雅终止；`recordUsage` 累计正确
  - [ ] `npm run typecheck` 与 `npm test` 通过
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

- **Status:** `pending`
- **Subject (imperative):** Remove deprecated string renderers superseded by ink components
- **Subject (continuous):** Removing deprecated string renderers superseded by ink components
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.3.1（对应 M1）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [ ] 将依赖弃用渲染函数的单测断言迁移到对应 ink 组件测试，或移除仅覆盖死代码的用例
  - [ ] 删除 `ChatView.ts` 的 `renderChatMessage`/`renderChatView`，保留仍被引用的类型（如 `ChatMessage`）
  - [ ] 删除 `Sidebar.ts` 的 `renderSidebar`
  - [ ] `grep @deprecated src/ui` 归零；确认无悬空导入
  - [ ] `grep -r "renderChatView|renderSidebar|renderChatMessage" src` 无生产引用残留
  - [ ] `npm run typecheck` 通过
  - [ ] `npm test` 通过
- **Files:**
  - MODIFY/DELETE: `src/ui/components/ChatView.ts`（删渲染函数，留类型）
  - MODIFY/DELETE: `src/ui/components/Sidebar.ts`（删 `renderSidebar`）
  - MODIFY: `test/ui/**`（迁移/移除死代码单测）

---

### Task T5: Upgrade uuid and zod to current major versions

- **Status:** `pending`
- **Subject (imperative):** Upgrade uuid and zod to current major versions with regression verification
- **Subject (continuous):** Upgrading uuid and zod to current major versions with regression verification
- **Spec:** `docs/specs/architecture-hardening-spec.md` Section 3.3.2（对应 M2 / 基线 D3、关联 Q5）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [ ] 升级 `uuid@9→11` 与 `@types/uuid`，跑全套测试确认 `v4()` 用法兼容
  - [ ] 评估 `zod@3→4` 破坏性变更（重点 `zodToJsonSchema.ts` 的 `_def` 访问、`.describe()`、schema 推断）
  - [ ] 若升 zod4：改用 `z.toJSONSchema` 收敛 `as any`（顺带闭合 Q5）；若破坏面过大：保留 zod@3 并在 Spec 记录锁定理由 + 登记 backlog
  - [ ] 核对 `highlight.js` 类型（基线 D2）
  - [ ] `npm ls uuid zod` 版本符合预期
  - [ ] JSON Schema 生成逐工具对比升级前无回归
  - [ ] `npm run typecheck` 与 `npm test` 通过
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
| T1 GlobalState 深隔离 | P0 | `in_progress` | — | T3 |
| T2 会话恢复走 API | P1 | `pending` | — | — |
| T3 BudgetEnforcer 接入 | P1 | `pending` | T1 | — |
| T4 删除 @deprecated 渲染器 | P2 | `pending` | — | — |
| T5 依赖升级 uuid/zod | P2 | `pending` | — | — |
| T6 Medium/Low 残项复核 | P2 | `pending` | — | — |

> 进度维护约定：始终保持至少一个任务处于 `in_progress`。完成 T1 后，将下一个待办（建议 T2 或解锁的 T3）置为 `in_progress`。
