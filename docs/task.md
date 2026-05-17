# KC-CLI v3.1 / v4 Task Breakdown

> **项目**: KC-CLI 持续改进
> **版本**: 1.0
> **创建日期**: 2026-05-17
> **关联文档**: [REVIEW-REPORT.md](../REVIEW-REPORT.md) | [docs/v3-tasks.md](v3-tasks.md)
> **前置依赖**: v3.0.0（已发布，TASK-021 ~ TASK-032 全部完成）
> **当前健康评分**: 8.0/10（见 REVIEW-REPORT.md §10.7）

---

## 概述

v3.0.0 发布后，REVIEW-REPORT.md 遗留了 5 项待办（§10.8）。本任务分解覆盖这些遗留项，并结合竞品分析（`docs/competitive-analysis.md`）和 SWE-bench 评估（`docs/swe-bench-guide.md`）规划下一阶段改进方向。

---

## Phase 1: 类型安全 + 代码质量 (P0/P1)

### TASK-033: 消除剩余 `as any` 类型断言

**Status**: pending
**Priority**: P1
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Eliminate remaining `as any` type assertions to improve type safety
- Present Continuous: Eliminating remaining `as any` type assertions to improve type safety

**背景**: v3 修复后从 53 处降至 23 处。目标降至 <10 处。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 审计剩余 23 处 `as any`，分类：可消除 vs 必要保留
- [ ] `in-process.ts`（7 处）: 用类型守卫替代 AgentEvent 判别访问
- [ ] `acp/handlers.ts`（已有改进）: 验证剩余断言，定义专用接口
- [ ] `AnthropicClient.ts`（3 处）: content 数组操作添加类型窄化
- [ ] `bootstrap/config.ts`（4 处）: deepMerge 递归使用泛型约束
- [ ] 其他零散文件: 逐个处理
- [ ] 确保 `tsc --noEmit` 无错误
- [ ] 运行全量测试通过

---

### TASK-034: 拆分 App.ts 大文件

**Status**: pending
**Priority**: P2
**Phase**: Phase 1
**预估工时**: 1.5d

**任务描述**:
- Imperative: Split the 999-line App.ts into smaller, focused components
- Present Continuous: Splitting the 999-line App.ts into smaller, focused components

**背景**: `src/ui/components/App.ts` 999 行，职责过重。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 分析 App.ts 职责边界（渲染、事件处理、状态管理、工具栏）
- [ ] 提取 `MessageList.ts` — 消息渲染和虚拟滚动
- [ ] 提取 `InputArea.ts` — 输入框和补全
- [ ] 提取 `StatusBar.ts` — 底部状态栏
- [ ] 提取 `Toolbar.ts` — 顶部工具栏
- [ ] App.ts 保留组合逻辑和顶层状态，目标 < 300 行
- [ ] 确保 UI 集成测试 (`test/ui/app-integration.test.ts`) 仍通过
- [ ] 运行 typecheck + build 无错误

---

### TASK-035: 清理 executingPhase 空权限数组

**Status**: pending
**Priority**: P2
**Phase**: Phase 1
**预估工时**: 0.5d

**任务描述**:
- Imperative: Remove empty permission arrays in QueryEngine.executingPhase()
- Present Continuous: Removing empty permission arrays in QueryEngine.executingPhase()

**背景**: `QueryEngine.ts` 的 `executingPhase()` 中 `PermissionContext` 权限数组始终为空（`alwaysDenyRules: []`, `alwaysAskRules: []`, `alwaysAllowRules: []`），实际权限检查走 `this.permissionConfig`，空数组是代码异味。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 理清双路径设计：`PermissionContext` vs `this.permissionConfig`
- [ ] 决策：统一为单一路径，或移除空数组并添加文档注释
- [ ] 更新相关测试验证权限行为不变
- [ ] 运行 `test/QueryEngine.test.ts` 通过

---

## Phase 2: 测试覆盖深化 (P1)

### TASK-036: config.ts 测试覆盖

**Status**: pending
**Priority**: P2
**Phase**: Phase 2
**预估工时**: 1.5d

**任务描述**:
- Imperative: Add test coverage for the config loading system
- Present Continuous: Adding test coverage for the config loading system

**背景**: `src/bootstrap/config.ts` 当前无测试（需 mock 文件系统）。配置系统是 4 层优先级（defaults < user < project < env），Zod 验证，深合并 — 必须有测试保障。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 使用 `vi.mock('fs')` 或 `memfs` mock 文件系统
- [ ] 测试 4 层配置优先级覆盖
- [ ] 测试 Zod schema 验证（有效/无效配置）
- [ ] 测试深合并逻辑（嵌套对象、数组覆盖）
- [ ] 测试环境变量 `KC_*` 覆盖
- [ ] 测试配置加载失败降级
- [ ] 覆盖率目标: config.ts > 80%

---

### TASK-037: orchestrator 测试继续深化

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Deepen test coverage for agent orchestrator and in-process backend
- Present Continuous: Deepening test coverage for agent orchestrator and in-process backend

**背景**: `agent-orchestrator.ts` (63.27%) 和 `in-process.ts` 已有改进，但核心流程（spawn、batch、waitForCompletion、cancel、error propagation）仍需更多边界测试。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] `agent-orchestrator.ts`: spawn 子 agent 错误传播测试
- [ ] `agent-orchestrator.ts`: batch 并发执行 + 部分失败测试
- [ ] `agent-orchestrator.ts`: cancel 中途取消 + 资源清理测试
- [ ] `agent-orchestrator.ts`: shutdownAll 优雅关闭测试
- [ ] `in-process.ts`: 子进程崩溃恢复测试
- [ ] `in-process.ts`: 超时处理测试
- [ ] 覆盖率目标: orchestrator 模块 > 75%

---

### TASK-038: memoryConsolidation 测试补全

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Complete test coverage for memory consolidation service
- Present Continuous: Completing test coverage for memory consolidation service

**背景**: `services/memoryConsolidation.ts` 当前 58.59%，已从 5.42% 大幅提升，但合并策略、冲突解决、过期清理等边界场景仍需覆盖。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 测试合并策略：相同 key 不同来源的优先级
- [ ] 测试冲突解决：时间戳、显式覆盖
- [ ] 测试过期记忆清理
- [ ] 测试大量记忆合并性能
- [ ] 覆盖率目标: > 80%

---

## Phase 3: 安全加固 (P2/P3)

### TASK-039: 补充受保护路径

**Status**: pending
**Priority**: P3
**Phase**: Phase 3
**预估工时**: 0.5d

**任务描述**:
- Imperative: Add additional protected paths for cloud credentials
- Present Continuous: Adding additional protected paths for cloud credentials

**背景**: REVIEW-REPORT.md §5.2 提到缺少 `~/.aws/`, `~/.kube/config`, `~/.docker/config.json`, `~/.config/gcloud/` 的保护。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 在 `src/permissions/rules.ts` 的 `PROTECTED_PATHS` 中添加:
  - `~/.aws/` (AWS credentials)
  - `~/.kube/config` (Kubernetes config)
  - `~/.docker/config.json` (Docker auth)
  - `~/.config/gcloud/` (GCP credentials)
  - `~/.ssh/` (SSH keys, 如未覆盖)
- [ ] 编写测试验证这些路径的写入/删除被拦截
- [ ] 运行 `test/permissions/` 测试通过

---

### TASK-040: SqlTool dbCache 大小限制

**Status**: pending
**Priority**: P2
**Phase**: Phase 3
**预估工时**: 0.5d

**任务描述**:
- Imperative: Add LRU eviction or size limit to SqlTool's database connection cache
- Present Continuous: Adding LRU eviction or size limit to SqlTool's database connection cache

**背景**: `SqlTool` 的 `dbCache` 无大小限制，长时间运行可能积累过多连接。

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 为 `dbCache` 添加最大条目数限制（默认 10）
- [ ] 实现 LRU 淘汰策略或简单 FIFO
- [ ] 添加 cache stats 到 verbose 日志
- [ ] 编写测试验证缓存淘汰行为

---

## Phase 4: 评估与发布 (P1)

### TASK-041: SWE-bench 评估适配

**Status**: pending
**Priority**: P1
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Set up SWE-bench evaluation adapter for benchmarking KC-CLI
- Present Continuous: Setting up SWE-bench evaluation adapter for benchmarking KC-CLI

**背景**: `docs/swe-bench-guide.md` 已编写提交指南。需要适配评估框架，验证 KC-CLI 在标准基准上的表现。

**Dependencies**:
- `blockedBy`: [TASK-033]
- `blocks`: []

**Checklist**:
- [ ] 实现 SWE-bench evaluation adapter（`evaluation/` 目录已有基础）
- [ ] 验证 adapter 在 SWE-bench Verified 子集上可运行
- [ ] 记录基线分数
- [ ] 优化 prompt 提升通过率
- [ ] 编写 CI job 自动运行评估

---

### TASK-042: v3.1 发布准备

**Status**: pending
**Priority**: P1
**Phase**: Phase 4
**预估工时**: 1d

**任务描述**:
- Imperative: Prepare v3.1 release with all fixes and improvements
- Present Continuous: Preparing v3.1 release with all fixes and improvements

**Dependencies**:
- `blockedBy`: [TASK-033 ~ TASK-041]
- `blocks`: []

**Checklist**:
- [ ] 更新 `package.json` version → 3.1.0
- [ ] 编写 CHANGELOG v3.1.0 条目
- [ ] 更新 `docs/architecture.md` 反映变更
- [ ] 运行 `tsc --noEmit` + `npm run build` + `npm run test:ci` 全部通过
- [ ] 覆盖率阈值确认达标（lines 60%+, branches 50%+, statements 60%+, functions 60%+）
- [ ] `as any` 数量确认 < 10
- [ ] 创建 Git tag `v3.1.0`

---

## 任务依赖图

```
Phase 1 (类型安全):
  TASK-033 (as any) ─────────────────────────────┐
  TASK-034 (App.ts 拆分) ────────────────────────┤
  TASK-035 (空权限数组) ─────────────────────────┤
                                                  │
Phase 2 (测试覆盖):                               │
  TASK-036 (config 测试) ────────────────────────┤
  TASK-037 (orchestrator 测试) ──────────────────┤
  TASK-038 (memoryConsolidation 测试) ───────────┤
                                                  │
Phase 3 (安全加固):                               │
  TASK-039 (受保护路径) ─────────────────────────┤
  TASK-040 (dbCache 限制) ───────────────────────┤
                                                  │
Phase 4 (评估与发布):                             │
  TASK-041 (SWE-bench) ←── TASK-033 ─────────────┤
  TASK-042 (v3.1 发布) ←── TASK-033~041 ─────────┘
```

---

## 状态追踪

| Status | Count | Tasks |
|--------|-------|-------|
| ✅ completed | 0 | — |
| 🔄 in_progress | 0 | — |
| ⏳ pending | 10 | TASK-033 ~ TASK-042 |
| 🚫 blocked | 0 | — |

**总预估工时**: ~13 天（2.5 周）

---

## 优先级排序

| 优先级 | 任务 | 理由 |
|--------|------|------|
| **P0** | TASK-033 | 类型安全是代码质量基础，`as any` 阻碍重构信心 |
| **P1** | TASK-037, TASK-038, TASK-041, TASK-042 | 测试深化 + SWE-bench 评估 + 发布 |
| **P2** | TASK-034, TASK-035, TASK-036, TASK-040 | 代码组织 + 测试补充 |
| **P3** | TASK-039 | 安全增强，当前覆盖已足够基本场景 |
