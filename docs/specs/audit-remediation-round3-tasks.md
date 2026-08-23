# kc-cli Audit Remediation Round 3 — Task List

> 依据：`docs/specs/audit-remediation-round3-spec.md` v1.0（2026-08-23）
> 铁律：每任务附行为级/单元测试；每任务完成后回写状态表与 Spec §6 进度追踪表；任意时刻至少一个任务处于 in_progress
> 状态图例：⬜ pending · 🔄 in_progress · ✅ completed · ⛔ blocked
>
> **ROUND 3 COMPLETE（2026-08-23）：T01–T26 全部 ✅。最终门禁：typecheck 零错误；全量测试 266 文件 / 4809 passed / 0 failed / 7 skipped（显式沙箱 e2e，HOME 重定向后 EROFS 环境性失败清零）；覆盖率 lines 81.65%（阈值 60%）。**

## 任务状态总表

| Task | 描述（imperative） | 对治 | Priority | Status | blockedBy | blocks |
|------|--------------------|------|----------|--------|-----------|--------|
| T01 | Resolve and remove ghost two-phase hooks | C1 | P0 | ✅ completed (2026-08-23) | — | T12 |
| T02 | Harden SqlTool path whitelist boundaries | C2 | P0 | ✅ completed (2026-08-23) | — | — |
| T03 | Make test soft-skips explicit and add CI sandbox job | C3 | P0 | ✅ completed (2026-08-23) | — | T20 |
| T04 | De-water tautological coverage tests | C4 | P0 | ✅ completed (2026-08-23) | T10 | T20 |
| T05 | Declare ghost dependencies and align engines | H3+H4 | P1 | ✅ completed (2026-08-23) | — | — |
| T06 | Surface silent auto-commit failures and clean empty catches | H1 | P1 | ✅ completed (2026-08-23) | — | — |
| T07 | Tighten SSRF fail-open and add direct tests | H2 | P1 | ✅ completed (2026-08-23) | — | — |
| T08 | Validate MCP tool-bridge trust boundaries | H5 | P1 | ✅ completed (2026-08-23) | — | — |
| T09 | Decide and execute AGP evolution-loop removal or wiring | H8 | P1 | ✅ completed (2026-08-23) | — | T12 |
| T10 | Remove dead memoryConsolidation module and shims | H9 | P1 | ✅ completed (2026-08-23) | — | T04, T12 |
| T11 | Clean zero-reference exports | M9 | P2 | ✅ completed (2026-08-23) | — | — |
| T12 | Align AGENTS.md/README/repowiki with implementation | H10 | P1 | ✅ completed (2026-08-23) | T01, T09, T10 | — |
| T13 | Add behavior tests for 6 untested QueryEngine submodules | H6 | P1 | ✅ completed (2026-08-23) | — | T24 |
| T14 | Add tests for orchestrator subprocess backends | H7 | P1 | ✅ completed (2026-08-23) | — | — |
| T15 | Consolidate API client chat/stream boilerplate | M1 | P2 | ✅ completed (2026-08-23) | T16 | — |
| T16 | Establish single source of truth for model capacity tables | M2 | P2 | ✅ completed (2026-08-23) | — | T15 |
| T17 | Collapse provider extension points into one spec table | M3 | P2 | ✅ completed (2026-08-23) | — | — |
| T18 | Repair protocol-first violations (minimal set) | M4 | P2 | ✅ completed (2026-08-23) | — | — |
| T19 | Extract shared command-execution helpers for BashTool/RunTool | M8 | P2 | ✅ completed (2026-08-23) | — | — |
| T20 | Mechanize coverage threshold ratcheting | M7 | P2 | ✅ completed (2026-08-23) | T03, T04 | — |
| T21 | Purge console.log from TUI paths and add lint guard | M5 | P2 | ✅ completed (2026-08-23) | — | — |
| T22 | Replace handwritten zodToJsonSchema | M6 | P2 | ✅ completed (2026-08-23) | — | — |
| T23 | Add engineering gates (prepack/audit/changesets) | L4 | P3 | ✅ completed (2026-08-23) | — | — |
| T24 | Slim QueryEngine (phase 1) | L1 | P3 | ✅ completed (2026-08-23) | T13 | — |
| T25 | Split AppRoot (phase 1, UI red-line compliant) | L2 | P3 | ✅ completed (2026-08-23) | — | — |
| T26 | Codify naming conventions and schedule dependency upgrades | L3+L5 | P3 | ✅ completed (2026-08-23) | — | — |

---

## 任务明细

### T01 — Resolve and remove ghost two-phase hooks（P0）✅ completed
- **描述**: Resolve the ghost prepare/finalize hooks by removing the dead probe paths from the tool executor. / **正在**: Resolving the ghost prepare/finalize hooks by removing the dead probe paths from the tool executor.
- **Spec**: round3-spec §2-C1（方案 A：删除）；关联 `architecture-hardening-spec.md`（工具执行模型）
- **Dependencies**: blockedBy: —（决策记录已随本 Spec 交付，故任务已启动）· blocks: T12
- **Checklist**:
  - [x] 删除 `toolExecutor.ts:389-411`（prepare 探测块）与 `:519-526`（finalize 探测块）
  - [x] `effectiveInput` 语义复核：删除后仅由 preToolUse 插件钩子（:373-387）产生
  - [x] `grep -rn "as any).prepare\|as any).finalize" src` 零命中
  - [x] AGENTS.md / README.md / docs/repowiki/Tools-System.md（含 Architecture.md 执行流、Home.md 索引）中 "two-phase execution" 表述同步修正
  - [x] `npx vitest run test/executors/` 全绿（4 文件 50 用例）；`two-phase.test.ts` 重写为 `toolExecutor-plugin-hooks.test.ts`（含"运行时杂散 prepare/finalize 属性不被探测"守卫用例）
  - [x] `npm run typecheck` 零错误

### T02 — Harden SqlTool path whitelist boundaries（P0）✅ completed
- **描述**: Harden the SqlTool ad-hoc path whitelist against prefix and traversal bypasses. / **正在**: Hardening the SqlTool ad-hoc path whitelist against prefix and traversal bypasses.
- **Spec**: round3-spec §2-C2
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `resolveAllowed` 改用 `path.resolve` + `base + path.sep` 边界匹配（isWithin 助手）
  - [x] 含 `..` 段的输入 fail-closed 拒绝（原始输入段检查 + resolve 后纵深防御；严格强于 spec 草图——resolve 会消解 `..` 导致 `/data/dbs/../dbs/x.db` 归一化后落回白名单内）
  - [x] target 与白名单条目 realpath 校验（tryRealpath best-effort，symlink 出界拒绝、界内 symlink 不误伤）
  - [x] 新增穿越用例 9 项 + call 层 1 项（sibling 前缀、`..` 三形态、cwd 相对穿越、精确边界、嵌套合法、真实 symlink 出界/界内、真实文件放行）
  - [x] SqlTool 套件 37 用例全绿；`test/permissions/` 257 用例回归全绿；typecheck 零错误

### T03 — Make test soft-skips explicit and add CI sandbox job（P0）✅ completed
- **描述**: Make soft-skipped integration tests explicit and guarantee sandbox e2e executes in CI. / **正在**: Making soft-skipped integration tests explicit and guaranteeing sandbox e2e executes in CI.
- **Spec**: round3-spec §2-C3
- **Dependencies**: blockedBy: — · blocks: T20（ratchet 基线需要真实 skipped 计数）
- **Checklist**:
  - [x] `sandbox-e2e.test.ts` 早退全部改 `it.skipIf`（探测+canary 提升为模块顶层同步 probe，收集期即可求值）
  - [x] `full-workflow.test.ts` 条件降级改顶部静态 import + `describe.skipIf`（导入失败=collection 响亮失败，注释已说明）；沙箱用例内部早退同样改 `it.skipIf`
  - [x] CI 增加 `sandbox-e2e` job（ubuntu-latest + bubblewrap，verbose reporter）
  - [x] verbose reporter 下 skipped 显式可见；本机基线：7 skipped（bwrap 在位但 canary 判定隔离受限）/ 30；`grep -c skipIf test/integration/{sandbox-e2e,full-workflow}.test.ts` = 11
  - [x] AGENTS.md Testing 段记录"软跳过禁令"（并预置 C4 安全关键模块 mock 禁令）

### T04 — De-water tautological coverage tests（P0）✅ completed
- **描述**: De-water the tautological coverage tests by converting or deleting mock-asserts-mock cases. / **正在**: De-watering the tautological coverage tests by converting or deleting mock-asserts-mock cases.
- **Spec**: round3-spec §2-C4
- **Dependencies**: blockedBy: T10（死模块测试随死代码先删）· blocks: T20
- **Checklist**:
  - [x] 五文件逐用例分类回写（KEEP/CONVERT/DELETE + 理由）：**删除 7 个纯桩断言水 case**（如"断言 estimateMessageTokensArray 被调用"），HEAD 74→67 用例；完整分类表见任务执行报告，关键项：
  - [x] 安全关键侧全部转真实实现：permissions/engine 六步 deny-first 真引擎 + SandboxManager 真实决策 + MockExecutionEnv——新增 4 个真实权限决策 case（alwaysDeny 政策拒绝、/etc/passwd 保护路径 ask→非交互 fail-safe 拒绝【bypass 已武装仍拒】、WebFetch 内网 SSRF 拦截、KC_ALLOW_BYPASS 未武装时 S3 全拒）；真实执行以 MockFS/MockShell 工件证明（PAYLOAD:done 跨轮穿透、种子文件内容、非零退出 stderr）
  - [x] memoryConsolidation-coverage.test.ts 已随 T10 删除
  - [x] AGENTS.md Testing 段禁令已立（T03 时预置："Mock ban for security-critical modules"）
  - [x] 覆盖率对比（同协议全量测量）：lines **81.54% → 81.60%**（+8 covered lines，删水不降反升）、branches 73.29→73.34%、functions 81.20→81.24%；远超 60% 阈值。修复了在制半成品 harness 的 vitest-4 mock 作用域缺陷（hoisted 导出/类构造器/bypass 门武装）

### T05 — Declare ghost dependencies and align engines（P1）✅ completed
- **描述**: Declare wrap-ansi/ws as direct dependencies and align engines with ink@7 requirements. / **正在**: Declaring wrap-ansi/ws as direct dependencies and aligning engines with ink@7 requirements.
- **Spec**: round3-spec §3-H3/H4
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `wrap-ansi@^10.0.0`、`ws@^8.21.0` 加入 dependencies（对齐传递树）
  - [x] `package.json` engines 改 `>=22`
  - [x] CI matrix 改 `[22.x, 24.x]`
  - [x] README Prerequisites 同步（两处 Node.js 20 → 22，注明 ink 7 要求与 EOL 理由）
  - [x] `npm ls --depth=0` 无 unmet/invalid；`npm ls wrap-ansi ws` 显示为直接依赖

### T06 — Surface silent auto-commit failures and clean empty catches（P1）✅ completed
- **描述**: Surface silent auto-commit failures and clean dangerous empty catches in integration periphery. / **正在**: Surfacing silent auto-commit failures and cleaning dangerous empty catches in integration periphery.
- **Spec**: round3-spec §3-H1
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 两处 auto-commit 空 catch 统一收敛到 `surfaceAutoCommitFailure()`：`logger.query.warn`（含 context+error）+ `getOperationAuditLog().record({tool:'git', isError:true, ...})`；审计自身 best-effort（bootstrap state 未初始化时不致断）
  - [x] 行为测试 `test/query/QueryEngineTurnControl-autocommit.test.ts`（3 用例）：git 注入失败 → 断言 warn 上下文、审计条目、stop 通知先于失败流出（turn 不中断）、成功路径对照（防过 mock）
  - [x] 外围清洗完成：mcp/transports/{stdio,http}、lsp/client、plugins/plugin-manager 全部改为带注释 best-effort 或 warn 日志
  - [x] **空 catch 新基线：67 → 41**（审计口径：空体或纯注释体；剩余 41 处全部带注释说明 best-effort 理由，裸空 catch = 0）

### T07 — Tighten SSRF fail-open and add direct tests（P1）✅ completed
- **描述**: Tighten the SSRF fail-open branch and add direct unit tests for isInternalUrl. / **正在**: Tightening the SSRF fail-open branch and adding direct unit tests for isInternalUrl.
- **Spec**: round3-spec §3-H2
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] WebFetchTool 对 unparseable URL 直接拒绝：新增 `assertFetchableUrl(): FetchabilityVerdict` 组合校验，call()/checkPermissions()/每个 redirect 跳全部走该门
  - [x] `utils/ssrf.ts` 保持纯函数；头注释声明"无 DNS 解析校验"威胁模型边界（rebinding/TOCTOU 为已接受局限）
  - [x] 新建 `src/utils/ssrf.test.ts`：90 直测（IPv4 全段含边界、IPv6 ::1/::/fc00::/7/fe80::/10、WHATWG 归一化 2130706433/0x7f000001/0177.0.0.1、非法输入、协议钉扎）；顺带修出 3 个真实绕过（IPv4-mapped IPv6、rooted FQDN `localhost.`、`::` 未指定地址）
  - [x] redirect 逐跳复查 5 用例保持绿（106/106，另加权限回归 279 绿——engine.ts 同样消费 isInternalUrl）
  - [x] **DNS lookup 复检方案评估结论**：列为 P2 跟进。词法校验已 fail-closed 但无法感知 DNS；内部域名→内网 IP 与 check/connect 间 TOCTOU 只有真实解析可关闭。实施位置限 WebFetchTool.call()（权限引擎 S4 路径必须保持同步）；dns.lookup(all:true) 全地址逐个过区段分类，任一命中内网即拒，自定义 lookup 回调把请求钉在已验证地址压缩 rebinding 窗口。成本：异步化/解析延迟/慢 DNS DoS 面。不混入本轮。

### T08 — Validate MCP tool-bridge trust boundaries（P1）✅ completed
- **描述**: Validate external MCP tool names and schemas at the trust boundary. / **正在**: Validating external MCP tool names and schemas at the trust boundary.
- **Spec**: round3-spec §3-H5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 工具名白名单正则 `/^mcp_[A-Za-z0-9_-]+$/` + ≤128 长度；类型化构造器 `toValidatedToolName(): ToolName | null`（buildTool 调用点零强转，唯一断言收敛在构造器内）
  - [x] `validateMCPInputSchema` 形状校验（object schema/properties/required、拒绝原型污染键与超长/空键）+ 转换后 ZodObject instanceof 复查 + 每次调用 safeParse 前置
  - [x] 全部拒绝路径 `logger.mcp.warn`（含 serverId/tool/reason 结构化上下文）
  - [x] 测试 353→~630 行：路径分隔符/`..`/unicode/控制字符/>128、缺 schema、畸形 schema、warn 可观测断言（spyOn 真实 logger 单例）、safeParse 拒绝、合法注册+执行端到端；153/153 绿
  - 备注：Bootstrap 未授权改动，拒绝表达为惰性 ToolDefinition（isEnabled=false 不入模型池 + call 返回注册被拒错误），净效果等同拒绝且保持单工具隔离

### T09 — Decide and execute AGP evolution-loop removal or wiring（P1）✅ completed
- **描述**: Decide the fate of the unreachable AGP evolution loop and execute removal or wiring. / **正在**: Deciding the fate of the unreachable AGP evolution loop and executing removal or wiring.
- **Spec**: round3-spec §3-H8（推荐方案 A：移除）
- **Dependencies**: blockedBy: — · blocks: T12
- **Checklist**:
  - [x] **决策记录：方案 A（移除）**——SEPL 闭环零调用方、onEvolve 从未赋值，休眠代码是持续认知税与误信源；自进化非 v3.3 路线图承诺，故不选 B
  - [x] 删除 SEPL 闭环及 18 个不可达文件（静态闭包分析：28→10）；保留 registry 链（含 context/dynamic/version-manager/server-interface/types）、trace-manager、prompt-adapter+protocol、**sepl/protocol.ts（有意保留：trace-manager.buildEvidenceBundle 与 failure-bridging 记忆桥的类型契约）**。删除清单见 git tag `pre-agp-removal` 后的 diff
  - [x] tag `pre-agp-removal` 已打（72a1f36）
  - [x] QueryEngine evolution hook 块与 protocol.ts `evolution?` 字段一并清理
  - [x] README（特性段+目录树）/AGENTS.md AGP 表述降级为"演化基础设施（预留）"；随删 7 个 SEPL 测试文件（acceptance-gate/candidate-lineage/evaluator-backend/evolution-loop-wiring/failure-signature/llm-proposer/evolution-gate-e2e）
  - [x] `tsc --noEmit` 零错误；全量测试 4677 passed / 2 failed（EROFS 环境性，基线内）/ 7 skipped；体积变化：净 -6212 行（src/agp 28 文件→10 文件 3580 行）

### T10 — Remove dead memoryConsolidation module and shims（P1）✅ completed
- **描述**: Remove the unreachable memoryConsolidation module and the 8 zero-reference shims. / **正在**: Removing the unreachable memoryConsolidation module and the 8 zero-reference shims.
- **Spec**: round3-spec §3-H9
- **Dependencies**: blockedBy: — · blocks: T04, T12
- **Checklist**:
  - [x] 删除 `src/memory/memoryConsolidation.ts`（零生产调用复核：仅 shim 与测试引用）
  - [x] 删除 8 个 shim（services/ 下全部 dual-track re-export）；连带删除仅被死模块消费的 consolidation 卫星真实模块（consolidationScheduler/consolidationPrompts/memoryQuality——生产零引用复核）
  - [x] 删除 `test/services/memoryConsolidation-coverage.test.ts`（及 memoryConsolidation/consolidationScheduler/consolidationPrompts/memoryQuality 四个配套测试）
  - [x] `grep -rn "services/memoryConsolidation\|services/compaction'" src test` 零命中；存活测试已重定向到真实路径（memory/memoryExtraction、memory/extractionPrompts、memory/memory-extraction-guard、services/compaction/functional，含 co-located compaction.test.ts）
  - [x] 待建条目已建：`docs/specs/memory-consolidation-pending.md`（重启前须回答的 5 个设计问题 + 删除清单考古入口）
  - [x] typecheck 零错误；test/services+test/memory 1161 passed / 2 EROFS 环境性失败（基线内）

### T11 — Clean zero-reference exports（P2）✅ completed
- **描述**: Clean zero-reference exports confirmed by the audit. / **正在**: Cleaning zero-reference exports confirmed by the audit.
- **Spec**: round3-spec §4-M9
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 10 个导出逐一处置（审计行号经 T16 重构后已漂移，按符号重定位）：**删除 6**（getDefaultBaseUrl/validateApiKeyFormat/getProviderDisplayName/getRecommendedTemperature/getCachingStrategy/defaultPermissionCheck）；**转私有 3**（isTestCommandSafe/isValidTestName/renderMessageLines——文件内有调用方）；**保留导出 1**（resolveTypeCheckCommand——审计漏检 test/query/typecheck-cross-platform.test.ts 直接引用，已记录）；createBridgeWriter 标 `@internal keep-until`（ui-event-system Phase 7 规划载体）
  - [x] 处置决策全部记录于任务回写与代码 JSDoc
  - [x] knip@6.32.2 devDep + `"knip"` script + knip.json；基线 docs/specs/knip-baseline.txt（101 unused exports / 131 unused types / 12 unused files——仅基线非门禁）
  - [x] typecheck 零错误；test/api 61/61 绿（组合跑中 coverage 文件失败属 T04 并发在制）

### T12 — Align AGENTS.md/README/repowiki with implementation（P1）✅ completed
- **描述**: Align AGENTS.md, README and repowiki claims with verified implementation. / **正在**: Aligning AGENTS.md, README and repowiki claims with verified implementation.
- **Spec**: round3-spec §3-H10
- **Dependencies**: blockedBy: T01（钩子模型定稿）、T09（AGP 表述定稿）、T10（consolidation 表述定稿）· blocks: —
- **Checklist**:
  - [x] AGENTS.md：API clients 行改"11 provider endpoints served by 3 client classes（其余 8 为 OpenAI-compatible 配置端点）"；子模块 11→**13**（补 Events/Verification）；Memory 行改"auto-extraction（consolidation parked → 待建 spec）"；AGP 行降级"演化基础设施（预留）"；Tools 行改单阶段执行模型
  - [x] prepare/finalize 表述与 T01 一致：AGENTS.md Key Types、README Features/索引、repowiki Tools-System（接口+执行流）/Architecture（执行管线）/Home（索引）全部修正，全仓 "two-phase" 零残留
  - [x] consolidation/auto-extraction 表述与 T10 一致：AGENTS.md/README 目录树/repowiki Memory-System（PARKED 标注+待建 spec 指针）
  - [x] repowiki Home.md 增"Reserved subsystems"节标注 AGP/IM 预留（spec 允许的标注方案）；README 目录树 agp 节同步 10 文件现状
  - [x] `.github/PULL_REQUEST_TEMPLATE.md` 新增文档-实现一致性检查清单（provider 数/工具数/子模块数/钩子模型/memory 表述/预留子系统 + 测试红线项）
  - [x] **5 处抽查（对最终代码状态复核）**：① api/index.ts 工厂=2 显式类分支+8 配置端点 ✓ ② TOOL_MANIFEST=23（21 目录+TeamCreate+LSP）✓——审计"manifest 实际 24"无法复现，维持 23 ③ QueryEngine*.ts 子模块=13 ✓ ④ 幽灵钩子 grep=0 ✓ ⑤ consolidation 模块=0 且 AGENTS.md 标注 parked ✓

### T13 — Add behavior tests for 6 untested QueryEngine submodules（P1）✅ completed
- **描述**: Add behavior-level tests for the six untested QueryEngine submodules. / **正在**: Adding behavior-level tests for the six untested QueryEngine submodules.
- **Spec**: round3-spec §3-H6
- **Dependencies**: blockedBy: — · blocks: T24
- **Checklist**:
  - [x] 七文件全部建成：QueryEngine{Decision(30),Error(26),TurnControl(30),Events(12),Execution(17),Memory(13),Streaming(16)}.test.ts，合计 **144 用例**
  - [x] 真实子模块驱动：直构 ErrorHandler/DecisionGates/afterStreamingTurn/MemoryHandler/streamLLMTurn 等，仅 process 边界（git、LLM transport、verification runner）用替身——遵守 C4 安全关键模块 mock 禁令；Memory 用例走 os.tmpdir 真实盘往返
  - [x] 边界覆盖：429/Retry-After/超时/网络错→retry 决策矩阵 + 断路器开闭半开；steer/followUp 中途入队→安全点排空（真实 QueryEngine 端到端时序）；stream 事件顺序/中断回退/abort 配对修复；turn 延长（+20 上限/天花板/停机提交）；zero-patch/类型检查/测试验证三门预算耗尽
  - [x] `npx vitest run test/query/` 406 用例全绿
  - [x] 直接覆盖转换记录：七个子模块文件从仅恒真桩间接执行转为专属行为套件直接覆盖（Decision/Error/TurnControl 0→直接，其余同）；该安全网随后护航了 T24 重构的零断言改动证明

### T14 — Add tests for orchestrator subprocess backends（P1）✅ completed
- **描述**: Add tests for the zero-coverage orchestrator subprocess backends. / **正在**: Adding tests for the zero-coverage orchestrator subprocess backends.
- **Spec**: round3-spec §3-H7
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 双层测试：`test/orchestrator/backends-subprocess.test.ts`（真实 child_process fork + 真实 worker 脚本 + 临时目录，11 用例：spawn/init 握手/消息协议往返/timeoutSeconds 超时 SIGKILL 升级/FUN-01 ready 兜底/worker 中途崩溃后父进程存活/权限模式+config+cwd 经 IPC 传递）+ `backends-subprocess-worker.test.ts`（进程内驱动真实 worker 模块，14 用例：init/message/shutdown 协议、事件中继与计数、错误帧含 stack、优雅/强制关机、uncaught/rejection 路径；仅 QueryEngine 缝合处用 Fake——C4 规约合规）
  - [x] spawn/消息协议/超时/崩溃恢复全覆盖（含 late-init-after-shutdown 不泄漏帧的自包含用例——修复了模块级 aborted 标志跨用例泄漏的测试缺陷）
  - [x] 权限级联断言与 multi-agent.test.ts cascader 风格一致
  - [x] 覆盖率：subprocess.ts **96.06%** lines / subprocess-worker.ts **98.14%** lines（远超 ≥70% 门）；multi-agent.test.ts 27 用例回归绿

### T15 — Consolidate API client chat/stream boilerplate（P2）✅ completed
- **描述**: Consolidate the triplicated chat/streamChat boilerplate into BaseApiClient template methods. / **正在**: Consolidating the triplicated chat/streamChat boilerplate into BaseApiClient template methods.
- **Spec**: round3-spec §4-M1
- **Dependencies**: blockedBy: T16（先收敛容量表，避免合并漂移）· blocks: —
- **Checklist**:
  - [x] 模板方法落地：`withChatErrorHandling(op, ApiRequestInit, parse, failureContext?)` 统一 fetch→!ok→handleApiError→parse + 单点 catch 重包（保留历史双包裹语义）；`withStreamErrorHandling` 统一 fetch→!ok→body-null 守卫→yield* 帧 + catch-yield-finally-cancel 尾声
  - [x] 三客户端只留协议差异：OpenAI（key 守卫/buffer 复位/SSE 头）、Anthropic（/v1/messages+SSE 头）、Ollama（裸头无 Authorization/无 key 守卫/自定义 failureContext/NDJSON）；错误文案逐字节等价
  - [x] catch-yield-finally-cancel 归一 3→1；客户端合计 -90 行重复（Base +100 可复用）
  - [x] 零断言改动证明：test/api 18 文件 354 用例全绿（含双包裹/流错误/null-body/abort 透传/header 捕获钉住断言）；readStreamFrames 及各帧解析器 git diff 无改动；lint 0 errors

### T16 — Establish single source of truth for model capacity tables（P2）✅ completed
- **描述**: Establish capabilities.ts as the single source of truth for model capacity data. / **正在**: Establishing capabilities.ts as the single source of truth for model capacity data.
- **Spec**: round3-spec §4-M2
- **Dependencies**: blockedBy: — · blocks: T15
- **Checklist**:
  - [x] 裁决 deepseek-v4-pro：以 capabilities.ts 的 131072 为准（与 DeepSeek 官方 128K 上下文声明对齐取 Kib 精确值；漂移源是 api/index.ts 旧表的四舍五入副本）
  - [x] api/index.ts 重复表删除（85 行→re-export）；OpenAICompatible/Anthropic getModelInfo 改读 `getCapabilities`（OllamaClient 原本即无表）
  - [x] 一致性单测 `src/api/capabilities-consistency.test.ts`：15 用例——交集数值相等 + maxOutput≤maxContext 合理性锁 + 客户端 getModelInfo 与 capabilities 相等断言（防再漂移）
  - [x] test/api 全绿

### T17 — Collapse provider extension points into one spec table（P2）✅ completed
- **描述**: Collapse the seven provider extension points into a single PROVIDER_SPECS table. / **正在**: Collapsing the seven provider extension points into a single PROVIDER_SPECS table.
- **Spec**: round3-spec §4-M3
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `PROVIDER_SPECS`（新文件 src/api/provider-specs.ts，零 import）：baseUrl/displayName/keyPattern（prefix|minLength|none 判别联合）；models 保持 T16 的 capabilities 单源不折入
  - [x] 全部派生：ProviderId 联合=keyof、z.enum=PROVIDER_IDS（保持历史顺序连报错文案都不变）、key 校验表驱动（11 provider 报文逐字节等价）、显示名入行数据、cachePrefix 分支删除改读 capabilities.prefixCachingStrategy（避免第二事实源，环检测通过）；工厂 switch 保留（类选择是真每商逻辑）
  - [x] bootstrap/config.ts、utils/api-key.ts、services/cachePrefix.ts 全部改读派生值
  - [x] docs/guides/api-clients.md 新增"新增 provider 只改一处"章节（推导表+单行 diff 示例）
  - [x] 行为不变证明：provider-specs.test.ts 14 用例钉住历史字面量（枚举顺序/baseUrl 映射/校验矩阵/缓存策略/config 接受集）；test/api+bootstrap+src/api 469 用例绿

### T18 — Repair protocol-first violations (minimal set)（P2）✅ completed
- **描述**: Repair the three reverse protocol dependencies in the minimal protocol-first set. / **正在**: Repairing the three reverse protocol dependencies in the minimal protocol-first set.
- **Spec**: round3-spec §4-M4
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `AgentEvent`+`MultiAgentEvent` 定义迁入 `state/protocol.ts`；events.ts re-export 一个版本期（type-only 双向环，运行时擦除）
  - [x] `api/protocol.ts` 改结构化镜像（ApiChatMessage/ApiToolCall/ApiToolResultEntry/ApiToolSpec），零 query/tools import；4 客户端在边界显式收窄回具体形状（客户端内部注解属 85 直引基线，不在最小集）；新增编译期兼容守卫 `test/api/protocol-decoupling.test.ts`（含静态检查：协议模块禁止 query/tools import）
  - [x] `im/protocol.ts` 以 `IMQueryEngineLike`/`IMEngineEvent` 结构面替代 QueryEngine 具体类；im-bridge 消费方同步改型
  - [x] 回归全绿：test/state+api 391 用例、test/im 26 文件、test/query 404 用例（coverage 在制文件除外）、test/QueryEngine.test.ts 65 用例（顺带修复其动态 import 已删 shim 的 T10 漏网）
  - [x] 基线记录：跨模块 protocol 直接引用方 106 个非协议文件（不追求清零）

### T19 — Extract shared command-execution helpers for BashTool/RunTool（P2）✅ completed
- **描述**: Extract the shared command-execution helpers duplicated by BashTool and RunTool. / **正在**: Extracting the shared command-execution helpers duplicated by BashTool and RunTool.
- **Spec**: round3-spec §4-M8
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 新建 `src/tools/shared/command-execution.ts`：4 个纯函数（windows find 守卫 / 沙箱预包裹+HMAC 校验 / 非零退出处理 / 危险命令检查），依赖注入无 I/O
  - [x] BashTool 与 RunTool 改调共享实现（各 -77/+77 行重排，净 -26 行重复）
  - [x] 行为不变证明：`src/tools/shared/command-execution.test.ts`（新）+ test/tools/BashTool* + RunTool 套件 **38 用例全绿且零断言修改**
  - [x] 安全回归：test/permissions + security.test.ts + sandbox-docker 297 用例全绿；typecheck 零错误

### T20 — Mechanize coverage threshold ratcheting（P2）✅ completed
- **描述**: Mechanize coverage threshold ratcheting so red-zone modules cannot regress silently. / **正在**: Mechanizing coverage threshold ratcheting so red-zone modules cannot regress silently.
- **Spec**: round3-spec §4-M7
- **Dependencies**: blockedBy: T03（skipped 基线）、T04（去水后数字可信）· blocks: —
- **Checklist**:
  - [x] `scripts/coverage-ratchet.mjs`：读 coverage-summary.json 按模块聚合 lines；低于基线 exit 1 列出回归、高 ≥1pp 自动抬升基线并提示提交；CI 已接（test job 22.x 主干腿，`coverage:ratchet` script）
  - [x] 阈值校准：im 40→50 ✓（实测 L71/B51）；**agp 无法到 50——T09 删除了给它续命的 SEPL 测试，保留基础设施真实覆盖仅 L23.7/B17.4**，按审计精神设诚实下限（23/17/22/22）而非回退化妆数字，交由 ratchet 抬升
  - [x] vitest.config.ts "temporary" 注释移除，改为 ratchet 机制说明 + agp 下限来源注记
  - [x] `scripts/coverage-baseline.json` 入库：21 个模块首版数值（agp 23.74 即原"agp.strategies 0% 现状"的继承者——strategies 目录已随 SEPL 删除）
  - 备注：发现 HOME 重定向（可写盘）可消除全部 EROFS 环境性失败——FileMemoryService 的 /root/.kc-cli 写入是只读 HOME 的伪故障

### T21 — Purge console.log from TUI paths and add lint guard（P2）✅ completed
- **描述**: Purge console.log from live TUI paths and add an ESLint guard for hot modules. / **正在**: Purging console.log from live TUI paths and adding an ESLint guard for hot modules.
- **Spec**: round3-spec §4-M5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 两文件 TUI 路径全部迁入 `logger.memory.*`（含 integration.ts 6 处 warn/info 与 memoryExtraction.ts 4 处，附带清掉 3 处 console.error——两文件现零 console.*）
  - [x] ESLint flat-config override：query/memory/executors 下 `console.log` = error（带 TUI 撕裂原因说明；main.ts/commands 天然在范围外）
  - [x] `npm run lint` 0 errors；`test/ui/behavior/` 68 用例基线回归绿

### T22 — Replace handwritten zodToJsonSchema（P2）✅ completed
- **描述**: Replace the handwritten zodToJsonSchema with the maintained zod-to-json-schema package. / **正在**: Replacing the handwritten zodToJsonSchema with the maintained zod-to-json-schema package.
- **Spec**: round3-spec §4-M6
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `zod-to-json-schema@^3.25.2` 直接依赖 + zod `^3.25.76`（同 PR；engines/wrap-ansi/ws/prepack 完好）
  - [x] 迁移前先冻结旧输出：`test/utils/fixtures/zod-json-schema-legacy-v1.json`（23 工具全量）+ `zodToJsonSchema-migration.test.ts` 内嵌旧实现逐字副本，live≡legacy 经 6 项 allow-list 裁决（$schema 注入/additionalProperties:false/描述全节点保留——修复旧丢描述 bug/oneOf→anyOf/draft-07 nullability/根可选渲染）+ 描述超集守卫
  - [x] 手写实现删除：`_def` 直捅 46 → **0**；唯一消费方 BaseApiClient:296 签名不变零改动
  - [x] 回归绿：test/mcp 153、test/api 304、test/utils+tools+registry 330、迁移套件 78；typecheck 零错误
  - 备注：原 zodToJsonSchema-coverage.test.ts 钉住已删实现的内部怪癖，期望值机械迁移至维护包语义（构造清单不变，73 用例保留）

### T23 — Add engineering gates (prepack/audit/changesets)（P3）✅ completed
- **描述**: Add engineering gates for packaging, auditing and changelog automation. / **正在**: Adding engineering gates for packaging, auditing and changelog automation.
- **Spec**: round3-spec §5-L4
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `prepack: "npm run build && npm run typecheck"` 已加入 package.json
  - [x] CI test job 加入 `npm audit --audit-level=high` 门禁。**豁免清单：不需要**——执行 `npm audit fix` 后 6 个 high（fast-uri/hono/ip-address/nanoid/postcss/vite，含原 MCP SDK 链）全部经非破坏性传递版本升级清零，现基线 0 high / 1 low；CI 步骤注释记录该基线与"失败时加豁免、不得删门禁"的规约
  - [x] **changesets 评估结论：不采纳（本轮）**——单包仓库、发版节奏低频、CHANGELOG.md 手工维护已够用；changesets 的多包协调与 PR 驱动 changelog 价值在 monorepo/高频发布场景。若 v3.3 起进入周级发版或拆包，重评

### T24 — Slim QueryEngine (phase 1)（P3）✅ completed
- **描述**: Slim QueryEngine phase 1 by extracting embedded state-machine business logic. / **正在**: Slimming QueryEngine phase 1 by extracting embedded state-machine business logic.
- **Spec**: round3-spec §5-L1
- **Dependencies**: blockedBy: T13（行为安全网先行）· blocks: —
- **Checklist**:
  - [x] switch 内嵌业务提取为私有方法：`zeroPatchExhaustedEvent()`（zero-patch 门）/ `dispatchPostTurnHooks()` / `drainFollowUpsIntoConversation()` / `drainSteersIntoConversation()`；AGP hook 已随 T09 删除无需处理。switch 跨度 ~235→~200 行
  - [x] 构造函数 17 个硬 `new` 协作者全部改可选注入（导出 `QueryEngineDeps`，`d.X ?? new X(...)` 默认逐字节一致，含 3 个字段初始化器上提）；apiClient 工厂与 AbortController 按设计保留非注入
  - [x] 行为零变化证明：安全网 test/query(排除 coverage 在制文件)+test/executors **前后均 454/454 绿，零断言改动**
  - [x] 度量：行数 1136→1224（+88 = DI 接口与文档注释）；扇出 39/39 不变；引用方 27→27

### T25 — Split AppRoot (phase 1, UI red-line compliant)（P3）✅ completed
- **描述**: Split AppRoot phase 1 along panel boundaries with behavior tests per step. / **正在**: Splitting AppRoot phase 1 along panel boundaries with behavior tests per step.
- **Spec**: round3-spec §5-L2；红线约束见 AGENTS.md UI red lines
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 面板提取：新建 `src/ui/panels/{TranscriptPanel,ComposerPanel}.tsx`（对话区+输入槽；props 纯下行、无新 store/context）——其余内联面板（Header/Sidebar/SessionInfo/StatusBar/ChatPanel/Editor）在先前轮次已是独立组件，剩余内联仅为薄槽位接线，强行再包装属仪式性拆分，故为 2 个新组件并如实记录（偏离 spec 的 3-4 区间下沿）
  - [x] 每组件配行为级测试：`test/ui/behavior/{transcript-panel,composer-panel}.test.tsx` 经 harness 渲染真实 AppRoot（回显/退格/尾反斜杠续行不提交/组合提交全文）
  - [x] `toKeypressEvent` if/else 链改 `KEY_FLAG_NAMES` 优先级查表（首匹配胜出，优先序与原链一致）；ESC 路径未动，esc-matrix 绿
  - [x] 不改状态管理架构 ✓；红线全绿：test/ui 全套 **431 用例**（含 layout/layout-anchor/dead-path-guard/esc-matrix）通过；typecheck 零错误
  - 备注：修复了中断代理遗留的三处问题（AppRoot 内调试 console.error、与既有 1 行滑窗渲染矛盾的测试断言、isSteerMode 可选类型边界）

### T26 — Codify naming conventions and schedule dependency upgrades（P3）✅ completed
- **描述**: Codify naming conventions and schedule the dependency upgrade backlog. / **正在**: Codifying naming conventions and scheduling the dependency upgrade backlog.
- **Spec**: round3-spec §5-L3/L5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 命名决策表写入 AGENTS.md Conventions（类导出→PascalCase、纯函数文件→目录内单一风格、协议契约恒为 protocol.ts、Manager/Service/Handler 新代码按主导动词选后缀）
  - [x] `Tool.ts` 裁决：**保留原名**——buildTool 被 20+ 工具文件引用，改名成本>收益（与 spec "不做全仓库批量重命名"一致；保留即无需 re-export 过渡）
  - [x] `docs/specs/dependency-upgrade-backlog.md` 已建：zod v4 / commander 13（先建 CLI 参数回归套件）/ uuid 14 / chalk 6 / better-sqlite3 13 排期与风险
  - [x] SqlTool/better-sqlite3 optionalDependencies 评估：**不采纳**——懒加载已在 manifest 层解决启动成本；npm ci 静默跳过语义劣化故障诊断；终局方案是拆独立插件包（详见 backlog 文档）

---

## 门禁（每任务合并前）

- `npm run typecheck` 零错误（基线即零，不得回退）
- `npm test` 全绿；环境性失败基线 = 5（EROFS 只读 fs），不得超过
- 涉权限/沙箱的任务（T02/T08/T19）加跑：`npx vitest run test/permissions src/permissions/security.test.ts test/services/sandbox-docker.test.ts`
- 涉 UI 的任务（T21/T25）加跑：`npx vitest run test/ui/behavior/`
- 静态断言随任务收紧（见 spec §7.5）
- 完成后：回写本表 Status + Spec §6 进度追踪表 + 完成日期
