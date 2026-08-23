# Audit Remediation Round 3 Specification — 信号完整性 · 安全缺口 · 架构治理

**Version**: 1.0.0
**Date**: 2026-08-23
**Source**: KC-CLI v3.2.0 全项目深度审计（五维：架构耦合 / 代码质量 / 安全与性能 / 依赖治理 / 测试覆盖）
**审计方法**: 3 个专项并行深查 + 人工交叉验证关键指控；全量测试实跑（4632 pass / 5 环境性失败 / 9 skip）；`tsc --noEmit` 零错误；覆盖率报告（coverage/clover.xml，lines 76.7%）与源码静态映射交叉核对
**Status**: Draft — 待评审
**前序**: `audit-remediation-round2-spec.md` · `architecture-review-fixes-spec.md` · `ui-structural-hardening-spec.md`
**任务清单**: `docs/specs/audit-remediation-round3-tasks.md`

---

## 0. 审计核心结论（TL;DR）

> **最大缺陷不是任何单个 bug，而是"治理信号失真"：项目的自我描述（AGENTS.md 作为 single source of truth）与真实实现之间出现系统性裂缝，且质量度量机制（测试/覆盖率门禁）已被数字游戏化，从"挑战叙事"退化为"为叙事背书"。**

证据链（全部经人工复核）：

| # | 项目声称 | 可验证事实 |
|---|---|---|
| 1 | 工具采用 prepare/execute/finalize 两阶段执行 | `ToolDefinition`（tools/protocol.ts:70-109）无此声明；`buildTool()` 不支持；全仓库零工具实现；`toolExecutor.ts:390,520` 用 `(tool as any)` 探测幽灵钩子 |
| 2 | "11 providers extend BaseApiClient" | 实际 3 个客户端类 + 8 个配置项（api/index.ts:163-171 default 分支） |
| 3 | "never swallow errors silently" | 344 个 catch 中 67 个空 catch（19.5%）；auto-commit 失败静默（QueryEngineTurnControl.ts:148,186） |
| 4 | "Protocol-first per-module protocol.ts" | 17 个模块无 protocol.ts；85 个非协议文件被跨模块直引；api/protocol.ts 反向依赖 query/tools |
| 5 | "4700+ tests, comprehensive" | ~2400 行恒真桩测试（mock 断言 mock）；sandbox-e2e 在 CI 无后端时 0 断言报绿 |
| 6 | 覆盖率阈值"ratchet upward over time" | 对 agp/im/commands/ui 主动降至 40%，无收紧机制 |
| 7 | 头条特性 Autogenesis 自进化 | SEPL 进化闭环 ~2600 行零调用方；`onEvolve` 从未被赋值（仅 QueryEngine.ts:575,586 读取） |

---

## 1. 问题分类与优先级矩阵

### Priority Legend

| Level | Criteria |
|-------|----------|
| **P0** | 安全缺口或质量信号失真——直接导致"不可信的安全控制"或"不可信的质量门禁"，必须最先修复 |
| **P1** | 真实缺陷或高价值治理项——安全加固、死代码决策、文档对齐、零直测红区 |
| **P2** | 结构性改进——重复逻辑合并、单一事实源、协议补全，降低长期维护成本 |
| **P3** | 锦上添花——命名规范、工程化设施、大型重构第一阶段 |

### Summary Count

| Priority | Count | 编号 | 主要子系统 |
|----------|-------|------|-----------|
| P0 | 4 | C1-C4 | executors/tools、SqlTool、test 基础设施 |
| P1 | 10 | H1-H10 | permissions、utils/ssrf、依赖、AGP、memory、文档、query/orchestrator 测试 |
| P2 | 9 | M1-M9 | api 客户端、扩展点、state/protocol、日志、coverage 门禁 |
| P3 | 5 | L1-L5 | QueryEngine、UI、命名、工程化、依赖升级 |

---

## 2. P0 修复方案

### C1: 幽灵两阶段执行（prepare/finalize）——删除或落实

**Severity**: Critical（质量信号失真 + 执行主路径上的 `as any` 动态调度）
**证据**:
- `src/executors/toolExecutor.ts:390,392` — `(tool as any).prepare`（含 skip 语义管道）
- `src/executors/toolExecutor.ts:520,522` — `(tool as any).finalize`（结果变换管道）
- `src/tools/protocol.ts:70-109` — `ToolDefinition` 无 `prepare`/`finalize` 字段
- `src/Tool.ts:18-44` — `buildTool()` 不支持两阶段
- 全仓库 `grep "prepare:" src/tools` 零命中（排除测试）
**Root Cause**: 协议接口与执行器能力各自演化，靠 `as any` 维持编译通过；AGENTS.md 按意图而非实现书写。

**修复方案（决策：推荐方案 A）**:
- **方案 A（推荐）— 删除**：移除 toolExecutor 中两段探测代码（约 40 行），AGENTS.md 改为描述真实的 `call + checkPermissions + plugin hooks(preToolUse/postToolUse)` 模型。理由：零工具实现、零调用方、删除后行为零变化、消除执行主路径上的 `as any`。
- **方案 B — 落实**：`ToolDefinition` 增加 `prepare?/finalize?` 可选字段，`buildTool()` 透传，迁移至少 1 个真实工具（候选：SqlTool 的连接预热 / FileEditTool 的 diff 预计算），并为两阶段路径补行为级测试。仅当有真实需求时选择。

**技术实现（方案 A）**:
```ts
// toolExecutor.ts — 删除 389-411 区间的 "2b. Tool prepare hook" 块
// 删除 519-526 区间的 "5. Tool finalize hook" 块
// effectiveInput 在删除后直接沿用 preToolUse 插件钩子的输出
```
同步修改：AGENTS.md Tools 段、README.md "two-phase execution" 表述、`docs/repowiki/Tools-System.md`。

**涉及文件**: `src/executors/toolExecutor.ts`、`AGENTS.md`、`README.md`、`docs/repowiki/Tools-System.md`
**验证**: `npx tsc --noEmit` 零错误；`npx vitest run test/executors/` 全绿；`grep -rn "as any).prepare\|as any).finalize" src` 零命中；现有 23 工具回归测试无行为差异。

---

### C2: SqlTool 白名单前缀绕过（路径穿越）

**Severity**: Critical（安全控制可被绕过）
**证据**: `src/tools/SqlTool/index.ts:116` — `if (!allowed.some(p => target.startsWith(p))) return null;`
**Root Cause**: 前缀匹配无路径边界：白名单 `/data/dbs` 放行 `/data/dbs-backup/secret.db` 与 `/data/dbs/../etc/x.db`；该层无 realpath 解析、无 `..` 规范化（权限引擎 Step 3 的 realpath 仅覆盖 protected paths，不补白名单语义）。

**修复方案**:
1. 规范化目标路径（`path.resolve`）后再比较；
2. 边界匹配改为 `target === p || target.startsWith(p + path.sep)`；
3. 对 target 与白名单条目均做 `fs.realpathSync`（存在性检查时），消除 symlink 逃逸；
4. 拒绝含 `..` 段的输入（fail-closed）。

**技术实现**:
```ts
function resolveAllowed(state, database, cwd) {
  // ...existing checks (:memory: etc.)...
  const target = path.resolve(database.startsWith('/') ? database : `${cwd}/${database}`);
  if (target.split(path.sep).includes('..')) return null;           // fail-closed
  const isAllowed = allowed.some(p => {
    const base = path.resolve(p);
    return target === base || target.startsWith(base + path.sep);   // 边界匹配
  });
  if (!isAllowed) return null;
  // realpath 校验（symlink 逃逸）：realpath(target) 仍须落在某个 realpath(base) 之下
  return { path: target, readonly: sqlConfig.allowWrite !== true };
}
```

**涉及文件**: `src/tools/SqlTool/index.ts`、`src/tools/SqlTool/index.test.ts`（新增穿越用例）
**验证**: 新增单测——白名单 `/data/dbs` 时 `/data/dbs-backup/x.db`、`/data/dbs/../x.db`、symlink 指向白名单外 均被拒；现有 SqlTool 套件全绿；`test/permissions/` 回归无差异。

---

### C3: 测试软跳过——0 断言报绿

**Severity**: Critical（质量门禁失真：CI 绿灯不等于验证发生）
**证据**:
- `test/integration/sandbox-e2e.test.ts:79,89,107` — canary 失败时每个 `it` 体早退 `return`，无 skip 标记
- `test/integration/full-workflow.test.ts:36-41` — 6 处 `X ? describe : describe.skip`（模块导入失败时整套静默跳过）
**Root Cause**: 用运行时条件分支模拟 skip，绕过 vitest 的可见性机制；CI 无 docker/bwrap job，e2e 实际从未在 CI 执行。

**修复方案**:
1. 早退改 `it.skipIf(!sandboxWorks)` / `describe.skipIf`（显式出现在 reporter 的 skipped 计数中）；
2. `full-workflow.test.ts` 的条件降级改为顶部静态 `describe.skipIf(!BashTool)` 并加注释说明导入失败时的告警；
3. CI 增加 sandbox job：ubuntu-latest 安装 bubblewrap（`sudo apt install bubblewrap`）后跑 `test/integration/sandbox-e2e.test.ts`，保证 e2e 至少在一条 CI 腿上真执行；
4. vitest reporter 增加 `--reporter=verbose` 断言 skipped 数量不高于基线（防新增软跳过）。

**涉及文件**: `test/integration/sandbox-e2e.test.ts`、`test/integration/full-workflow.test.ts`、`.github/workflows/ci.yml`
**验证**: 本地无 docker 环境运行时 reporter 显示 `skipped N`（N>0 显式可见）；CI sandbox job 绿；`grep -c "skipIf" test/integration/` ≥ 7。

---

### C4: 恒真桩覆盖率测试改造

**Severity**: Critical（覆盖率数字虚高，掩盖 H6/H7 零直测红区）
**证据**:
- `test/query/QueryEngine-coverage{,-2,-3,-3b,-4}.test.ts` 合计约 2397 行——permissions/engine、sandbox、compaction、tokenEstimation 全部 `vi.mock` 成恒真桩（engine 恒 `allow`、sandbox 恒 `run-unsandboxed`），断言"编排调用了哪些 mock"
- `test/services/memoryConsolidation-coverage.test.ts` — 死模块（见 H9）唯一的引用者，为其续命覆盖率
**Root Cause**: 以覆盖率为目标反推测试形态；mock 断言 mock 不产生缺陷拦截力。

**修复方案**:
1. 逐文件分类：**保留并改造**（QueryEngine 编排骨架测试——把被 mock 的 permissions/sandbox 至少一侧换成真实实现 + MockExecutionEnv）；**删除**（纯桩断言、无行为价值的用例）；
2. `memoryConsolidation-coverage.test.ts` 随 H9 死模块一并删除；
3. 建立规约写入 AGENTS.md Testing 段：禁止 `vi.mock` 安全关键模块（permissions/sandbox/protectedPaths）后断言调用次数——此类断言一律视为无效覆盖。

**涉及文件**: `test/query/QueryEngine-coverage*.test.ts`（5 个）、`test/services/memoryConsolidation-coverage.test.ts`、`AGENTS.md`
**验证**: 改造后套件全绿且断言的是行为结果而非 mock 调用；覆盖率 lines 仍 ≥ 60% 全局阈值；新增 AGENTS.md 条款生效（code review 检查项）。

---

## 3. P1 修复方案

### H1: auto-commit 失败静默吞错
**证据**: `src/query/QueryEngineTurnControl.ts:148,186` — `catch {} // Non-fatal`
**方案**: 改为 `logger.query.warn('[auto-commit] failed', { error })` 并在 UI 状态栏提示一次；失败信息进 `queryOperationAudit`。**文件**: `QueryEngineTurnControl.ts` + 行为测试。**验证**: 注入 git 失败的 MockShell，断言 warn 日志与继续执行（不中断 turn）。

### H2: SSRF fail-open 收紧 + DNS 局限文档化
**证据**: `src/utils/ssrf.ts:27-29` — URL 解析失败返回 `false`（视为外部）；无 DNS 解析检查（rebinding / 内部域名穿透）。
**方案**: ① `WebFetchTool` 侧对 unparseable URL 直接拒绝（ssrf.ts 保持纯函数语义，新增 `assertFetchableUrl` 组合函数）；② `utils/ssrf.ts` 头注释明确声明"不做 DNS 解析校验"的威胁模型边界；③ 评估在 WebFetch 执行前 `dns.lookup` 后复检 IP（P2 跟进，本项先文档化 + 收紧 fail-open）。**文件**: `src/utils/ssrf.ts`、`src/tools/WebFetchTool/index.ts`、`src/utils/ssrf.test.ts`（新建——当前零直测）。**验证**: 非法 URL 被拒；`http://[::1]`、`http://2130706433`（WHATWG 归一化后）仍被拦；新增 ssrf.test.ts 直测覆盖全部地址段。

### H3+H4: 依赖治理快赢（幽灵依赖 + engines 矛盾）
**证据**: `wrap-ansi`（ChatMessagesView.tsx:4）、`ws`（im/adapters/feishu.ts:277）未声明；ink@7.1.0 engines 要求 node>=22，项目 engines `>=20` 且 CI matrix 含 20.x。
**方案**: ① `npm i wrap-ansi ws`（或精确版本对齐传递树）；② engines 升 `>=22`，CI matrix 移除 20.x（保留 22/24）；③ README Prerequisites 同步。**文件**: `package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`README.md`。**验证**: `npm ls --depth=0` 无 unmet；`npm ls wrap-ansi ws` 显示为直接依赖；CI 20 腿移除。

### H5: MCP tool-bridge 跨信任边界校验
**证据**: `src/mcp/tool-bridge.ts:83` — 外部工具名 `mcp_${serverId}_${name}` 经 `as any` 强转 `ToolName`；:9-56 `jsonSchemaToZod` 产宽松 schema 无二次校验。
**方案**: ① 工具名白名单正则 `^mcp_[A-Za-z0-9_-]+$` 校验后再入注册表（不绕类型——构造校验函数返回 `ToolName`）；② 远端 schema 转换后对 `inputSchema` 套一层 `z.object({}).passthrough()` 最小形状校验 + 调用前 `safeParse`；③ 失败时拒绝注册并 `logger.mcp.warn`。**文件**: `src/mcp/tool-bridge.ts` + `test/mcp/tool-bridge.test.ts`。**验证**: 恶意工具名（含路径分隔符/超长）被拒；schema 缺失时注册失败可观测。

### H6: QueryEngine 6 个零直测子模块补行为级测试
**证据**: `QueryEngine{Decision,Error,Events,Execution,Memory,Streaming,TurnControl}.ts` 零专属测试，仅在恒真桩编排测试中被间接执行（见 C4）。
**方案**: 每个子模块建 `test/query/QueryEngine<X>.test.ts`：用 MockLLMClient + MockExecutionEnv 驱动真实子模块（不 mock 被测对象），断言状态机转换与边界（错误分类→retry 决策、steer 队列排空时机、stream 事件序列、turn 延长条件）。**验证**: 7 个新测试文件；`npx vitest run test/query/` 全绿；对应文件覆盖率从间接转为直接。

### H7: orchestrator subprocess 后端补测（0% 安全面）
**证据**: `src/orchestrator/backends/subprocess.ts`（127 行）与 `subprocess-worker.ts`（54 行）clover 覆盖率 0%。
**方案**: 子进程 spawn/消息协议/超时/崩溃恢复的行为测试（真实 child_process + 临时脚本，不 mock worker）；权限级联传递断言。**验证**: 两文件覆盖率 ≥ 70%；`test/integration/multi-agent.test.ts` 回归绿。

### H8: AGP 进化循环去留决策与执行
**证据**: SEPL 闭环 ~2600 行零调用方；`onEvolve` 从未赋值；静态值图 19/28 agp 文件不可达；agp.strategies 覆盖率 0%。
**方案（决策记录先行）**:
- **方案 A（推荐）— 移除**：删除 SEPL 闭环与不可达文件（保留 registry/trace-manager/prompt-adapter 三个真实在用组件，见 Bootstrap.ts:378-416,552 与 instruction-surfaces.ts:17），README/AGENTS.md 的 AGP 表述降级为"演化基础设施（预留）"。理由：休眠代码是持续认知税与误信源。
- **方案 B — 接线**：为 `onEvolve` 提供真实赋值（config 门控 + 显式 CLI 开关），补端到端测试与文档。仅当自进化是 v3.3 路线图承诺时选择。
**验证**: 方案 A——`npx tsc --noEmit` 零错误；全量测试绿；`grep -rn "sepl" src` 仅剩有意保留项；包体积下降可测量。方案 B——新增 e2e 演化测试 + `--evolve` CLI 文档。

### H9: 死模块与 shim 删除轨道完成
**证据**: `src/memory/memoryConsolidation.ts`（~330 行）四导出零生产调用；`src/services/` 下 8 个 re-export shim 零引用（memoryExtraction/memoryConsolidation/consolidationScheduler/consolidationPrompts/extractionPrompts/memoryQuality/memory-extraction-guard/compaction.ts）。
**方案**: 删除死模块与 8 个 shim（shim 注释自称 "dual-track removal" 临时方案，轨道未走完）；`memoryConsolidation-coverage.test.ts` 一并删除；若 consolidation 是路线图功能，移入 `docs/specs/` 待建 spec 而非留在 src。**验证**: 全量测试绿；`grep -rn "services/memoryConsolidation\|services/compaction'" src test` 零命中；覆盖率数字变化记录进任务回写。

### H10: 文档对齐（AGENTS.md / README / repowiki）
**证据**: 11 providers→实际 3 类；prepare/finalize 声称（C1）；consolidation/auto-extraction 声称（H9）；"11 子模块"实际 13；"23 工具" manifest 实际 24 项；AGP/IM 无 repowiki 专篇。
**方案**: 逐条修正 AGENTS.md（blockedBy C1/H9 决策落地）；README Features 段同步；repowiki 补 AGP/IM 两篇（或明确标注"预留子系统"）；建立"文档-实现一致性检查"清单（provider 数、工具数、子模块数、钩子模型）纳入 PR 模板。**验证**: 新检查清单进 PR 模板；抽查 5 处声明与代码一致。

---

## 4. P2 修复方案

### M1: API 客户端样板合并
**证据**: 三客户端 `chat()/streamChat()` 归一化相似度 70-86%（OpenAICompatibleClient.ts:143-220 / AnthropicClient.ts:33-100 / OllamaClient.ts:27-87）；catch/finally 块逐字相同 ×3。
**方案**: `BaseApiClient` 增加 `protected async withChatErrorHandling(fn)` 与 `protected async *withStreamErrorHandling(gen)` 模板方法（统一 fetch→!ok→handleApiError→parse 与 catch-yield-finally-cancel）；三客户端只保留协议差异。**blockedBy T16**（先收敛容量表，避免把漂移合并进模板）。

### M2: 模型容量表单一事实源
**证据**: 三处并存（api/index.ts:44-94 / capabilities.ts:76+ / 两客户端 getModelInfo 硬编码）且已漂移——deepseek-v4-pro 131072 vs 128000。
**方案**: `capabilities.ts` 为唯一事实源；删除 index.ts 与客户端内的重复表，`getModelInfo` 改读 capabilities；加一致性单测（遍历 PROVIDER_MODELS ∩ PROVIDER_CAPABILITIES 断言数值相等）防再漂移。

### M3: Provider 扩展点单表收敛
**证据**: 新增 provider 需改 7 处（api/index.ts 联合类型/模型表/baseURL/key 校验/显示名 + config.ts:14 z.enum + cachePrefix.ts:219）。
**方案**: 定义 `PROVIDER_SPECS: Record<ProviderId, {baseUrl, models, keyPattern, displayName}>` 单表；联合类型、z.enum、校验、显示名全部派生（`z.enum(Object.keys(PROVIDER_SPECS) as [string, ...])`）；加"新增 provider 只改一处"的文档示例。

### M4: Protocol-first 补全（最小集）
**证据**: `AgentEvent` 在 state/types.ts 被 16 处直引；`api/protocol.ts:3-4` 反向依赖 query/tools；`im/protocol.ts:1` 反向引 QueryEngine。
**方案**: ① `AgentEvent` 迁入 `state/protocol.ts`（types.ts 保留 re-export 一个版本期）；② api/protocol.ts 的跨层类型改为结构化最小接口（只依赖消息形状，不 import query/tools 模块）；③ im/protocol.ts 同法解耦。不追求 85→0，先消灭 3 个反向依赖。

### M5: console.log 清洗（TUI 路径优先）
**证据**: 113 处 console.log；TUI 会话真实受害点 2 处：`memory/integration.ts:192`、`memory/memoryExtraction.ts:188`（post-turn 钩子）；main.ts 74 处属 REPL/CLI 合法输出。
**方案**: ① 两处 TUI 路径改 `logger.memory.*`；② `integration.ts` 5 处 console.warn 迁入结构化 logger；③ ESLint 规则 `no-restricted-syntax` 禁止 `src/query|src/memory|src/executors` 下 `console.log`（main.ts/commands 白名单）。

### M6: zodToJsonSchema 替换评估
**证据**: `src/utils/zodToJsonSchema.ts` 直捅 `_def` 内部 17 处；依赖树已有 zod-to-json-schema@3.25。
**方案**: 评估引入 `zod-to-json-schema`（已是传递依赖，升为直接依赖）替换手写实现；保留手写版一个版本期做 diff 快照测试后删除。

### M7: Coverage 阈值 ratchet 机制化
**证据**: vitest.config.ts:67-90 对 agp/im/commands/ui 设 40% "临时"阈值无收紧机制；agp.strategies 0%、orchestrator.backends 37.9%。
**方案**: ① CI 加 coverage-ratchet 脚本：读取上次基线 JSON，任何模块低于基线即失败，高于基线 1% 自动更新基线（提交回仓库）；② H6/H7/H9 落地后把 agp/im 阈值从 40% 提至 50%；③ 移除注释中"temporary"表述，改为 ratchet 说明。

### M8: BashTool/RunTool 共享逻辑提取
**证据**: ~60 行近似重复（windows find 兼容守卫、沙箱预包裹+HMAC、非零退出处理、危险命令检查，BashTool/index.ts:45-141 vs RunTool/index.ts:39-128）。
**方案**: 提取 `src/tools/shared/command-execution.ts`（4 个纯函数），两工具改为调用；行为测试保持各自套件不变。

### M9: 零引用导出清理
**证据**: `getDefaultBaseUrl`/`validateApiKeyFormat`/`getProviderDisplayName`（api/index.ts:177,183,214）、`getRecommendedTemperature`/`getCachingStrategy`（capabilities.ts:365,379）、`isTestCommandSafe` 等（QueryEngineVerification.ts:37,53,69）、`createBridgeWriter`、`renderMessageLines`、`defaultPermissionCheck`（Tool.ts:49）。
**方案**: 逐个确认后删除（或标注 @internal 保留一个版本期）；`knip` 引入 CI 做持续死导出检测（devDep，低频跑）。

---

## 5. P3 修复方案

### L1: QueryEngine 减负第一阶段（blockedBy H6）
**证据**: 1164 行 / 扇出 37 / 构造内 new 16 协作者 / 275 行状态机 switch 内嵌业务（zero-patch 门 537-558、AGP hook 574-601、post-turn hooks 605-610、steer 排空 619-627）。
**方案（仅第一阶段，不做大重构）**: 把 switch 内 4 段内嵌业务各提取为私有方法或并入对应子模块（TurnControl/RuntimeControl），构造函数 16 个 `new` 改为可选注入参数（默认值不变，测试可替换）。**前置**: H6 行为级测试就位，保证重构安全网。

### L2: AppRoot 拆分第一阶段（受 UI 红线约束）
**证据**: AppRoot.tsx 1255 行 / 50 hooks / `AppOpenCode` 组件函数 1042 行（:191）/ `toKeypressEvent` 嵌套 11 层（:162）。
**方案**: 按面板边界提取 3-4 个子组件（每步配 `test/ui/behavior/**` 行为级测试——红线要求）；`toKeypressEvent` 的 if/else 链改查表。**不做**: 状态管理架构变更（留待专项 spec）。

### L3: 命名规范统一
**证据**: 同目录 `tools.ts` vs `Tool.ts`；query/ 全 PascalCase vs state/ 混 camel+kebab；43 个 Manager/Service/Handler 后缀语义重叠。
**方案**: 制定命名决策表写入 AGENTS.md Conventions（文件按内容类型：类导出→PascalCase、纯函数→camelCase/kebab-case 二选一并按目录统一）；`Tool.ts`→`tool-factory.ts`（或反向，二选一）+ re-export 一个版本期。**不做**: 全仓库批量重命名（成本>收益），仅新代码强制。

### L4: 工程化门禁补齐
**证据**: 无 prepack/prepublishOnly（手工 publish 旧包风险）；CI 无 npm audit 步骤；无 changesets。
**方案**: ① `prepack: "npm run build && npm run typecheck"`；② CI 加 `npm audit --audit-level=high`（已知 MCP SDK 9 high 先建基线豁免清单，SDK 修复后移除）；③ 评估 changesets（决策记录即可，不强推）。

### L5: 依赖升级排期
**证据**: zod 锁 3.23.8（v3 线已到 3.25.76，v4 已稳定）；commander 落后 3 major；uuid 11→14；chalk 5→6；better-sqlite3 12→13。
**方案**: 本轮仅升 zod `^3.25`（补丁线内，配合 M6）；其余建 `docs/specs/dependency-upgrade-backlog.md` 排期（commander 12→13 需 CLI 参数行为回归测试）。**评估项**: SqlTool/better-sqlite3 改 optionalDependencies（发布成本）。

---

## 6. 实施进度追踪表

> 状态回写规则：任务完成后在 `audit-remediation-round3-tasks.md` 对应条目勾选 checklist 并更新本表。

| Phase | Task | 内容 | Priority | Status |
|-------|------|------|----------|--------|
| A | T01 | C1 幽灵钩子处置（决策+删除，方案 A 已执行） | P0 | ✅ completed 2026-08-23 |
| A | T02 | C2 SqlTool 白名单边界加固 | P0 | ✅ completed 2026-08-23 |
| A | T03 | C3 软跳过显式化 + CI sandbox job | P0 | ✅ completed 2026-08-23 |
| A | T04 | C4 恒真桩测试改造 | P0 | ✅ completed 2026-08-23 |
| B | T05 | H3+H4 幽灵依赖 + engines 对齐 | P1 | ✅ completed 2026-08-23 |
| B | T06 | H1 auto-commit 吞错 + 空 catch 清洗 | P1 | ✅ completed 2026-08-23 |
| B | T07 | H2 SSRF fail-open 收紧 + 直测 | P1 | ✅ completed 2026-08-23 |
| B | T08 | H5 tool-bridge 信任边界校验 | P1 | ✅ completed 2026-08-23 |
| C | T09 | H8 AGP 进化循环去留决策与执行（方案 A 已执行） | P1 | ✅ completed 2026-08-23 |
| C | T10 | H9 死模块 + 8 shims 删除 | P1 | ✅ completed 2026-08-23 |
| C | T11 | M9 零引用导出清理 | P2 | ✅ completed 2026-08-23 |
| D | T12 | H10 文档对齐（blockedBy T01/T09/T10） | P1 | ✅ completed 2026-08-23 |
| D | T13 | H6 QueryEngine 子模块补测 | P1 | ✅ completed 2026-08-23 |
| D | T14 | H7 subprocess 后端补测 | P1 | ✅ completed 2026-08-23 |
| E | T15 | M1 API 客户端样板合并（blockedBy T16） | P2 | ✅ completed 2026-08-23 |
| E | T16 | M2 模型容量表单一事实源 | P2 | ✅ completed 2026-08-23 |
| E | T17 | M3 provider 扩展点单表收敛 | P2 | ✅ completed 2026-08-23 |
| E | T18 | M4 protocol-first 最小补全 | P2 | ✅ completed 2026-08-23 |
| E | T19 | M8 BashTool/RunTool 共享提取 | P2 | ✅ completed 2026-08-23 |
| E | T20 | M7 coverage ratchet 机制化（blockedBy T04） | P2 | ✅ completed 2026-08-23 |
| F | T21 | M5 console.log 清洗 + lint 规则 | P2 | ✅ completed 2026-08-23 |
| F | T22 | M6 zodToJsonSchema 替换 | P2 | ✅ completed 2026-08-23 |
| F | T23 | L4 工程化门禁（prepack/audit/changesets） | P3 | ✅ completed 2026-08-23 |
| F | T24 | L1 QueryEngine 减负第一阶段（blockedBy T13） | P3 | ✅ completed 2026-08-23 |
| F | T25 | L2 AppRoot 拆分第一阶段 | P3 | ✅ completed 2026-08-23 |
| F | T26 | L3+L5 命名规范 + 依赖升级排期 | P3 | ✅ completed 2026-08-23 |

---

## 7. 全局验证与测试方案（门禁）

每个任务合并前必须通过；Phase 完成后跑全量：

1. **类型**: `npm run typecheck` 零错误（当前基线即零，不得回退）
2. **测试**: `npm test` 全绿；环境性失败基线 = 5（EROFS 只读 fs，见审计记录），不得超过
3. **覆盖率**: `npm run test:coverage` 全局 lines ≥ 60% / branches ≥ 50% / functions ≥ 60%；permissions ≥ 75/65/75/75；T20 落地后按 ratchet 基线
4. **安全回归**: `npx vitest run test/permissions test/services/sandbox-docker.test.ts src/permissions/security.test.ts` 全绿（权限/沙箱行为不得回归）
5. **静态断言**（按任务渐进收紧）:
   - T01 后: `grep -rn "as any).prepare\|as any).finalize" src` = 0
   - T02 后: SqlTool 穿越用例全绿
   - T03 后: `npx vitest run test/integration --reporter=verbose | grep -c "skipped"` ≥ 1（显式可见）
   - T10 后: `grep -rn "memoryConsolidation" src` = 0
   - T16 后: 容量一致性单测存在且绿
6. **UI 红线**: 涉及 UI 的任务（T25）每步必须配 `test/ui/behavior/**` 行为级测试；ESC 语义变更须更新 `esc-matrix.test.tsx`（本轮无 ESC 变更）
7. **文档一致性**: T12 后按新增检查清单抽查 5 处声明

## 8. 风险与回滚

- **T01 删除幽灵钩子**: 若后续需要 prepare 语义，按方案 B 重新实现（决策记录在案，成本可控）；删除路径无调用方，回归风险极低
- **T09 AGP 移除**: 先打 tag `pre-agp-removal`；保留组件（registry/trace-manager/prompt-adapter）有 Bootstrap 接线测试护航
- **T04 测试改造**: 分 5 个 PR 逐文件进行，每步覆盖率对比记录，防止"改造=掉覆盖"回退
- **T24/T25 大文件重构**: 严格第一阶段边界（只提取、不改行为），每步 typecheck + 全量测试 + behavior 测试三绿
