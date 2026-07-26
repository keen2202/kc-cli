# kc-cli 意图理解 / 上下文 / 范围控制能力强化 Spec

> 基于 2026-07-22 对 `src/query/**`、`src/memory/**`、`src/api/prompts/**`、`src/permissions/**`、`src/tools/**` 的源码逐条复核编制
> Generated: 2026-07-22 | Version: 1.0
> Scope: 意图识别语义化、记忆检索多语言化、Windows 安全边界补齐、交互澄清降级修复
> 原则基线：**语义鲁棒 · 多语言等价 · 边界跨平台 · 交互不降级** —— 不改变现有安全模型（deny-first / bypass-immune），只关闭已识别的鲁棒性与平台覆盖缺口

---

## 1. Executive Summary

前一轮能力评估确认 kc-cli 在"目标识别 / 上下文理解 / 范围界定 / 执行反馈"四方面有成熟架构支撑，其中权限与沙箱达工业级水准。本 Spec 针对复核中确认的 **4 项真实缺口**制定修复方案：

- **核心缺口（4）：**
  - **H1（意图识别）** 任务分类与复杂度估算完全依赖**全英文关键词正则**，CJK / 非英语 / 隐晦表述被系统性误判（短中文任务落入 `conversational` 分支，跳过 planning 与预算适配）。
  - **H2（上下文检索）** 记忆相关性检索为**纯 substring 关键词匹配 + 空格分词**，对 CJK 无效；`filePaths` 提取用固定扩展名正则，漏标非常见语言文件。
  - **H3（安全边界）** 受保护路径与系统写目录判定**以 Unix 路径为中心**，Windows（当前用户环境为 Windows 25H2）盘符路径 / 反斜杠 / 系统目录覆盖薄弱，`looksLikePath` 不识别 `C:\` 导致跳过软链接解析。
  - **H4（交互澄清）** `AskUserTool` 在纯 CLI / 非交互模式返回占位文本、**无法真正阻塞等待用户输入**，交互澄清能力降级为无效。

- **Risk Profile：** Phase 1（Low–Medium，安全正则扩展需防误伤）/ Phase 2（Low–Medium，分词与评分改动触及检索质量）/ Phase 3（Medium，交互 IO 引入阻塞路径）/ Phase 4（Low，验证收尾）。
- **Total Estimated Effort：** 约 4–6 天。
- **非目标（Out of Scope）：** 不引入外部向量数据库；不改动 deny-first 决策顺序与 HMAC 沙箱签名机制；不重写 UI 渲染层。

### 1.1 复核结论对照（供追溯）

| 编号 | 缺口 | 复核状态 | 证据 |
|---|---|---|---|
| H1 | 意图分类全英文正则 | ❌ 未处理 | `TASK_ORIENTED_REGEX`/`CONVERSATIONAL_*`（`task-prompts.ts:46-55`）均为英文；`len < 40 && !TASK_ORIENTED_REGEX`（`:78`）误伤短中文任务 |
| H2 | 记忆检索非语义 + CJK 失效 | ❌ 未处理 | `queryLower.split(/\s+/).filter(w => w.length > 2)`（`relevanceSearch.ts:34,114`）对无空格 CJK 退化为整串；评分仅 `includes`（`:144-160`）；`filePaths` 固定扩展名（`QueryEngineImportance.ts:92`、`QueryEnginePlanning.ts:101`） |
| H3 | Windows 安全边界薄弱 | ⚠️ 部分覆盖 | `PROTECTED_PATH_SUBSTRINGS_REGEX` 主 Unix（`protectedPaths.ts:67`）；`SYSTEM_WRITE_DIRECTORIES` 仅 `/etc//usr//bin//sbin`（`:107-112`）；`looksLikePath` 仅 `/ ./ ../ ~/`（`engine.ts:318-320`），漏 `C:\` |
| H4 | 交互澄清纯 CLI 降级 | ❌ 未处理 | `AskUserTool.call` 返回 `[In interactive mode, user would be prompted here]`（`AskUserTool/index.ts:36`），无阻塞读取 |

---

## 2. Problem Classification & Priority Matrix

### 2.1 Problem Categories

| 编号 | 问题 | 维度 | 当前状态 | 目标状态 |
|---|---|---|---|---|
| H1 | 意图/复杂度识别仅英文关键词 | 意图理解 / 国际化 | CJK 短任务误判为闲聊，跳过 planning / 预算适配 | 多语言关键词等价 + 非 ASCII 输入放宽长度阈值 + 可选轻量语义兜底 |
| H2 | 记忆检索非语义 + CJK 分词失效 | 上下文理解 / 检索质量 | 空格分词 + 纯 substring，CJK 命中率极低；文件路径漏标 | CJK-aware 分词 + token-overlap 评分 + 可扩展/可配置文件扩展名，预留 embedding 接口 |
| H3 | 受保护路径 / 系统目录 Windows 覆盖弱 | 安全 / 跨平台 | Unix 路径为中心，盘符路径不解析软链接、系统目录漏判 | 补齐 Windows 敏感路径与系统目录，路径归一化后判定，`looksLikePath` 识别盘符 |
| H4 | 交互澄清在 CLI/非交互模式降级 | 执行反馈 / 交互 | `AskUserTool` 返回占位符，不阻塞 | 抽象 `UserInteractionHandler`，CLI 走 stdin 阻塞读取，非交互回退 `default_answer` 或明确失败 |

### 2.2 Priority Ranking

| Priority | Task | Phase | Impact | Effort | Risk |
|---|---|---|---|---|---|
| P0 | T1 Windows 受保护路径补齐（H3） | 1 | High | 0.5d | Medium |
| P0 | T2 Windows 系统写目录 + 路径检测（H3） | 1 | High | 0.5d | Medium |
| P1 | T3 多语言/CJK 分词工具（H1/H2 基础） | 2 | High | 0.5d | Low |
| P1 | T4 任务分类多语言鲁棒化（H1） | 2 | Medium | 0.5d | Low |
| P1 | T5 记忆相关性语义化 + CJK（H2） | 2 | High | 1d | Medium |
| P1 | T6 文件路径提取跨语言/可配置（H2） | 2 | Medium | 0.5d | Low |
| P1 | T7 交互处理器抽象与执行器接线（H4） | 3 | High | 0.5d | Medium |
| P1 | T8 AskUserTool 阻塞读取 + 回退（H4） | 3 | High | 0.5d | Medium |
| P2 | T9 集成测试与文档收尾 | 4 | Medium | 0.5d | Low |

---

## 3. 修复方案与技术实现细节

### 3.1 Phase 1 — Windows 安全边界补齐（H3，P0）

#### 3.1.1 受保护路径 Windows 扩展（对应 T1）

**问题：** [`PROTECTED_PATH_SUBSTRINGS_REGEX`](file:///d:/Workespace/kc-cli/src/permissions/protectedPaths.ts#L67) 仅零星覆盖 `\Users\*\.ssh` 与 `%USERPROFILE%\.`，未覆盖 Windows 常见敏感路径。

**方案：**
- 在 `protectedPaths.ts` 新增 `WINDOWS_PROTECTED_PATTERNS`，覆盖：
  - 凭据：`\Users\*\.aws\credentials`、`\.azure\`、`\.kube\config`、`\.docker\config.json`、`\.ssh\`、`\AppData\Roaming\gcloud\`
  - 系统敏感：`C:\Windows\System32\config\`(SAM/SYSTEM)、`\Windows\System32\drivers\etc\hosts`
  - 密钥/证书：`\.gnupg\`、`\Microsoft\Crypto\`
- 提供**路径归一化**辅助 `normalizePathForMatch(p)`：统一 `\` → `/`、小写盘符、展开 `%USERPROFILE%`/`~`，供正则匹配使用（匹配层归一，不改变实际操作路径）。
- 保持 `containsProtectedPath` / `isProtectedPath` 对外签名不变，内部先归一化再对 Unix + Windows 两套模式求并集。

#### 3.1.2 系统写目录与路径检测（对应 T2）

**方案：**
- 扩展 [`SYSTEM_WRITE_DIRECTORIES`](file:///d:/Workespace/kc-cli/src/permissions/protectedPaths.ts#L107)：追加 `C:\Windows\`、`C:\Program Files\`、`C:\Program Files (x86)\`、`C:\ProgramData\`；`isSystemWriteDirectory` 归一化后按盘符大小写不敏感前缀匹配。
- 修正 [`looksLikePath`](file:///d:/Workespace/kc-cli/src/permissions/engine.ts#L318)：正则追加 Windows 盘符与 UNC —— `^([a-zA-Z]:[\\/]|\\\\)`，使 `C:\...`、`\\server\share` 也进入 `tryRealpath` 软链接/junction 解析路径。
- `checkSecurityCritical` 逻辑顺序不变（deny-first、bypass-immune 保持）。

**验证要点：** Windows 与 POSIX 双平台单测；确保原 Unix 用例零回归；构造盘符软链接/junction 绕过用例被拦截。

### 3.2 Phase 2 — 意图与上下文语义化（H1/H2，P1）

#### 3.2.1 多语言/CJK 分词工具（对应 T3，基础）

**方案：** 新增 `src/utils/tokenize.ts`，导出 `tokenize(text): string[]`：
- ASCII 段按 `\s+` 与标点切分，保留 `length >= 2` 词元；
- CJK 段（`\u4e00-\u9fff` 等）做 **bigram + 单字** 切分（无外部依赖，覆盖检索召回）；
- 统一小写、去停用词（复用现有英文停用词并补充中文常见停用词）。
- 该工具为 T4/T5 共同依赖，独立可测。

#### 3.2.2 任务分类多语言鲁棒化（对应 T4）

**方案（`src/api/prompts/task-prompts.ts`）：**
- 为 `detectTaskType` / `isConversationalMessage` / `estimateTaskComplexity` 增补中文关键词等价集（如 `修复|错误|调试|重构|优化|实现|新增|创建|查找|部署|测试|文档`）与问候集（沿用现有 `你好|您好|...`）。
- **非 ASCII 输入放宽 `len < 40` 短消息启发式**：含 CJK 时改用"分词后是否命中任务关键词"判定，避免"帮我查找 config 文件"被误判为闲聊。
- 复杂度信号（多文件/跨项目/测试+实现）补中文正则等价。
- 保持函数签名与返回类型不变，纯增强匹配面。

#### 3.2.3 记忆相关性语义化 + CJK（对应 T5）

**方案（`src/memory/relevanceSearch.ts`）：**
- `findRelevantMemories` / `calculateRelevanceScoreInner` 的分词从 `split(/\s+/)` 切换为 `tokenize()`（T3）。
- 评分从纯 `includes` 升级为 **token-overlap 加权**：description/fileName 与 query 的词元交集比例参与打分，保留原精确匹配高权重、类型加权、recency、feedback 与 confidence 乘子。
- **预留语义接口**：定义可选 `SemanticScorer` 接口（`score(query, entry): number | undefined`），默认 `undefined` 走关键词路径；为将来接入本地 embedding 留扩展点，本期不实现具体 embedding。
- 缓存键从 `queryLower` 改为归一化词元签名，避免大小写/顺序造成的缓存击穿。

#### 3.2.4 文件路径提取跨语言/可配置（对应 T6）

**方案：**
- 抽取共享常量 `TRACKED_SOURCE_EXTENSIONS`（集中于 `src/utils/` 或 `constants.ts`），扩充 `c|h|cpp|cs|kt|swift|scala|php|rb|sh|sql|vue|svelte|yaml|toml` 等；
- [`QueryEngineImportance.extractFilePaths`](file:///d:/Workespace/kc-cli/src/query/QueryEngineImportance.ts#L90) 与 [`QueryEnginePlanning.extractFindings`](file:///d:/Workespace/kc-cli/src/query/QueryEnginePlanning.ts#L100) 改用共享集合动态生成正则；
- 支持路径含空格前的最短匹配与 Windows 反斜杠分隔。

### 3.3 Phase 3 — 交互澄清不降级（H4，P1）

#### 3.3.1 交互处理器抽象与执行器接线（对应 T7）

**方案：**
- 参照现有 [`permissionRequestHandler`](file:///d:/Workespace/kc-cli/src/executors/toolExecutor.ts#L699) 模式，在 `src/tools/protocol.ts` 的 `ToolUseContext` 增加可选 `interaction?: UserInteractionHandler`；
- 定义 `UserInteractionHandler`：`ask(request: { question; options?; default?; }): Promise<string>`；
- `ToolExecutor` 新增 `setUserInteractionHandler()` 并在 `executeParallel`/`executeSingle` 的 `enrichedContext` 注入；UI 层注册真实实现，CLI 交互模式注册 stdin 实现。

#### 3.3.2 AskUserTool 阻塞读取 + 回退（对应 T8）

**方案（`src/tools/AskUserTool/index.ts`）：**
- `call` 优先使用 `context.interaction?.ask(...)`；
- 无 handler 且 `process.stdin.isTTY` → 使用 `node:readline` 阻塞读取（带 `default_answer` 提示），支持数字选项选择；
- 非交互（无 TTY、无 handler）→ 若有 `default_answer` 返回之，否则返回明确 `toolError('interactive input unavailable')`，**不再返回误导性占位文本**；
- 保留 `isReadOnly`/`isConcurrencySafe`，为避免与流式输出交错，交互期间标记为非并发安全。

### 3.4 Phase 4 — 验证与文档收尾（T9）

- 端到端集成测试：模拟中文任务（查找/修改/越界/上下文延续）走通分类→检索→权限→交互链路；
- 更新 `docs/repowiki/Permission-System.md`、`Memory-System.md` 中平台与语言覆盖说明。

---

## 4. Implementation Progress Tracking

| Task | 问题 | Phase | Priority | Status | Owner | 完成判定 |
|---|---|---|---|---|---|---|
| T1 | H3 | 1 | P0 | completed | - | Windows 保护路径单测通过、Unix 零回归 |
| T2 | H3 | 1 | P0 | completed | - | 系统目录/盘符软链接用例拦截、双平台绿 |
| T3 | H1/H2 | 2 | P1 | completed | - | `tokenize()` CJK/ASCII 单测通过 |
| T4 | H1 | 2 | P1 | completed | - | 中文任务不再误判、英文用例零回归 |
| T5 | H2 | 2 | P1 | completed | - | CJK query 召回提升、评分单测通过 |
| T6 | H2 | 2 | P1 | completed | - | 多语言文件路径被提取、共享常量单测 |
| T7 | H4 | 3 | P1 | completed | - | 上下文注入 handler、类型检查通过 |
| T8 | H4 | 3 | P1 | completed | - | CLI 阻塞读取 + 非交互回退单测通过 |
| T9 | 全部 | 4 | P2 | completed | - | 集成测试全绿（15）、文档更新 |

---

## 5. 验证与测试方案

### 5.1 单元测试
- `test/permissions/protectedPaths-windows.test.ts`（新）：Windows 敏感路径、系统目录、盘符软链接归一化匹配；Unix 现有用例回归。
- `test/utils/tokenize.test.ts`（新）：ASCII/CJK/混合分词、停用词、bigram。
- `test/api/task-prompts.test.ts`（扩展）：中英文任务/闲聊/复杂度矩阵。
- `test/memory/relevanceSearch.test.ts`（扩展）：CJK query 召回、token-overlap 排序、缓存签名。
- `test/tools/askUser.test.ts`（新）：handler 优先、TTY 阻塞（mock readline）、非交互回退与失败。

### 5.2 集成测试
- `test/integration/intent-context-hardening.test.ts`（新）：中文"查找/修改/越界写系统目录/上下文延续"四场景端到端，断言分类正确、越界被拦、上下文命中记忆。

### 5.3 回归门禁
- `npm run typecheck` 通过；
- `npm test` 全绿（`test/permissions/**`、`test/memory/**`、`test/api/**`、`test/tools/**` 无回归）；
- 安全模型不变性检查：deny-first 顺序、bypass-immune 保护路径、HMAC 沙箱签名相关用例保持通过。

### 5.4 验收标准（Definition of Done）
- 四项缺口对应单测与集成测试全部通过；
- Windows 与 POSIX 双平台 CI 均绿；
- 无对现有安全决策路径的放松（新增仅收紧或等价扩展覆盖面）。
