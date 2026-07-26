# kc-cli 记忆提取升级为 LLM 语义提取（混合两级 + 护栏）Task Breakdown

> Generated: 2026-07-24 | Based on `docs/specs/memory-llm-extraction-hardening-spec.md` v1.0
> Total Tasks: 7 | Phases: 3 | Source: 2026-07-24 对 memoryExtraction / extractionPrompts / memory integration / budget / error-classifier / config 的只读核查
> 改造范围：将启发式记忆提取升级为"混合两级（启发式门控 + LLM 精提取）"，**护栏先行、成本可控、失败可降级**

---

## Task Dependency Graph

```
Phase 1 (P0 — 护栏先行，未就绪不得接 LLM):
  T1 输出校验+脱敏护栏(R1,R2) ──┐
  T2 触发时机+成本闸门(R4)     ──┴──> T3 混合两级提取管线(G1,G2,R3)

Phase 2 (P1 — 混合提取管线):
  T3 混合两级提取管线 ──┬──> T4 语义去重(G3)
                       └──> T5 失败静默降级兜底

Phase 3 (P2 — 配置/置信度/测试):
  T6 配置化+置信度分级(G4)        [可并行，影响 T2/T3 默认值]
  T7 契约测试清单+遥测(Q1)  <── blockedBy T3,T5
```

依赖说明：
- **T1、T2** 是接入 LLM 的前置护栏与闸门：**T1、T2 共同阻塞 T3**（管线必须消费校验/脱敏产物、受预算闸门约束）。
- **T3** 提供两级管线骨架：**T3 阻塞 T4（去重接线）与 T5（降级接线）**。
- **T7** 的契约测试需管线与降级路径就位：**T3、T5 阻塞 T7**。
- **T6** 配置与置信度可并行推进，但其默认值（`enabled=false`、阈值）为 T2/T3 提供开关，建议早接。

---

## Phase 1: 护栏先行（P0）

### Task T1: Add output validation + secret redaction guard

- **Status:** `done`
- **Subject (imperative):** Add a deterministic guard that validates and redacts LLM extraction output before persistence
- **Subject (continuous):** Adding a deterministic guard that validates and redacts LLM extraction output before persistence
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.1.1（对应 R1, R2；GR1–GR3）
- **Dependencies:**
  - blockedBy: none
  - blocks: T3
- **Checklist:**
  - [ ] 新增 `memory-extraction-guard.ts`：`parseAndValidate(raw): MemoryEntry[]`，zod schema 校验 `name/description/type/content`，`type` ∈ `user|feedback|project|reference`
  - [ ] 非法条目（缺字段/未知 type/坏 YAML）**丢弃**并记 debug，绝不 throw；返回合法子集
  - [ ] `redactSecrets(content)`：复用 `RunTool/secrets.ts` 密钥模式 + `permissions/protectedPaths.ts` 路径正则；含密钥→拒绝该条，含路径→占位脱敏
  - [ ] 复用 `passesQualityCheck`（min length / code-only）+ 条数上限（`maxMemoriesPerType`）+ 单条 ≤ 2KB
  - [ ] 护栏为**纯函数、无副作用、确定性**（Q1 锚点）
  - [ ] 新增确定性单测（`test/services/memory-extraction-guard.test.ts`）：合法解析 / 非法丢弃 / 密钥拦截未落盘 / 体量上限（CT1–CT4）
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - NEW: `src/services/memory-extraction-guard.ts`
  - 关联: `src/tools/RunTool/secrets.ts`、`src/permissions/protectedPaths.ts`、`src/memory/protocol.ts`
  - NEW: `test/services/memory-extraction-guard.test.ts`

---

### Task T2: Add trigger timing + cost budget gate

- **Status:** `done`
- **Subject (imperative):** Gate the LLM extraction tier by high-value trigger timing and budget limits
- **Subject (continuous):** Gating the LLM extraction tier by high-value trigger timing and budget limits
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.1.2 + §4（对应 R4；GR6）
- **Dependencies:**
  - blockedBy: none
  - blocks: T3
- **Checklist:**
  - [ ] 新增 `shouldRunLlmExtraction(context, budget): {run, reason}`：仅反馈信号 / 空闲达 `idleThresholdMinutes` / consolidation 窗口放行；普通轮次不调 LLM
  - [ ] 接入 `budgetEnforcer`：调用前用 `subAgentTokenLimit`/`costLimitUsd`（`budget.ts:16-19,158-165`）预估校验，超限→跳过并记 reason
  - [ ] 去抖：同游标窗口 LLM 只提取一次；沿用 mutex（`state.inProgress`）与 trailing run（`pendingContext`）
  - [ ] 普通轮次仍每 `turnThrottle`（默认 3）跑启发式门控，零 LLM 成本
  - [ ] 契约单测：反馈信号→调用（CT5）；throttle 未到→不调用（CT6）；预算超限→跳过且 client 未被调用（CT7）
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - MODIFY: `src/services/memoryExtraction.ts`（`shouldRunLlmExtraction` + 触发接线）
  - 关联: `src/services/budget.ts`、`src/memory/protocol.ts`（`idleThresholdMinutes`）
  - （契约用例并入 `test/services/memory-llm-extraction.test.ts`，见 T7）

---

## Phase 2: 混合提取管线（P1）

### Task T3: Add hybrid two-tier extraction pipeline with forked isolation

- **Status:** `done`
- **Subject (imperative):** Add a two-tier (heuristic gate + isolated LLM) extraction pipeline without recursion
- **Subject (continuous):** Adding a two-tier (heuristic gate + isolated LLM) extraction pipeline without recursion
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.2.1（对应 G1, G2, R3；GR5）
- **Dependencies:**
  - blockedBy: T1, T2
  - blocks: T4, T5
- **Checklist:**
  - [ ] 门控层：保留现有正则 + `passesQualityCheck` + 哈希去重作为快速预筛（便宜、确定）
  - [ ] 精提取层：T2 放行后用 `buildExtractionPrompt(existingMemories)`（`extractionPrompts.ts` 已就绪）+ 游标窗口新消息，发起隔离轻量 API 调用
  - [ ] **隔离调用**经 `api/BaseApiClient` 直连，**不走完整 QueryEngine**，不注册 memory/post-turn hook，独立 `AbortController` + 超时（GR5）
  - [ ] LLM 产出经 **T1 护栏** `parseAndValidate` + `redactSecrets` 后合并；LLM 候选优先、启发式补充
  - [ ] 保留 `checkIfMainAgentWroteMemories`（主 Agent 已写则跳过）；游标/mutex/trailing 语义不变
  - [ ] 强化 `extractionPrompts.ts` 输出格式硬约束（严格 frontmatter），配合 T1 校验降低丢弃率
  - [ ] 契约单测：递归隔离——提取调用不触发自身 hook（调用计数=1，CT9）；LLM 未放行时等价现启发式
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - MODIFY: `src/services/memoryExtraction.ts`（两级管线）
  - MODIFY: `src/services/extractionPrompts.ts`（输出格式硬约束）
  - MODIFY: `src/memory/integration.ts`（`extractMemoriesFromConversation` 接线）
  - 关联: `src/api/index.ts`、`src/api/BaseApiClient.ts`（隔离调用）
  - （契约用例并入 `test/services/memory-llm-extraction.test.ts`）

---

### Task T4: Add semantic deduplication

- **Status:** `done`
- **Subject (imperative):** Add semantic deduplication so paraphrased memories are not stored twice
- **Subject (continuous):** Adding semantic deduplication so paraphrased memories are not stored twice
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.2.2（对应 G3；GR4）
- **Dependencies:**
  - blockedBy: T3
  - blocks: none
- **Checklist:**
  - [ ] 落盘前将候选与现有 manifest 描述做相似度比对，复用 `relevanceSearch.ts` 打分
  - [ ] 超过 `semanticDedupThreshold`（默认 0.85）判语义重复 → 跳过或更新既有 `updatedAt`
  - [ ] 保留 `hashContent` 精确去重为第一道过滤，语义去重为第二道
  - [ ] 契约单测：语义相似候选（mock 高分）被跳过（CT8）；不相关候选正常入库；阈值可配
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - MODIFY: `src/services/memoryExtraction.ts`（去重接线）
  - 关联: `src/memory/relevanceSearch.ts`、`src/memory/integration.ts`（`getMemoryManifest`）

---

### Task T5: Add silent degrade fallback on failure

- **Status:** `done`
- **Subject (imperative):** Ensure LLM extraction failures silently degrade to heuristic without blocking the main flow
- **Subject (continuous):** Ensuring LLM extraction failures silently degrade to heuristic without blocking the main flow
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.2.3（对应 GR7）
- **Dependencies:**
  - blockedBy: T3
  - blocks: none
- **Checklist:**
  - [ ] LLM 提取包裹错误边界：异常经 `classifyApiError`（`error-classifier.ts:63`）分类后**静默降级**到启发式候选
  - [ ] 无 API key / 无网络 / 超预算（T2）→ 直接走启发式
  - [ ] 连续失败达阈值 → **熔断** LLM 层至会话结束
  - [ ] 失败计数进遥测（T7）
  - [ ] 契约单测：client 抛限流/超时→回退启发式、主流程不抛错、错误被分类（CT10）；连续失败→熔断（CT11）
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - MODIFY: `src/services/memoryExtraction.ts`（错误边界 + 熔断）
  - 关联: `src/services/error-classifier.ts`（`classifyApiError` 复用）

---

## Phase 3: 配置、置信度与测试（P2）

### Task T6: Add configuration + confidence grading

- **Status:** `done`
- **Subject (imperative):** Add memory LLM-extraction configuration and confidence grading
- **Subject (continuous):** Adding memory LLM-extraction configuration and confidence grading
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.3.1（对应 G4；GR8）
- **Dependencies:**
  - blockedBy: none
  - blocks: none
- **Checklist:**
  - [ ] `config.ts` `memory` 节新增：`llmExtraction.enabled`（默认 `false`）、`llmExtractionModel?`、`semanticDedupThreshold`（默认 0.85）、`llmTriggerOnFeedbackSignal`（默认 true）、`maxExtractionCostUsdPerSession?`
  - [ ] `MemoryConfig`（`memory/protocol.ts:107-138`）+ `DEFAULT_MEMORY_CONFIG` 同步扩展
  - [ ] env 覆盖（`KC_MEMORY_LLM_EXTRACTION` 等）走 `loadEnvConfig` 校验（`config.ts:256-408`），非法值丢弃（沿用 QUAL-04）
  - [ ] 置信度规则：LLM + 通过 T1 校验 + 通过 T4 去重 → `high`；否则 `low`
  - [ ] 契约单测：开关默认关闭 → 无 LLM 调用（CT14）；env 覆盖生效且非法丢弃；置信度分级（CT12）
  - [ ] `npm run typecheck` 通过；`npm test` 通过
- **Files:**
  - MODIFY: `src/bootstrap/config.ts`（`memory.llmExtraction` schema + env）
  - MODIFY: `src/memory/protocol.ts`（`MemoryConfig` + 默认值）
  - 关联: `src/services/memoryExtraction.ts`（读配置）

---

### Task T7: Add contract test suite + telemetry

- **Status:** `done`
- **Subject (imperative):** Add a mock-client contract test suite and extraction telemetry
- **Subject (continuous):** Adding a mock-client contract test suite and extraction telemetry
- **Spec:** `docs/specs/memory-llm-extraction-hardening-spec.md` Section 3.3.2 + §6（对应 Q1）
- **Dependencies:**
  - blockedBy: T3, T5
  - blocks: none
- **Checklist:**
  - [ ] 用可注入 mock LLM client 编写契约测试，覆盖 CT1–CT14，**断言行为契约不断言文案**
  - [ ] 确定性：固定 mock 输出 → 结果可重复（CT13），CI 稳定
  - [ ] 扩展 `memory/telemetry.ts`：`llmExtractionCalls / heuristicFallbacks / memoriesFromLlm / redactedSecrets / dedupSkipped / estimatedCostUsd / circuitBroken`
  - [ ] `memoryExtraction.ts` 暴露依赖注入点（client/budget/now）便于 mock
  - [ ] `npm run typecheck` 通过；`npm test` 全绿（新增契约套件 + 现有确定性启发式单测无回归）
- **Files:**
  - NEW: `test/services/memory-llm-extraction.test.ts`（CT1–CT14）
  - MODIFY: `src/memory/telemetry.ts`（遥测字段）
  - 关联: `src/services/memoryExtraction.ts`（依赖注入点）

---

## Progress Summary

> **全部任务实现完成 2026-07-25。** 证据：`npm run typecheck` 干净通过；记忆 + api 套件 `npx vitest run test/memory test/services/memory-*.test.ts test/api` = **647/649 通过**；新增契约测试 `memory-extraction-guard.test.ts`（18，CT1–CT4）+ `memory-llm-extraction.test.ts`（21，CT5–CT14）= **39/39 通过**。剩余 2 个失败为 Windows 路径分隔符（`\` vs `/`）预存在问题，本次未触及 `paths.ts`/`FileMemoryService.ts`，在 CI 的 `ubuntu-latest` 上通过。`llmExtraction.enabled` 默认 `false`，零回归。

| Task | Priority | Status | blockedBy | blocks |
|---|---|---|---|---|
| T1 输出校验+脱敏护栏 | P0 | `done` | — | T3 |
| T2 触发时机+成本闸门 | P0 | `done` | — | T3 |
| T3 混合两级提取管线+隔离 | P1 | `done` | T1, T2 | T4, T5 |
| T4 语义去重 | P1 | `done` | T3 | — |
| T5 失败静默降级兜底 | P1 | `done` | T3 | — |
| T6 配置化+置信度分级 | P2 | `done` | — | — |
| T7 契约测试清单+遥测 | P2 | `done` | T3, T5 | — |

> **后续完善（2026-07-25，验证后补齐）：**
> - **T6 补漏**：`maxExtractionCostUsdPerSession` 会话级成本闸门在 `shouldRunLlmExtraction` 落地（此前仅定义未执行），`session_cost_exceeded` reason + 4 个新契约用例。
> - **T3 补接线**：`QueryEngine` 构造函数默认注入 `apiClient` + `budgetEnforcer` 到 `MemoryIntegration`（显式值优先）；`Bootstrap.ts`×2 与 `acp/handlers.ts` 补接 `memory: { config: config.memory }`，开启开关即可生效。新增 `test/query/memory-wiring.test.ts`（4 用例）。
> 证据：typecheck 干净；契约套件 guard(18)+llm(25)+wiring(4)=**47/47**；大范围套件 993/1053，失败均为 Windows 环境预存在问题（对照还原基线确认与改动无关）。

> 进度维护约定：始终保持至少一个任务 `in_progress`。建议顺序：T1 → T2（护栏与闸门先行）→ T3（解锁链起点）→ T4/T5 并行 → T6（可提前接开关）→ T7 收尾。护栏（T1/T2）未 `done` 前，**不得开启 `llmExtraction.enabled`**。
