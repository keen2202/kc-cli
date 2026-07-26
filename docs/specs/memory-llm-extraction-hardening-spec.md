# kc-cli 记忆提取升级为 LLM 语义提取（混合两级 + 护栏）Spec

> 基于 2026-07-24 对 `src/services/memoryExtraction.ts`、`src/services/extractionPrompts.ts`、`src/memory/integration.ts`、`src/memory/relevanceSearch.ts`、`src/services/budget.ts`、`src/hooks/postTurnHooks.ts`、`src/services/error-classifier.ts`、`src/bootstrap/config.ts` 的只读核查编制
> Generated: 2026-07-24 | Version: 1.0 | Scope: `src/services/memory*`、`src/memory/**`、`src/hooks/postTurnHooks.ts`、`src/bootstrap/config.ts`
> 原则基线：**默认安全 · 成本可控 · 可降级 · 可验证 · 可追溯** —— 不破坏现有确定性测试文化，不阻塞主任务热路径，护栏先行

---

## 1. Executive Summary

kc-cli 现有经验沉淀主体是"运行时记忆系统"，但**自动提取仍是启发式正则实现**（`memoryExtraction.ts:238-389`，注释明示 "In the full implementation, this would use a forked LLM agent. For now, we implement a heuristic-based extraction"），仅能捕获 `i prefer… / don't… / we decided…` 等固定句式，自动记忆统一标 `confidence:'low'`。同时 **LLM 提取的提示词脚手架已就绪**（`extractionPrompts.ts:6-62` 的 `buildExtractionPrompt` 已 import 但未接入 LLM），**子代理预算控制已存在**（`budget.ts:16-19` `subAgentTokenLimit`/`costLimitUsd`）。

本 Spec 立项将启发式提取升级为**混合两级（启发式门控 + LLM 精提取）**，核心约束是：**先补护栏（输出校验/脱敏/递归隔离/成本闸门），再接 LLM**；LLM 层仅在高价值时机触发，失败静默降级回启发式。

- **P0（2）：** 输出校验 + 脱敏护栏层、触发时机与成本预算闸门 —— 未就绪前不得接入 LLM。
- **P1（3）：** 混合两级提取管线（forked 隔离）、语义去重、失败静默降级兜底。
- **P2（2）：** 配置化 + 置信度分级、契约测试清单 + 遥测扩展。
- **Risk Profile:** Phase 1（Low，纯新增护栏与闸门，不改主路径）/ Phase 2（Medium，触及提取管线与外发数据面）/ Phase 3（Low，配置与测试增量）。
- **Total Estimated Effort:** 约 4–5 天。

### 1.1 核查证据对照（供追溯）

| 维度 | 评级 | 关键证据 |
|---|---|---|
| 记忆结构与持久化 | ✅ 强（不整改） | 4 类记忆 + YAML frontmatter（`memory/protocol.ts:9-32`）；`FileMemoryService` 抽象落盘 |
| 检索回注 | ✅ 强（不整改） | `loadRelevantMemories` 相关性检索注入 system prompt（`integration.ts:48-87`）；`relevanceSearch.ts` |
| 节流/去重/并发 | ✅ 良（复用） | 游标 `lastExtractionCursor` + 每 3 轮 + 互斥锁 + trailing run（`memoryExtraction.ts:118-203`）；SHA-256 哈希去重（`:44-91`） |
| **提取召回率** | ⚠️ **中等** | 仅固定正则句式（`memoryExtraction.ts:276-360`），隐性/跨句/非模板经验漏提 |
| **提取分类** | ⚠️ **中等** | 模式→类型硬映射（preference→user、decision→project），无语义判别 |
| **置信度** | ⚠️ **中-弱** | 自动记忆统一 `confidence:'low'`（`memoryExtraction.ts:299,338,378`），检索不敢用 |
| **语义去重** | ⚠️ **中等** | 仅精确哈希（`hashContent`，`:44-46`），换措辞即重复沉淀，记忆膨胀 |
| LLM 接入前置件 | 🟡 部分就绪 | prompt 已写好未接线（`extractionPrompts.ts` ↔ `memoryExtraction.ts:10` import 未用）；预算已备（`budget.ts:16-19`） |

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

现有缺口（G）与"接入 LLM 后新引入、必须护栏的风险"（R）、可测试性（Q）：

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| G1 | 启发式召回率低 | 提取能力 | 仅抓固定正则句式（`memoryExtraction.ts:276-360`） | LLM 语义提取，捕获隐性/跨句/非模板经验 |
| G2 | 分类硬映射易错 | 提取质量 | 模式→类型一一硬映射 | LLM 按 4 类语义判别分类，`feedback` 结构化为 rule→Why→How |
| G3 | 精确哈希去重无法识别语义重复 | 数据健康 | `hashContent` 仅精确匹配（`:44-46`） | 语义相似度去重，复用 `relevanceSearch` 打分避免膨胀 |
| G4 | 自动记忆置信度统一 low | 可用性 | `confidence:'low'` 恒定 | 通过校验+去重的 LLM 记忆可标 `high`，检索敢用 |
| R1 | LLM 输出无校验（幻觉/非法 frontmatter/误分类） | 安全/正确性 | 无——启发式产物结构天然可控 | zod 严格 schema 校验，非法产物**丢弃不落盘**，绝不抛错阻塞 |
| R2 | 敏感信息落盘风险 | 隐私/安全 | 无——启发式仅截取受限句式 | 落盘前脱敏过滤（复用 `RunTool/secrets.ts` + `protectedPaths` 思路），命中即拒绝/脱敏 |
| R3 | 提取代理递归触发自身 hook | 健壮性 | 无——启发式无 LLM 调用 | 提取走**隔离轻量调用**（关闭 memory hook），独立 abort/timeout，杜绝递归 |
| R4 | LLM 调用成本/延迟失控 | 成本/性能 | 无——启发式零成本 | 触发闸门 + `budgetEnforcer` 预算校验，超限即跳过并回退启发式 |
| Q1 | 非确定性破坏现有确定性单测 | 可测试性 | 36+ 确定性正则断言 | LLM 层以 **mock client 契约测试** 覆盖（断言 schema/脱敏/降级/触发，不断言具体文案） |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 输出校验 + 脱敏护栏层（R1, R2） | 1 | High | 1d | Low |
| P0 | T2 触发时机与成本预算闸门（R4） | 1 | High | 0.5d | Low |
| P1 | T3 混合两级提取管线 + forked 隔离（G1, G2, R3） | 2 | High | 1.5d | Medium |
| P1 | T4 语义去重（G3） | 2 | Medium | 0.5d | Low |
| P1 | T5 失败静默降级兜底（error-classifier 集成） | 2 | Medium | 0.5d | Low |
| P2 | T6 配置化 + 置信度分级（G4） | 3 | Medium | 0.5d | Low |
| P2 | T7 契约测试清单 + 遥测扩展（Q1） | 3 | Medium | 0.5d | Low |

---

## 3. Detailed Fix Proposals

### 3.1 Phase 1 — 护栏先行（P0，未就绪不得接 LLM）

#### 3.1.1 T1 — LLM 提取输出校验 + 脱敏护栏层（安全性增强 · R1, R2）🔴

**Problem:** 启发式产物结构天然受控；一旦接入 LLM，输出可能幻觉、产出非法 frontmatter、误分类，或**把密钥/密码/token 等敏感信息写入记忆文件**（记忆会被回注 system prompt 并跨会话持久化，风险放大）。当前无任何输出校验或脱敏层。

**Solution（护栏，纯新增，不改主路径）：**
1. 新增 `memory-extraction-guard.ts`，提供 `parseAndValidate(raw): MemoryEntry[]`：用 **zod schema** 解析 LLM 产出的 frontmatter 块（`name/description/type/content`），`type` 必须 ∈ `user|feedback|project|reference`，非法条目**丢弃**（记 debug，绝不 throw）。
2. `redactSecrets(content): {content, hadSecret}`：复用 `RunTool/secrets.ts` 的密钥模式 + `permissions/protectedPaths.ts` 的受保护路径正则，命中密钥/token/密码则**拒绝该条记忆**，命中路径则脱敏占位。
3. 复用现有 `passesQualityCheck`（最小长度、code-only 过滤，`memoryExtraction.ts:51-67`）与条数/长度上限（默认单次 ≤ `maxMemoriesPerType`，单条 ≤ 2KB，超出截断/丢弃）。
4. 护栏为**纯函数、无副作用、确定性**，独立可测（Q1 的确定性单测锚点）。

**验证：** 合法产出 → 解析为 `MemoryEntry[]`；非法 frontmatter/未知 type → 丢弃不抛错；含密钥的产出 → 拒绝且不落盘；超长/纯代码 → 过滤。

**Files:** NEW `src/services/memory-extraction-guard.ts`；关联 `src/tools/RunTool/secrets.ts`、`src/permissions/protectedPaths.ts`（复用脱敏模式）；关联 `src/memory/protocol.ts`（`MemoryEntry` 类型）。

#### 3.1.2 T2 — 触发时机与成本预算闸门（成本/性能 · R4）🔴

**Problem:** 启发式每 3 轮触发零成本；LLM 层若沿用"每 3 轮"会导致 token 成本随会话线性膨胀、延迟上升。需明确"何时才值得调 LLM"并接入预算硬闸门。

**Solution（触发闸门，详见 §4 触发时机设计）：**
1. 新增 `shouldRunLlmExtraction(context, budget): {run, reason}`：仅在下列高价值时机放行 LLM 层——(a) 检出明确反馈信号（用户纠正/"记住"/"don't" 等高信号）立即候选；(b) 会话空闲达 `idleThresholdMinutes`（批量提取积压窗口）；(c) consolidation 窗口。普通轮次**只跑启发式门控，不调 LLM**。
2. 接入 `budgetEnforcer`：调用前用 `subAgentTokenLimit`/`costLimitUsd`（`budget.ts:16-19,158-165`）预估校验，超限 → 跳过 LLM 并记 reason，回退启发式（T5）。
3. 去抖：同一游标窗口内 LLM 只提取一次；沿用现有 mutex（`state.inProgress`）与 trailing run。

**验证：** 反馈信号 → LLM 层被调用；普通轮次 throttle 下不调用；预算超限 → 跳过并回退；同窗口不重复调用。

**Files:** MODIFY `src/services/memoryExtraction.ts`（`shouldRunLlmExtraction` + 触发接线）；关联 `src/services/budget.ts`（预算查询）、`src/memory/protocol.ts`（`idleThresholdMinutes` 已有）。

---

### 3.2 Phase 2 — 混合两级提取管线（P1）

#### 3.2.1 T3 — 混合两级提取管线 + forked 隔离（架构优化 · G1, G2, R3）🔴

**Problem:** 需在不破坏现有节流/去重/并发骨架的前提下，把 LLM 精提取接入，且**杜绝提取代理递归触发自身 post-turn hook**。`extractMemoriesFromMessages`（`:238-269`）目前纯启发式。

**Solution（混合两级 + 隔离）：**
1. **门控层（启发式，保留）：** 现有正则 + `passesQualityCheck` + 哈希去重作为快速预筛（便宜、确定），产出 baseline 候选。
2. **精提取层（LLM，新增）：** 由 T2 闸门放行后，用 `buildExtractionPrompt(existingMemories)`（`extractionPrompts.ts` 已就绪）+ 游标窗口新消息，发起**隔离轻量 API 调用**（直接经 `api/BaseApiClient`，**不走完整 QueryEngine**，不注册 memory/post-turn hook，独立 `AbortController` + 超时），产出经 **T1 护栏**校验+脱敏后合并。
3. **递归隔离（R3）：** 提取调用显式关闭记忆钩子；`checkIfMainAgentWroteMemories`（`:211-231`）保留，避免与主 Agent 主动写入重复。
4. **合并策略：** LLM 候选优先，启发式候选补充；同名/语义重复交 T4 去重。

**验证：** 隐性经验（无固定句式）被 LLM 提取；分类符合语义；提取调用不触发自身 hook（无递归）；LLM 未放行时行为等价现启发式；游标/mutex/trailing 语义不变。

**Files:** MODIFY `src/services/memoryExtraction.ts`（两级管线）、`src/services/extractionPrompts.ts`（强化输出格式硬约束以配合 T1 校验）；关联 `src/api/index.ts`/`src/api/BaseApiClient.ts`（隔离调用）、`src/memory/integration.ts`（`extractMemoriesFromConversation` 接线）。

#### 3.2.2 T4 — 语义去重（数据健康 · G3）🟡

**Problem:** `hashContent`（`:44-46`）仅精确哈希，"同义不同词"的记忆会重复沉淀，检索质量随膨胀下降。

**Solution：**
1. 落盘前将候选与现有 manifest 描述做相似度比对，**复用 `relevanceSearch.ts` 的打分**（词元重叠/TF-IDF 类），超过阈值（默认 0.85，可配）判为语义重复 → 跳过或更新既有条目 `updatedAt`。
2. 保留哈希去重为第一道快速过滤；语义去重为第二道。

**验证：** 语义近似（换措辞）候选被跳过；不相关候选正常入库；阈值可配；哈希去重仍生效。

**Files:** MODIFY `src/services/memoryExtraction.ts`（去重接线）；关联 `src/memory/relevanceSearch.ts`（相似度打分复用）、`src/memory/integration.ts`（`getMemoryManifest` 已有）。

#### 3.2.3 T5 — 失败静默降级兜底（健壮性 · R1/R4 兜底）🟡

**Problem:** LLM 层引入网络/限流/超时/预算等失败模式，**绝不能阻塞主任务或抛错**。

**Solution：**
1. LLM 提取全程包裹错误边界：任何异常经 `classifyApiError`（`error-classifier.ts:63`）分类后**静默降级**到启发式候选，主流程无感知。
2. 无 API key/无网络/超预算（T2）→ 直接走启发式路径。
3. 失败计数进遥测（T7），连续失败达阈值时**熔断** LLM 层至会话结束（避免反复无效调用）。

**验证：** LLM client 抛错（限流/超时）→ 回退启发式，主流程不受影响且错误被分类；无 key → 启发式；连续失败 → 熔断。

**Files:** MODIFY `src/services/memoryExtraction.ts`（错误边界 + 熔断）；关联 `src/services/error-classifier.ts`（分类复用）。

---

### 3.3 Phase 3 — 配置、置信度与测试（P2）

#### 3.3.1 T6 — 配置化 + 置信度分级（可用性 · G4）🟢

**Problem:** LLM 提取需可开关、可调参；通过校验+去重的高质量记忆应可标 `high` 以被检索优先采用。

**Solution：**
1. `config.ts` 的 `memory` 节新增：`llmExtraction`（`enabled` 默认 `false`，灰度开启）、`llmExtractionModel?`（默认复用主模型）、`semanticDedupThreshold`（默认 0.85）、`llmTriggerOnFeedbackSignal`（默认 true）、`maxExtractionCostUsdPerSession?`。
2. `MemoryConfig`（`memory/protocol.ts:107-138`）与 `DEFAULT_MEMORY_CONFIG` 同步扩展，env 覆盖（`KC_MEMORY_LLM_EXTRACTION` 等）走现有 `loadEnvConfig` 校验模式（`config.ts:256-408`）。
3. 置信度规则：LLM 提取 + 通过 T1 校验 + 通过 T4 去重 → `high`；启发式或校验降级 → `low`。

**验证：** 开关默认关闭（零行为变更）；开启后 LLM 层生效；env 覆盖生效且非法值被丢弃；置信度按规则标注。

**Files:** MODIFY `src/bootstrap/config.ts`（`memory` schema + env）、`src/memory/protocol.ts`（`MemoryConfig` + 默认值）；关联 `src/services/memoryExtraction.ts`（读配置）。

#### 3.3.2 T7 — 契约测试清单 + 遥测扩展（可测试性 · Q1）🟢

**Problem:** LLM 输出非确定，无法沿用现有确定性断言；需以 mock client 的**契约测试**锁定行为，并观测提取质量/成本。

**Solution：**
1. 用可注入的 mock LLM client 编写契约测试（详见 §6 契约测试清单）：断言 schema 合法、脱敏生效、触发时机、预算跳过、递归隔离、失败降级、置信度、确定性、no-op，**不断言具体文案**。
2. 扩展 `memory/telemetry.ts`：记录 `llmExtractionCalls / heuristicFallbacks / memoriesFromLlm / redactedSecrets / dedupSkipped / estimatedCostUsd / circuitBroken`。

**验证：** 契约测试全绿且确定性（CI 可重复）；遥测字段产出；`npm run typecheck` + `npm test` 通过。

**Files:** NEW `test/services/memory-extraction-guard.test.ts`、`test/services/memory-llm-extraction.test.ts`；MODIFY `src/memory/telemetry.ts`；关联 `src/services/memoryExtraction.ts`（依赖注入点，便于 mock）。

---

## 4. 触发时机设计（Trigger Timing）

> 核心原则：**启发式门控每轮低成本运行；LLM 层仅在高价值时机触发**，并受预算硬闸门约束。

| 触发点 | 层级 | 条件 | 说明 |
|---|---|---|---|
| 常规轮次（post-turn hook） | 启发式门控 | `turnsSinceLastExtraction >= turnThrottle`（默认 3） | 保留现状，零成本预筛；**不调 LLM** |
| 反馈信号即时触发 | LLM 精提取 | 检出用户纠正 / "记住" / "don't/avoid" 等高信号 且 `llmTriggerOnFeedbackSignal` | 高价值经验即时沉淀；受预算闸门约束 |
| 会话空闲批量提取 | LLM 精提取 | 空闲达 `idleThresholdMinutes`（默认 5，`protocol.ts:129`） | 对游标积压窗口一次性 LLM 提取，摊薄调用次数 |
| Consolidation 窗口 | LLM 精提取 | `shouldRunConsolidation`（`integration.ts:138`）：会话数≥5 且间隔≥24h | 与巩固统一，语义合并去重 |
| 预算/降级 | — | `budgetEnforcer` 超 `subAgentTokenLimit`/`costLimitUsd`，或连续失败熔断 | **跳过 LLM，回退启发式**（T5） |

约束：沿用现有 **游标窗口**（仅新消息）、**mutex**（`state.inProgress`）、**trailing run**（`pendingContext`）、**主 Agent 已写记忆则跳过**（`checkIfMainAgentWroteMemories`）。

---

## 5. 护栏实现点（Guardrails）

| # | 护栏 | 实现点 | 失败行为 |
|---|---|---|---|
| GR1 | 输出 schema 校验 | T1 `parseAndValidate`（zod） | 非法条目丢弃，不抛错 |
| GR2 | 敏感信息脱敏 | T1 `redactSecrets`（复用 `RunTool/secrets.ts` + `protectedPaths`） | 含密钥→拒绝该条；含路径→占位脱敏 |
| GR3 | 质量与体量上限 | T1 复用 `passesQualityCheck` + 条数/长度上限 | 超限截断/过滤 |
| GR4 | 语义去重 | T4 复用 `relevanceSearch` 打分（阈值 0.85） | 重复→跳过或更新 `updatedAt` |
| GR5 | 递归隔离 | T3 隔离轻量 API 调用，关闭 memory/post-turn hook，独立 abort/timeout | 杜绝提取代理自触发 |
| GR6 | 成本预算闸门 | T2 接入 `budgetEnforcer`（`subAgentTokenLimit`/`costLimitUsd`） | 超限→跳过 LLM，回退启发式 |
| GR7 | 失败静默降级 | T5 错误边界 + `classifyApiError` + 熔断 | 任何异常→回退启发式，主流程无感 |
| GR8 | 置信度门槛 | T6：仅通过 GR1–GR4 的 LLM 记忆标 `high` | 否则 `low` |

---

## 6. 契约测试清单（Contract Tests）

> LLM 输出非确定，测试一律使用**可注入 mock client**，断言**行为契约**而非具体文案，确保 CI 可重复。

| # | 契约 | 断言要点 | 对应任务 |
|---|---|---|---|
| CT1 | 合法产出解析 | mock 返回合法 frontmatter → 解析为 `MemoryEntry[]`，type 正确 | T1 |
| CT2 | 非法产出丢弃 | 缺字段/未知 type/坏 YAML → 丢弃，不抛错，返回已解析的合法子集 | T1 |
| CT3 | 敏感信息拦截 | 产出含 API key/password/token → 该条被拒绝，**断言未落盘** | T1/GR2 |
| CT4 | 体量上限 | 超条数/超长/纯代码 → 截断或过滤 | T1/GR3 |
| CT5 | 触发—反馈信号 | 注入"记住/纠正"信号 → LLM 层被调用一次 | T2 |
| CT6 | 触发—普通轮次 | throttle 未到 → LLM **不**被调用 | T2 |
| CT7 | 预算闸门 | mock 预算超限 → 跳过 LLM，走启发式，断言 client 未被调用 | T2/GR6 |
| CT8 | 语义去重 | 候选与既有 manifest 语义相似（mock 高分）→ 跳过入库 | T4/GR4 |
| CT9 | 递归隔离 | 提取调用**不**再次触发 post-turn 记忆 hook（调用计数=1） | T3/GR5 |
| CT10 | 失败降级 | mock client 抛限流/超时 → 回退启发式，主流程不抛错，错误被分类 | T5/GR7 |
| CT11 | 熔断 | 连续失败达阈值 → 后续轮次不再调 LLM | T5 |
| CT12 | 置信度分级 | 通过校验+去重的 LLM 记忆标 `high`；启发式标 `low` | T6/GR8 |
| CT13 | 确定性 | 固定 mock 输出 → 提取结果确定（可重复断言，供 CI） | T7 |
| CT14 | no-op | `memory.enabled=false` 或 `llmExtraction.enabled=false` → 无 LLM 调用 | T6/T7 |

---

## 7. Impacted File List

| 文件 | 涉及任务 | 变更类型 |
|---|---|---|
| `src/services/memory-extraction-guard.ts` | T1 | NEW（校验 + 脱敏纯函数护栏） |
| `src/services/memoryExtraction.ts` | T2,T3,T4,T5,T6 | MODIFY（两级管线 + 触发闸门 + 去重 + 降级 + 读配置） |
| `src/services/extractionPrompts.ts` | T3 | MODIFY（强化输出格式硬约束以配合 T1 校验） |
| `src/services/budget.ts` | T2 | 关联（预算查询，无需改动或仅补查询辅助） |
| `src/services/error-classifier.ts` | T5 | 关联（`classifyApiError` 复用） |
| `src/memory/integration.ts` | T3 | MODIFY（`extractMemoriesFromConversation` 接线两级管线） |
| `src/memory/relevanceSearch.ts` | T4 | 关联（语义相似度打分复用） |
| `src/memory/protocol.ts` | T6 | MODIFY（`MemoryConfig` + `DEFAULT_MEMORY_CONFIG` 扩展） |
| `src/memory/telemetry.ts` | T7 | MODIFY（LLM 提取遥测字段） |
| `src/bootstrap/config.ts` | T6 | MODIFY（`memory.llmExtraction` schema + env 覆盖） |
| `src/api/BaseApiClient.ts` / `src/api/index.ts` | T3 | 关联（隔离轻量提取调用） |
| `src/tools/RunTool/secrets.ts` | T1 | 关联（密钥脱敏模式复用） |
| `src/permissions/protectedPaths.ts` | T1 | 关联（受保护路径脱敏复用） |
| `test/services/memory-extraction-guard.test.ts` | T1,T7 | NEW（确定性护栏单测） |
| `test/services/memory-llm-extraction.test.ts` | T2–T7 | NEW（mock client 契约测试 CT1–CT14） |

---

## 8. Implementation Progress Tracker

> 状态基准：本 Spec 创建于 2026-07-24，全部 `pending`；实现后回填 ✅ 与完成日期，附 `npm run typecheck` + `npm test` 通过证据。
> **实现完成 2026-07-25。** 证据：`npm run typecheck` 干净通过（`tsc --noEmit` 无错误）；记忆 + api 相关套件 `npx vitest run test/memory test/services/memory-*.test.ts test/api` = **647/649 通过**；新增契约测试 `memory-extraction-guard.test.ts`（18）+ `memory-llm-extraction.test.ts`（21）= **39/39 通过**（覆盖 CT1–CT14）。剩余 2 个失败为 `paths-coverage` / `FileMemoryService-comprehensive` 的 **Windows 路径分隔符** 预存在问题（`\` vs `/`，本次未触及 `paths.ts`/`FileMemoryService.ts`），在 CI 的 `ubuntu-latest` 上通过。全量套件其余失败均为 Windows 路径 + 缺失 Linux sandbox 后端（`failIfNoSandbox` 硬失败）的环境问题，与本改造无关。

| Task | 描述 | Phase | Priority | Status | 完成日期 |
|---|---|---|---|---|---|
| T1 | 输出校验 + 脱敏护栏层（R1,R2） | 1 | P0 | ✅ done | 2026-07-25 |
| T2 | 触发时机与成本预算闸门（R4） | 1 | P0 | ✅ done | 2026-07-25 |
| T3 | 混合两级提取管线 + forked 隔离（G1,G2,R3） | 2 | P1 | ✅ done | 2026-07-25 |
| T4 | 语义去重（G3） | 2 | P1 | ✅ done | 2026-07-25 |
| T5 | 失败静默降级兜底 | 2 | P1 | ✅ done | 2026-07-25 |
| T6 | 配置化 + 置信度分级（G4） | 3 | P2 | ✅ done | 2026-07-25 |
| T7 | 契约测试清单 + 遥测扩展（Q1） | 3 | P2 | ✅ done | 2026-07-25 |

> **后续完善（2026-07-25，对照验证补齐两项缺口）：**
> 1. **T6 双重成本约束闭环**：`shouldRunLlmExtraction` 新增会话级成本闸门——`llmRuntime.sessionCostUsd` 累计成功提取的预估花费，达到 `maxExtractionCostUsdPerSession` 即返回 `session_cost_exceeded` 并回退启发式（与 `budgetEnforcer` 构成 §9 要求的双重约束）。新增 4 个契约用例（欠费放行 / 达顶阻断 / reason 断言 / 重置清零 / 无上限）。
> 2. **T3 生产侧装配接线**：`QueryEngine` 构造函数将自身 `apiClient` + `budgetEnforcer` 默认注入 `MemoryIntegration`（`config.memory` 显式值优先，含显式 null；GR5 隔离语义不变——提取仍走隔离路径，不注册 hook）；`Bootstrap.ts`（主引擎 + IM 工厂）与 `acp/handlers.ts` 补接 `memory: { config: config.memory }`，使 `llmExtraction.enabled` 配置/env 真正抵达集成层。新增 `test/query/memory-wiring.test.ts`（4 用例：默认注入触发隔离调用 / 显式 client 优先 / 默认关闭零调用 / 共享预算闸门）。
> 证据：`npm run typecheck` 干净通过；契约套件 guard(18) + llm-extraction(25) + wiring(4) = **47/47 通过**；memory+api+query+bootstrap 套件 993/1053，60 个失败全部为 Windows 环境预存在问题（无 Linux sandbox 后端 / POSIX `/tmp` 路径假设 / 路径分隔符），与本次改动无关（与还原基线对照确认）。

---

## 9. Assumptions

- `llmExtraction.enabled` 默认 **`false`**（灰度开启），未开启时行为完全等价现启发式，零回归。
- LLM 提取走**隔离轻量 API 调用**（非完整 QueryEngine），关闭 memory/post-turn hook 以杜绝递归；独立 abort/timeout。
- 提取失败**永不阻塞主任务**：任何异常静默降级回启发式；连续失败熔断至会话结束。
- 语义去重阈值默认 0.85，复用 `relevanceSearch` 现有打分，不引入 embedding 依赖（保持零新增重依赖；如需 embedding 另立 Spec）。
- 敏感信息（密钥/密码/token）命中即**拒绝落盘**，受保护路径占位脱敏；记忆内容不落敏感全文。
- 契约测试以 mock client 断言行为契约，不断言 LLM 具体文案，保证 CI 确定性；现有启发式确定性单测保留。
- 成本受 `budgetEnforcer`（`subAgentTokenLimit`/`costLimitUsd`）与 `maxExtractionCostUsdPerSession` 双重约束。
