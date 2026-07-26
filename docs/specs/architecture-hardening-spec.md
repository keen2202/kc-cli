# kc-cli 架构一致性收尾与健壮性强化 Spec

> 基于 `docs/review/CODE_REVIEW_2026-07-06.md` 基线 + 2026-07-20 全仓库源码逐条复核编制
> Generated: 2026-07-20 | Version: 1.0 | Scope: `src/bootstrap/**`、`src/query/**`、`src/services/**`、`src/ui/**`、`package.json`
> 原则基线：**收敛残债 · 隔离彻底 · 恢复可靠 · 依赖现代化** —— 不引入新特性，只关闭已识别但未闭合的一致性/健壮性缺口

---

## 1. Executive Summary

自 2026-07-06 综合审查以来，项目已完成一轮高质量集中整改。经 2026-07-20 **源码逐条复核**，原 15 项 High 级问题中 **13 项已真实修复**（含 S1/S2/S3/S6/S7/A2/A3/A4/A5/Q1/Q2/P1/P2/P4/D1/D4），其中 **A3（DI 容器）由"整体删除 ServiceContainer"彻底解决**。本 Spec 仅针对**剩余 3 项真实缺口 + 2 项清理项 + 1 项复核项**，避免对已闭合项做无谓返工。

- **核心缺口（3）：** A1 GlobalState 隔离不彻底（浅拷贝共享 config 引用 + ALS 迁移未完成）、会话恢复绕过 `ConversationState` API、`BudgetEnforcer` 已实现但未接入主循环。
- **清理项（2）：** `@deprecated` 字符串渲染器残留、`uuid@9`/`zod@3` 依赖落后大版本。
- **复核项（1）：** S5/Q3–Q5/P3/P5–P7 等 Medium/Low 项状态定向复核。
- **Risk Profile:** Phase 1（Medium，触及子 Agent 状态隔离）/ Phase 2（Low–Medium，恢复与预算）/ Phase 3（Low，清理与复核）。
- **Total Estimated Effort:** 约 3–5 天。

### 1.1 基线复核结论对照（供追溯）

| 原编号 | 问题 | 2026-07-20 复核状态 | 证据 |
|---|---|---|---|
| S1 | SqlTool 任意 SQL | ✅ 已修复 | `resolveAllowed()` 白名单 + 拒 `:memory:` + 默认 readonly + worker 隔离 |
| S2 | 沙箱静默降级 | ✅ 已修复 | `failIfNoSandbox: true` 默认 + 硬失败（`sandbox.ts:48,125`） |
| S3 | bypassPermissions 绕过 | ✅ 已修复 | 需 `KC_ALLOW_BYPASS=1`（`engine.ts:97-104`） |
| S4 | 安全检查覆盖不足 | ✅ 已修复 | `checkSecurityCritical` 覆盖 Sql db/query、WebFetch url（`engine.ts:150-151`） |
| S6 | WebFetch SSRF 重定向 | ✅ 已修复 | 每跳 `isInternalUrl` 校验（`WebFetchTool/index.ts:64-78`） |
| S7 | 提示注入缓解 | ✅ 已修复 | `wrapIfUntrustedSource`（`utils/toolResultBoundary`） |
| A2 | ExecutionEnv 被绕过 | ✅ 已修复 | `createToolContext` 注入 env（`QueryEngine.ts:1206`），BashTool 无 `child_process` 兜底 |
| A3 | DI 容器闲置 | ✅ 已解决 | `ServiceContainer` **整体删除**，零引用 |
| A4 | Result<T,E> 死代码 | ✅ 已修复 | `src/utils/result.ts` 删除 |
| A5 | runAgent 单体 | ✅ 已修复 | 抽取 `Bootstrap` 类（`Bootstrap.ts:145`） |
| Q1 | ACP 静默吞错 | ✅ 已修复 | `.catch` 记录并回传通知 |
| Q2 | cacheMetrics 冲突 | ✅ 已修复 | 重命名 `kvCacheMetrics.ts`，`services/cacheMetrics.ts` 删除 |
| P1 | 子 Agent 无限并发 | ✅ 已修复 | `Semaphore(8)`（`agent-orchestrator.ts:34`） |
| P2 | sqlite 同步阻塞 | ✅ 已修复 | `worker_threads` + 超时 |
| P4 | feedbackMap 泄漏 | ✅ 已修复 | LRU（maxSize 2000, TTL 24h） |
| D1 | 嵌套重复项目 | ✅ 已修复 | `kc-cli/kc-cli/` 删除 |
| D4 | 无 engines 约束 | ✅ 已修复 | `engines.node: ">=20"` |
| **A1** | **GlobalState 隔离** | ⚠️ **部分修复** | ALS 已引入，但 `createScopedState` 浅拷贝（`state.ts:39-41`）+ `_fallbackState` 未迁移（`state.ts:30 TODO(A1)`） |
| **—** | **会话恢复绕过 API** | ❌ **未处理** | `AppRoot.tsx:583` 直接赋值 `queryEngine.messages` |
| **—** | **预算未接主循环** | ❌ **未处理** | `BudgetEnforcer`（`budget.ts:64`）零生产消费 |
| **UI** | **@deprecated 渲染器** | ⚠️ **待清理** | `ChatView.ts`/`Sidebar.ts` 遗留字符串渲染器 |
| D3 | uuid/zod 落后 | ❌ **未处理** | `uuid@^9`（当前 11）、`zod@^3`（当前 4） |
| S5/Q3–Q5/P3/P5–P7 | Medium/Low 项 | 🔍 **待复核** | 未逐行验证，需定向确认 |

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| H1 | GlobalState 子 Agent 隔离不彻底 | 架构 / 并发安全 | `createScopedState` 浅拷贝共享 `config` 嵌套引用；`_fallbackState` 全局单例仍在 | 深隔离：`config` 深拷贝/冻结，移除 `_fallbackState`，全部调用走 `runWithScopedState` |
| H2 | 会话恢复绕过 `ConversationState` API | 对话连续性 / 状态一致性 | `AppRoot.tsx:583` 直接 `queryEngine.messages = loaded.messages` | 经受控 `restoreSession()` 接口注入，重建 token 计数/压缩游标/SessionTree 分支 |
| H3 | `BudgetEnforcer` 未接入主循环 | 健壮性 / 成本控制 | 已实现零消费，长对话无预算中断 | 在 QueryEngine `deciding` 阶段做 `checkTurnBudget` + `recordUsage`，超限优雅终止 |
| M1 | `@deprecated` 字符串渲染器残留 | 维护成本 / 代码整洁 | `ChatView.ts`/`Sidebar.ts` 遗留渲染函数（仅单测引用） | 迁移单测断言到 ink 组件后删除渲染函数，保留必要类型 |
| M2 | 核心依赖落后大版本（D3） | 依赖健康 | `uuid@^9`、`zod@^3` | 评估破坏性变更后升级至 `uuid@11`、`zod@4`（或锁定并记录理由） |
| L1 | Medium/Low 残项状态未复核 | 安全 / 质量 / 性能 | S5/Q3–Q5/P3/P5–P7 未逐行确认 | 定向复核并归档：已修复标注，未修复登记为后续 backlog |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 GlobalState 深隔离（H1） | 1 | High | 1d | Medium |
| P1 | T2 会话恢复走受控 API（H2） | 2 | High | 0.5d | Medium |
| P1 | T3 BudgetEnforcer 接入主循环（H3） | 2 | Medium | 0.5d | Low |
| P2 | T4 删除 @deprecated 字符串渲染器（M1） | 3 | Low | 0.5d | Low |
| P2 | T5 核心依赖升级 uuid/zod（M2） | 3 | Medium | 0.5d | Medium |
| P2 | T6 Medium/Low 残项定向复核（L1） | 3 | Medium | 0.5d | Low |

---

## 3. Detailed Fix Proposals

### 3.1 Phase 1 — 架构一致性（P0）

#### 3.1.1 T1 — GlobalState 深隔离（架构优化 · H1）🔴

**Problem:** `createScopedState`（`state.ts:39-41`）为 `{ ...parent, ...overrides }` **浅拷贝**——顶层字段隔离，但 `config` 等嵌套对象仍为**共享引用**。子 Agent 若改写 `state.config.xxx` 会污染父 Agent 与兄弟 Agent，权限级联"子 ≤ 父"在嵌套配置层被绕过。此外 `_fallbackState`（`state.ts:32`，注释 `TODO(A1): Remove once all callers use runWithScopedState()`）作为过渡全局单例仍在，ALS 迁移未收尾。

**Solution（架构优化 + 并发安全）：**
1. `createScopedState` 对 `config`（及其它可变嵌套字段）做**结构化深拷贝**（`structuredClone`）或 `Object.freeze` 冻结子 Agent 视图，确保子 Agent 无法回写父配置。
2. 审计 `getState()` 所有调用点，将仍依赖 `_fallbackState` 的路径迁移到 `runWithScopedState()`；主 Agent 启动时以 `runWithScopedState(rootState, ...)` 包裹主循环。
3. 迁移完成后删除 `_fallbackState` 与其兜底分支，`getState()` 无 ALS 上下文时**显式抛错**（fail-fast），杜绝隐式全局态。
4. 保留一个受控的根状态初始化入口（`Bootstrap`），避免破坏现有启动序列。

**验证：** 子 Agent 内 `getState().config.xxx = v` 不影响父 `getState().config.xxx`；`grep _fallbackState` 无残留；子/父 `cwd`、`permissionMode`、`config` 互不干扰的隔离单测通过。

**Files:** MODIFY `src/bootstrap/state.ts`（深拷贝 + 移除 `_fallbackState`）；MODIFY `src/bootstrap/Bootstrap.ts` / `src/query/QueryEngine.ts`（根状态以 ALS 包裹）；关联 `src/orchestrator/backends/in-process.ts`（子 Agent 生成路径）。

#### 3.1.2 依赖说明

T1 是并发安全基础，`BudgetEnforcer`（T3）的会话/Agent 级计数器需在隔离状态下持有，故 **T1 阻塞 T3**。

---

### 3.2 Phase 2 — 对话连续性健壮性（P1）

#### 3.2.1 T2 — 会话恢复走受控 API（状态一致性 · H2）🔴

**Problem:** `AppRoot.tsx:583` 直接 `queryEngine.messages = loaded.messages` 覆盖内部消息数组，**绕过 `ConversationState` 的不变量校验**：token 计数、压缩游标（microcompact/fullcompact 的 pending 结果）、SessionTree 当前分支指针未被同步重建。恢复后首次压缩或分支操作可能读到陈旧游标，导致上下文错乱或重复压缩。

**Solution（健壮性 + 封装）：**
1. 在 `QueryEngine` 暴露受控恢复接口 `restoreSession(snapshot: SessionSnapshot): void`，内部：重置并回填 messages → 重算 token 估算 → 复位压缩游标（清空 pending）→ 将 SessionTree 指针对齐到快照分支 → 校验首个 system+user 消息存在。
2. `AppRoot` 的 `/load`/session 切换分支改调 `queryEngine.restoreSession(loaded)`，删除直接字段赋值。
3. 恢复失败（快照损坏/缺 system 消息）返回明确错误并保持当前会话不变（不做半途覆盖）。

**验证：** 加载会话后立即触发压缩不产生重复/错乱；恢复后 `turnCount`/`model`/token 估算与快照一致；损坏快照被拒绝且当前会话保持完好；新增恢复单测。

**Files:** MODIFY `src/query/QueryEngine.ts`（新增 `restoreSession`）；关联 `src/query/QueryEngineState.ts`、`src/query/QueryEngineCompaction.ts`（游标复位）、`src/state/*`（SessionTree 指针）；MODIFY `src/ui/components/AppRoot.tsx:583`（改调 API）。

#### 3.2.2 T3 — BudgetEnforcer 接入主循环（成本控制 · H3）🟡

**Problem:** `BudgetEnforcer`（`src/services/budget.ts:64`）实现完整（`checkTurnBudget`/`recordUsage`/`getRemaining`），但**全仓库零生产消费**——长对话/失控循环无 token 或成本上限，可能持续调用 provider 直至外部中断。

**Solution（健壮性 + 成本控制）：**
1. 在 `Bootstrap` 依据 `config`（`sessionTokenLimit`/`costLimit`，缺省给安全默认）构造 `BudgetEnforcer` 并随作用域状态持有（依赖 T1 的隔离，确保子 Agent 各自计数或按策略汇总）。
2. QueryEngine 进入 `deciding`/发起下一次 provider 调用前调用 `checkTurnBudget(estimatedTokens, estimatedCostUsd)`；`!allowed` 时以 `KCError('budget_exceeded', reason)` **优雅终止本轮**，向 UI 发出预算耗尽事件而非静默卡死。
3. 每轮 provider 返回后 `recordUsage(actualTokens, costUsd)` 累计。
4. UI 在状态栏/侧栏展示 `getRemaining()`（可选，复用现有 tokens 展示位）。

**验证：** 设置低预算后对话在超限轮优雅终止并提示；`recordUsage` 累计正确；未设预算时行为不变（默认宽松或关闭）；新增预算强制单测。

**Files:** MODIFY `src/query/QueryEngine.ts`（deciding 前检查 + 用后记账）；MODIFY `src/bootstrap/Bootstrap.ts`（构造并注入 enforcer）；关联 `src/services/budget.ts`、`src/bootstrap/config.ts`（预算配置项）、`src/ui/components/StatusBarView.tsx`（可选展示）。

---

### 3.3 Phase 3 — 清理与依赖收尾（P2）

#### 3.3.1 T4 — 删除 @deprecated 字符串渲染器（维护成本 · M1）🟢

**Problem:** `src/ui/components/ChatView.ts`（`renderChatMessage`/`renderChatView`）与 `src/ui/components/Sidebar.ts`（`renderSidebar`）标注 `@deprecated`，无生产调用点，仅存活于单测。活路径已全面走 ink 组件（`ChatMessagesView`/`SidebarPanel`），字符串渲染器构成同名 `.ts`/`.tsx` 认知碰撞与维护负担。

**Solution（代码重构）：**
1. 将依赖弃用渲染函数的单测断言迁移到对应 ink 组件测试（`test/ui/**`）或直接移除仅覆盖死代码的用例。
2. 删除 `ChatView.ts`/`Sidebar.ts` 中的 `@deprecated` 渲染函数，**保留仍被 ink 组件引用的类型**（如 `ChatMessage`）。
3. `grep @deprecated src/ui` 归零；确认无悬空导入。

**验证：** `grep -r renderChatView|renderSidebar|renderChatMessage src` 无生产引用残留；`npm run typecheck` 通过；`npm test` 全绿（迁移后用例数一致或有意减少并记录）。

**Files:** MODIFY/DELETE `src/ui/components/ChatView.ts`、`src/ui/components/Sidebar.ts`；MODIFY 相关 `test/ui/**` 单测。

#### 3.3.2 T5 — 核心依赖升级 uuid/zod（依赖健康 · M2）🟡

**Problem:** `uuid@^9`（当前 11）、`zod@^3`（当前 4）落后一个大版本。zod 4 有破坏性 API 变更，且项目已有 `zodToJsonSchema.ts` 通过 `_def` 访问内部结构（原 Q5），升级需同步核对。

**Solution（依赖现代化，分步低风险）：**
1. 先升 `uuid@9→11`（API 基本兼容，`v4()` 用法不变），跑全套测试。
2. 评估 `zod@3→4` 破坏性变更（尤其 `zodToJsonSchema.ts` 的 `_def` 访问、`.describe()`、schema 推断）；若成本可控则升级并改用 `z.toJSONSchema`（顺带闭合 Q5）；若破坏面过大则**保持 zod@3 并在本 Spec 记录锁定理由**，登记为独立 backlog。
3. 同步 `@types/uuid` 版本；`highlight.js` 类型（原 D2）一并核对。

**验证：** `npm run typecheck` + `npm test` 全绿；`npm ls uuid zod` 版本符合预期；JSON Schema 生成输出与升级前逐工具对比无回归。

**Files:** MODIFY `package.json`、`package-lock.json`；条件 MODIFY `src/utils/zodToJsonSchema.ts`（若升 zod4）。

#### 3.3.3 T6 — Medium/Low 残项定向复核（治理 · L1）🟢

**Problem:** 原报告 S5（危险命令正则可绕过）、Q3（多处静默吞错）、Q4（FileEditTool 错误处理）、Q5（Zod `as any`）、P3（每子 Agent 独立 ToolExecutor 抵消并发上限）、P5（全量对话常驻内存）、P6（压缩额外 LLM 调用）、P7（每请求重序列化）尚未逐行复核。

**Solution（治理 · 只读复核 + 归档）：**
1. 逐项定向核实当前源码状态，标注 ✅已修复 / ⚠️部分 / ❌未修复。
2. 已修复者在本 Spec 1.1 表补录证据；未修复者登记为结构化 backlog（编号 + 位置 + 建议 + 优先级），供下一轮 Spec 立项。
3. 重点确认 P3（`ToolExecutor` 是否复用全局并发信号量）与 S5（`commandNormalizer` 是否已覆盖变量展开/base64/引号变体）。

**验证：** 产出复核结论清单（追加至本 Spec 第 6 节或独立 memory）；每项有明确状态与证据行号。

**Files:** 只读复核；产出更新 `docs/specs/architecture-hardening-spec.md`（第 6 节）与 `.workbuddy/memory/`。

---

## 4. Impacted File List

| 文件 | 涉及任务 | 变更类型 |
|---|---|---|
| `src/bootstrap/state.ts` | T1 | MODIFY（深拷贝 + 移除 `_fallbackState`） |
| `src/bootstrap/Bootstrap.ts` | T1,T3 | MODIFY（根状态 ALS 包裹 + 注入 enforcer） |
| `src/query/QueryEngine.ts` | T1,T2,T3 | MODIFY（restoreSession + 预算检查/记账 + ALS） |
| `src/query/QueryEngineState.ts` | T2 | 关联（token 计数复位） |
| `src/query/QueryEngineCompaction.ts` | T2 | 关联（压缩游标复位） |
| `src/orchestrator/backends/in-process.ts` | T1 | 关联（子 Agent 生成走隔离状态） |
| `src/ui/components/AppRoot.tsx` | T2 | MODIFY（`:583` 改调 `restoreSession`） |
| `src/services/budget.ts` | T3 | 关联（消费 BudgetEnforcer） |
| `src/bootstrap/config.ts` | T3 | MODIFY（预算配置项） |
| `src/ui/components/StatusBarView.tsx` | T3 | 可选 MODIFY（剩余预算展示） |
| `src/ui/components/ChatView.ts` | T4 | DELETE 渲染函数（保留类型） |
| `src/ui/components/Sidebar.ts` | T4 | DELETE `renderSidebar` |
| `test/ui/**` | T4 | MODIFY（迁移/移除死代码单测） |
| `package.json`,`package-lock.json` | T5 | MODIFY（uuid/zod 升级） |
| `src/utils/zodToJsonSchema.ts` | T5 | 条件 MODIFY（升 zod4 时） |

---

## 5. Implementation Progress Tracker

> 状态核对基准：本 Spec 创建于 2026-07-20；实现完成后回填 ✅ 与完成日期，附 `npm run typecheck` + `npm test` 通过证据。

| Task | 描述 | Phase | Priority | Status | 完成日期 |
|---|---|---|---|---|---|
| T1 | GlobalState 深隔离（H1） | 1 | P0 | ⏳ in_progress | — |
| T2 | 会话恢复走受控 API（H2） | 2 | P1 | ⬜ pending | — |
| T3 | BudgetEnforcer 接入主循环（H3） | 2 | P1 | ⬜ pending | — |
| T4 | 删除 @deprecated 字符串渲染器（M1） | 3 | P2 | ⬜ pending | — |
| T5 | 核心依赖升级 uuid/zod（M2） | 3 | P2 | ⬜ pending | — |
| T6 | Medium/Low 残项定向复核（L1） | 3 | P2 | ⬜ pending | — |

---

## 6. Verification & Test Plan

### 6.1 通用门禁
- `npm run typecheck` 无错误；`npm test` 全绿（`vitest.config.ts`）。
- 现有测试不回归；T1/T2/T3 新增针对性单测。

### 6.2 分任务验证要点
- **T1：** 子 Agent 修改 `config` 嵌套字段不影响父/兄弟；`grep _fallbackState` 归零；无 ALS 上下文时 `getState()` fail-fast。
- **T2：** 恢复后立即压缩无重复/错乱；`turnCount`/`model`/token 估算与快照一致；损坏快照被拒且当前会话完好。
- **T3：** 低预算下超限轮优雅终止并提示；`recordUsage` 累计正确；未设预算行为不变。
- **T4：** 无 `renderChatView`/`renderSidebar`/`renderChatMessage` 生产引用；`grep @deprecated src/ui` 归零。
- **T5：** `npm ls uuid zod` 版本符合预期；JSON Schema 生成逐工具对比无回归。
- **T6：** 产出结构化复核清单，每项有状态 + 证据行号。

### 6.3 回归范围
- 子 Agent 编排（`test/orchestrator/**`）、会话持久化（`test/services/**`、`test/state/**`）、查询引擎压缩（`test/query/**`）、UI 渲染（`test/ui/**`）四大回归面全跑。

---

## 7. Assumptions

- 预算配置项（`sessionTokenLimit`/`costLimit`）默认宽松或可关闭，未显式配置时不改变现有行为。
- zod@4 升级若破坏面过大，允许保留 zod@3 并记录锁定理由（T5 提供 fallback 决策）。
- 子 Agent 预算策略默认"各自独立计数"，如需"全局共享上限"在 T3 实现时以配置切换，不在本 Spec 范围内深化。
- 本轮不新增业务特性，仅关闭一致性/健壮性缺口。
