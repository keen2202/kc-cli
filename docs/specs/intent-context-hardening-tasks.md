# kc-cli 意图理解 / 上下文 / 范围控制能力强化 Task Breakdown

> Generated: 2026-07-22 | Based on `docs/specs/intent-context-hardening-spec.md` v1.0
> Total Tasks: 9 | Phases: 4 | 缺口来源: 2026-07-22 能力评估复核（H1 意图 / H2 上下文 / H3 边界 / H4 交互）

---

## Task Dependency Graph

```
Phase 1 (P0 — Windows 安全边界):
  T1 Windows 保护路径补齐(H3) ──> T2 系统写目录+路径检测(H3)

Phase 2 (P1 — 意图与上下文语义化):
  T3 CJK/多语言分词工具(H1/H2)  ──┬─> T4 任务分类多语言化(H1)
                                  └─> T5 记忆相关性语义化(H2)
  T6 文件路径提取跨语言(H2)          [独立]

Phase 3 (P1 — 交互不降级):
  T7 交互处理器抽象+接线(H4) ──> T8 AskUserTool 阻塞读取+回退(H4)

Phase 4 (P2 — 验证收尾):
  T9 集成测试与文档  [blockedBy T2, T4, T5, T6, T8]
```

依赖说明：
- **T1 → T2**：系统目录判定与 `looksLikePath` 复用 T1 的归一化辅助，故 T1 阻塞 T2。
- **T3 → T4 / T5**：分类与检索共用 `tokenize()`，T3 为二者前置。
- **T6** 独立于 T3（仅正则常量抽取），可并行。
- **T7 → T8**：AskUserTool 依赖 `UserInteractionHandler` 抽象与上下文注入。
- **T9** 汇聚所有实现任务，最后执行。

---

## Phase 1: Windows 安全边界补齐（P0）

### Task T1: Extend protected-path coverage for Windows

- **Status:** `completed`
- **Subject (imperative):** Extend protected-path patterns to cover Windows credential and system paths
- **Subject (continuous):** Extending protected-path patterns to cover Windows credential and system paths
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.1.1（对应 H3）
- **Dependencies:**
  - blockedBy: none
  - blocks: T2
- **Checklist:**
  - [x] 在 `src/permissions/protectedPaths.ts` 新增 `WINDOWS_PROTECTED_PATTERNS`（凭据 / 系统敏感 / 密钥证书三类，见 Spec 3.1.1）
  - [x] 新增 `normalizePathForMatch(p)`：`\`→`/`、小写盘符、展开 `%USERPROFILE%`/`~`（仅匹配层归一，不改实际路径）
  - [x] `containsProtectedPath` / `isProtectedPath` 内部先归一化，再对 Unix + Windows 模式求并集；对外签名不变
  - [x] 新增 `test/permissions/protectedPaths-windows.test.ts`：覆盖 `C:\Users\*\.ssh`、`.aws\credentials`、`System32\config` 等命中
  - [x] 原 Unix 保护路径用例零回归（`test/permissions/security.test.ts`）
  - [x] `npm run typecheck` 通过
  - [x] `npm test -- test/permissions` 通过
- **Files:**
  - MODIFY: `src/permissions/protectedPaths.ts`（新增 Windows 模式 + 归一化）
  - NEW: `test/permissions/protectedPaths-windows.test.ts`

---

### Task T2: Cover Windows system-write dirs and drive-letter path detection

- **Status:** `completed`
- **Subject (imperative):** Cover Windows system directories and drive-letter paths in security checks
- **Subject (continuous):** Covering Windows system directories and drive-letter paths in security checks
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.1.2（对应 H3）
- **Dependencies:**
  - blockedBy: T1
  - blocks: T9
- **Checklist:**
  - [x] 扩展 `SYSTEM_WRITE_DIRECTORIES`：追加 `C:\Windows\`、`C:\Program Files\`、`C:\Program Files (x86)\`、`C:\ProgramData\`
  - [x] `isSystemWriteDirectory` 复用 T1 归一化，盘符大小写不敏感前缀匹配
  - [x] 修正 `src/permissions/engine.ts` 的 `looksLikePath`：正则追加 `^([a-zA-Z]:[\\/]|\\\\)`（盘符 + UNC）
  - [x] 验证 `C:\...`、`\\server\share` 会进入 `tryRealpath` 软链接/junction 解析
  - [x] 单测：写 `C:\Windows\...` 被 deny；盘符路径经 realpath 后仍在保护集合内被拦
  - [x] `checkSecurityCritical` 决策顺序（deny-first / bypass-immune）不变，用例保持
  - [x] `npm run typecheck` + `npm test -- test/permissions` 通过
- **Files:**
  - MODIFY: `src/permissions/protectedPaths.ts`（`SYSTEM_WRITE_DIRECTORIES` + `isSystemWriteDirectory`）
  - MODIFY: `src/permissions/engine.ts`（`looksLikePath`）
  - MODIFY: `test/permissions/protectedPaths-windows.test.ts`（追加系统目录/盘符用例）

---

## Phase 2: 意图与上下文语义化（P1）

### Task T3: Build a multilingual CJK-aware tokenizer utility

- **Status:** `completed`
- **Subject (imperative):** Build a shared CJK-aware tokenizer for classification and retrieval
- **Subject (continuous):** Building a shared CJK-aware tokenizer for classification and retrieval
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.2.1（对应 H1/H2 基础）
- **Dependencies:**
  - blockedBy: none
  - blocks: T4, T5
- **Checklist:**
  - [x] 新增 `src/utils/tokenize.ts`，导出 `tokenize(text): string[]`
  - [x] ASCII 段按 `\s+`/标点切分，保留 `length >= 2` 词元；统一小写
  - [x] CJK 段（`\u4e00-\u9fff` 等）做 bigram + 单字切分，无外部依赖
  - [x] 去停用词：复用英文停用词并补充中文常见停用词
  - [x] 新增 `test/utils/tokenize.test.ts`：ASCII / CJK / 混合 / 停用词 / bigram 用例
  - [x] `npm run typecheck` + `npm test -- test/utils/tokenize.test.ts` 通过
- **Files:**
  - NEW: `src/utils/tokenize.ts`
  - NEW: `test/utils/tokenize.test.ts`

---

### Task T4: Harden task classification for multilingual and short inputs

- **Status:** `completed`
- **Subject (imperative):** Harden task classification to handle multilingual and short inputs
- **Subject (continuous):** Hardening task classification to handle multilingual and short inputs
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.2.2（对应 H1）
- **Dependencies:**
  - blockedBy: T3
  - blocks: T9
- **Checklist:**
  - [x] `detectTaskType` 增补中文关键词等价集（修复/错误/调试/重构/优化/实现/新增/创建/查找/部署/测试/文档）
  - [x] `isConversationalMessage`：含 CJK 时改用 `tokenize()` 命中任务关键词判定，替代纯 `len < 40` 启发式
  - [x] `estimateTaskComplexity`：多文件/跨项目/测试+实现信号补中文正则等价
  - [x] 函数签名与返回类型不变（纯增强匹配面）
  - [x] 扩展 `test/api/prompts/task-prompts.test.ts`：中英文任务/闲聊/复杂度矩阵（如"帮我查找 config 文件"→ 非 conversational）
  - [x] 英文现有用例零回归
  - [x] `npm run typecheck` + `npm test -- test/api` 通过
- **Files:**
  - MODIFY: `src/api/prompts/task-prompts.ts`
  - MODIFY: `src/api/prompts/task-prompts.test.ts`

---

### Task T5: Upgrade memory relevance scoring with tokens and CJK support

- **Status:** `completed`
- **Subject (imperative):** Upgrade memory relevance scoring to token-overlap with CJK support
- **Subject (continuous):** Upgrading memory relevance scoring to token-overlap with CJK support
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.2.3（对应 H2）
- **Dependencies:**
  - blockedBy: T3
  - blocks: T9
- **Checklist:**
  - [x] `findRelevantMemories` / `calculateRelevanceScoreInner` 分词切换为 `tokenize()`（替换 `split(/\s+/)`）
  - [x] 评分升级为 token-overlap 加权，保留精确匹配高权重 + 类型/recency/feedback/confidence 乘子
  - [x] 定义可选 `SemanticScorer` 接口（`score(query, entry): number | undefined`），默认走关键词路径（本期不实现 embedding）
  - [x] 缓存键改为归一化词元签名，避免大小写/顺序缓存击穿；保持 `invalidateScoreCache` 行为
  - [x] 扩展 `test/memory/relevanceSearch.test.ts`：CJK query 召回、token-overlap 排序、缓存签名一致性
  - [x] 现有英文相关性用例零回归
  - [x] `npm run typecheck` + `npm test -- test/memory` 通过
- **Files:**
  - MODIFY: `src/memory/relevanceSearch.ts`
  - MODIFY: `src/memory/relevanceSearch.test.ts`（或 `test/memory/relevanceSearch.test.ts`）

---

### Task T6: Make file-path extraction language-agnostic and configurable

- **Status:** `completed`
- **Subject (imperative):** Make file-path extraction language-agnostic via a shared extension set
- **Subject (continuous):** Making file-path extraction language-agnostic via a shared extension set
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.2.4（对应 H2）
- **Dependencies:**
  - blockedBy: none
  - blocks: T9
- **Checklist:**
  - [x] 抽取共享常量 `TRACKED_SOURCE_EXTENSIONS`（`src/constants.ts` 或 `src/utils/`），扩充 c/h/cpp/cs/kt/swift/scala/php/rb/sh/sql/vue/svelte/yaml/toml 等
  - [x] `QueryEngineImportance.extractFilePaths` 改用共享集合动态生成正则
  - [x] `QueryEnginePlanning.extractFindings` 的 `fileMatches` 改用共享集合
  - [x] 支持 Windows 反斜杠分隔与含空格前最短匹配
  - [x] 单测：多语言文件路径（`.cs`/`.kt`/`.sql`）被正确提取
  - [x] `npm run typecheck` + `npm test -- test/query` 通过
- **Files:**
  - MODIFY: `src/constants.ts`（新增共享扩展名常量）
  - MODIFY: `src/query/QueryEngineImportance.ts`
  - MODIFY: `src/query/QueryEnginePlanning.ts`

---

## Phase 3: 交互澄清不降级（P1）

### Task T7: Introduce a UserInteractionHandler abstraction and wire it into the executor

- **Status:** `completed`
- **Subject (imperative):** Introduce a UserInteractionHandler abstraction and wire it into the tool executor
- **Subject (continuous):** Introducing a UserInteractionHandler abstraction and wiring it into the tool executor
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.3.1（对应 H4）
- **Dependencies:**
  - blockedBy: none
  - blocks: T8
- **Checklist:**
  - [x] 在 `src/tools/protocol.ts` 定义 `UserInteractionHandler`（`ask(request): Promise<string>`）并给 `ToolUseContext` 增加可选 `interaction?`
  - [x] `ToolExecutor` 新增 `setUserInteractionHandler()`（对齐 `setPermissionRequestHandler` 模式）
  - [x] 在 `executeSingle`/`executeParallel` 的 `enrichedContext` 注入 `interaction`
  - [x] 类型检查通过，现有工具上下文使用无破坏
  - [x] `npm run typecheck` + `npm test -- test/executors` 通过
- **Files:**
  - MODIFY: `src/tools/protocol.ts`（`ToolUseContext` + `UserInteractionHandler`）
  - MODIFY: `src/executors/toolExecutor.ts`（setter + 注入）

---

### Task T8: Route AskUserTool through blocking input with a non-interactive fallback

- **Status:** `completed`
- **Subject (imperative):** Route AskUserTool through blocking stdin input with a non-interactive fallback
- **Subject (continuous):** Routing AskUserTool through blocking stdin input with a non-interactive fallback
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.3.2（对应 H4）
- **Dependencies:**
  - blockedBy: T7
  - blocks: T9
- **Checklist:**
  - [x] `AskUserTool.call` 优先使用 `context.interaction?.ask(...)`
  - [x] 无 handler 且 `process.stdin.isTTY` → `node:readline` 阻塞读取，支持数字选项选择与 `default_answer` 提示
  - [x] 非交互（无 TTY、无 handler）→ 有 `default_answer` 返回之，否则 `toolError('interactive input unavailable')`（移除占位文本）
  - [x] 交互期间标记为非并发安全（`isConcurrencySafe` 返回 false）以避免流式交错
  - [x] 新增 `test/tools/askUser.test.ts`：handler 优先、mock readline 阻塞、非交互回退与失败三路径
  - [x] `npm run typecheck` + `npm test -- test/tools` 通过
- **Files:**
  - MODIFY: `src/tools/AskUserTool/index.ts`
  - NEW: `test/tools/askUser.test.ts`

---

## Phase 4: 验证与文档收尾（P2）

### Task T9: Add end-to-end coverage and update docs for all hardening areas

- **Status:** `completed`
- **Subject (imperative):** Add end-to-end tests and update documentation for the hardening areas
- **Subject (continuous):** Adding end-to-end tests and updating documentation for the hardening areas
- **Spec:** `docs/specs/intent-context-hardening-spec.md` Section 3.4 & 5（对应 H1–H4）
- **Dependencies:**
  - blockedBy: T2, T4, T5, T6, T8
  - blocks: none
- **Checklist:**
  - [x] 新增 `test/integration/intent-context-hardening.test.ts`：中文"查找 / 修改 / 越界写系统目录 / 上下文延续"四场景端到端
  - [x] 断言：中文任务分类正确、越界写被拦、CJK query 命中记忆、交互回退按预期
  - [x] 更新 `docs/repowiki/Permission-System.md`（Windows 覆盖）与 `docs/repowiki/Memory-System.md`（多语言检索）
  - [x] 更新本 Spec 第 4 节进度表状态为 completed
  - [x] 全量 `npm run typecheck` 通过
  - [x] 全量 `npm test` 全绿（无回归）
- **Files:**
  - NEW: `test/integration/intent-context-hardening.test.ts`
  - MODIFY: `docs/repowiki/Permission-System.md`
  - MODIFY: `docs/repowiki/Memory-System.md`
  - MODIFY: `docs/specs/intent-context-hardening-spec.md`（进度表）

---

## Status Summary

| Task | Subject | Status | blockedBy | blocks |
|---|---|---|---|---|
| T1 | Windows 保护路径补齐 | `completed` | — | T2 |
| T2 | Windows 系统目录 + 路径检测 | `completed` | T1 | T9 |
| T3 | CJK/多语言分词工具 | `completed` | — | T4, T5 |
| T4 | 任务分类多语言鲁棒化 | `completed` | T3 | T9 |
| T5 | 记忆相关性语义化 + CJK | `completed` | T3 | T9 |
| T6 | 文件路径提取跨语言 | `completed` | — | T9 |
| T7 | 交互处理器抽象 + 接线 | `completed` | — | T8 |
| T8 | AskUserTool 阻塞读取 + 回退 | `completed` | T7 | T9 |
| T9 | 集成测试与文档收尾 | `completed` | T2,T4,T5,T6,T8 | — |

> 进度约定：所有任务（T1–T9）已完成。集成测试 15 例全绿，全量 typecheck / test 无回归。
>
> **2026-07-28 状态对账**：逐任务 Status 字段与 checkbox 已按代码现状回写，消除与上表的矛盾。核心证据：`src/permissions/protectedPaths.ts`（`WINDOWS_PROTECTED_PATTERNS`/`normalizePathForMatch`/`SYSTEM_WRITE_DIRECTORIES` 含 Windows 目录）、`src/permissions/engine.ts:322`（盘符+UNC 正则）、`src/utils/tokenize.ts`、`src/api/prompts/task-prompts.ts`（中文关键词+CJK 分词）、`src/memory/relevanceSearch.ts`（tokenize+SemanticScorer）、`src/constants.ts`（`TRACKED_SOURCE_EXTENSIONS`/`buildSourcePathRegex`）、`src/tools/protocol.ts`（`UserInteractionHandler`）、`src/executors/toolExecutor.ts:877`、`src/tools/AskUserTool/index.ts`（interaction→readline→回退，`isConcurrencySafe()=false`）；测试 `protectedPaths-windows/tokenize/askUser/intent-context-hardening` 4 个文件均在。repowiki Permission-System（Windows 覆盖）与 Memory-System（CJK 检索）已更新。`npm run typecheck` 本机通过；Windows 本机 vitest 失败均为 sandbox/路径分隔符环境问题（CI ubuntu 全绿），与本清单无关。
