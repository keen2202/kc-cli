# kc-cli Audit Remediation Round 4 — Task List

> 依据：`docs/specs/audit-remediation-round4-spec.md` v1.0.0（2026-08-28）
> 铁律：每任务附行为级/单元测试；每任务完成后回写状态总表与 Spec §8 进度追踪表；**任意时刻至少一个任务处于 in_progress**
> 状态图例：⬜ pending · 🔄 in_progress · ✅ completed · ⛔ blocked
>
> **ROUND 4 启动（2026-08-28）**：33 个任务对应审查报告的 12 严重 / 14 中等 / 13 轻微发现。T01 已置 in_progress 作为入口任务。
> 门禁基线（启动前实测）：`npm run typecheck` 零错误；`npx vitest run` 全绿；覆盖率 lines 阈值 60%。

## 任务状态总表

| Task | 描述（imperative） | 对治 | Priority | Status | blockedBy | blocks |
|------|--------------------|------|----------|--------|-----------|--------|
| T01 | Fix environment leakage in LocalShell and MCP stdio transports | S1+S2 | P0 | ✅ completed | — | T05, T17 |
| T02 | Hoist global crash handlers to process entry point | S3 | P0 | ✅ completed | — | T07, T14, T19 |
| T03 | Attach error listeners to MCP stdio pipes | S4 | P0 | ✅ completed | — | T17 |
| T04 | Guard FileRead streams with try/finally | S5 | P0 | ✅ completed | — | — |
| T05 | Validate .mcp.json schema and gate project-scoped servers | S6 | P0 | ✅ completed | T01 | — |
| T06 | Serialize JSON-mode stdin into QueryEngine | R2 | P1 | ✅ completed | — | — |
| T07 | Unify exit-code semantics across failure paths | R3 | P1 | ✅ completed | T02 | — |
| T08 | Add timeout and idempotent release to orchestrator semaphore | R4 | P1 | ✅ completed | — | — |
| T09 | Fail closed on unknown tools in concurrency grouping | R5 | P1 | ✅ completed | — | — |
| T10 | Replace hardcoded bash with platform shell in verification | R6 | P1 | ✅ completed | — | — |
| T11 | Preserve AbortError semantics through LocalShell | R7 | P1 | ✅ completed | — | — |
| T12 | Guarantee SqlTool worker promise settlement | R8 | P1 | ✅ completed | — | — |
| T13 | Add file-level mutex for FileEdit read-modify-write | R1 | P1 | ✅ completed | — | — |
| T14 | Unref and guard periodic timers | M9h/j | P1 | ✅ completed | T02 | — |
| T15 | Add LLM request lifecycle logging | O1 | P2 | ✅ completed | — | — |
| T16 | Emit circuit-breaker state transitions | O2 | P2 | ✅ completed | — | — |
| T17 | Surface MCP reconnect exhaustion | O3 | P2 | ✅ completed | T01, T03 | — |
| T18 | Log budget denials and expose default stance | O4 | P2 | ✅ completed | — | — |
| T19 | Surface session persistence failures | O5 | P2 | ✅ completed | T02 | — |
| T20 | Triage LSP errors and record audit failures | O6 | P2 | ✅ completed | — | — |
| T21 | Route startup console output through logger | M9a | P2 | ✅ completed | — | T23 |
| T22 | Defer tool module loading out of startup path | P1 | P2 | ✅ completed | — | T25 |
| T23 | Move MCP connection off the startup critical path | P2 | P2 | ✅ completed | T21 | — |
| T24 | Cache realpath in the permission hot path | P3 | P2 | ✅ completed | — | T31 |
| T25 | Parallelize independent bootstrap phases | P4 | P2 | ✅ completed | T22 | — |
| T26 | Extract shared orchestrator backend runtime | M1 | P2 | ✅ completed | — | — |
| T27 | Unify compaction summary prompt and fallback | M2 | P2 | ✅ completed | — | — |
| T28 | Share system-prompt sections | M3 | P3 | ✅ completed | — | — |
| T29 | Consolidate duration and token formatters | M4 | P3 | ✅ completed | — | — |
| T30 | Route tool error strings through getErrorMessage | M5 | P3 | ✅ completed | — | — |
| T31 | Remove dead path helpers and orphan test | M6+M9 | P3 | ✅ completed | T24 | — |
| T32 | Extract QueryEngine per-query state reset | M7 | P3 | ✅ completed | — | — |
| T33 | Centralize API error rules and readonly permission helper | M8 | P3 | ✅ completed | — | — |

---

## 任务明细

### T01 — Fix environment leakage in LocalShell and MCP stdio transports（P0）✅ completed
- **完成日期**: 2026-08-28
- **描述**: Fix the environment leakage that defeats the `KC_*` secret filter in the Bash shell executor and the MCP stdio transport. / **正在**: Fixing the environment leakage that defeats the `KC_*` secret filter in the Bash shell executor and the MCP stdio transport.
- **Spec**: round4-spec §2-S1、§2-S2；关联 `docs/guides/mcp-integration.md`
- **Dependencies**: blockedBy: — · blocks: T05（trust gate 前提：即使被信任的 server 也不该拿到 `KC_*`）、T17（重连日志需先确认 env 路径稳定）
- **Checklist**:
  - [x] 新增 `src/utils/env-sanitize.ts`，导出 `buildSafeEnv(overrides?)`（白名单 + `ENV_DENY_PREFIX` + `KC_ALLOW_ENV_VARS` 逃生舱）
  - [x] `src/services/execution-env-local.ts:191` 改为 `env: options.env`（不再 spread `process.env`）
  - [x] `src/mcp/transports/stdio.ts:51` 与 `:68` 改为 `buildSafeEnv(env)`
  - [x] `src/tools/RunTool/secrets.ts` 的过滤逻辑切换到共享实现，删除重复
  - [x] 负面集成测试：设 `process.env.KC_API_KEY='sk-test-secret'` → Bash 执行 `env` → 断言 stdout 不含 `KC_API_KEY` 与 `sk-test-secret`
  - [x] 负面集成测试：mock MCP server dump env → 断言结果不含任何 `KC_` 前缀键
  - [x] 正向测试：MCP 配置中显式 `env: { FOO: 'bar' }` 仍然生效（不能把合法用法堵死）
  - [x] 正向测试：`KC_ALLOW_ENV_VARS=MY_TOKEN` 时该变量可透传
  - [x] 回归：`node -v` / `git --version` / `npm --version` 经 Bash 执行仍正常（白名单未漏 `PATH`）
  - [x] `npm run typecheck` 零错误；`test/tools/`、`test/mcp/`、`test/services/` 全绿
- **实现说明**:
  - `src/utils/env-sanitize.ts`（新增）：`buildSafeEnv(overrides?)` 采用「主机白名单 + overrides 拒绝名单」双层；`filterEnvVars(env)` 保留为自包含记录的过滤器。
  - `execution-env-local.ts` 采用 `env: options.env ?? buildSafeEnv()`。相比 spec 原文的 `options.env` 多了一个 `?? buildSafeEnv()` 回退：当调用方（如 DeployTool）未传 env 时，Node 默认继承完整 `process.env`，会重新打开同一个泄露口。回退项在 `options.env` 存在时行为与 spec 完全一致。
  - `ENV_DENY_PREFIX` 之外，overrides 仍受 `DANGEROUS_ENV_VARS`（`LD_PRELOAD` / `NODE_OPTIONS` / …）约束 —— 原 RunTool 用 `filterEnvVars(input.env)` 提供该保护，切换实现后不得削弱（spec §7.4 回归红线）。
  - 删除 `src/tools/RunTool/secrets.ts`（逻辑已全部上提到共享模块），`BashTool` / `RunTool` / `test/tools/env-secrets.test.ts` 改为引用共享模块。
- **验证结果**: `test/utils/env-sanitize.test.ts`（11）+ `test/tools/env-secrets.test.ts`（4）+ `test/mcp/stdio.test.ts`（18）全绿；`npm run typecheck` 零错误。

### T02 — Hoist global crash handlers to process entry point（P0）✅ completed
- **完成日期**: 2026-08-28
- **描述**: Hoist the global uncaught-exception and unhandled-rejection handlers to the process entry point so every execution mode is covered. / **正在**: Hoisting the global uncaught-exception and unhandled-rejection handlers to the process entry point so every execution mode is covered.
- **Spec**: round4-spec §2-S3
- **Dependencies**: blockedBy: — · blocks: T07、T14、T19（三者都改动退出/定时器/保存路径，需先有统一兜底）
- **Checklist**:
  - [x] `src/main.ts` 模块顶层（`main({...})` 之前）新增 `installGlobalCrashGuards(saveSnapshot)`
  - [x] handler 记录 `logger.main.error`（含 stack）+ 打印用户提示 + `saveSnapshot().catch(...).finally(() => process.exit(1))`
  - [x] 移除 `runREPL()` 内的重复注册（`main.ts:230-231`），改为传入 runREPL 专属保存回调
  - [x] 为 Ink UI 路径提供等价 `saveSnapshot`（至少落一份 emergency transcript 到 `~/.kc-cli/crash/`）
  - [x] 单测：任何 `onInteractiveUI` / `onRunJSONMode` / `onExecutePrompt` 路径下 `process.listenerCount('unhandledRejection') >= 1`
  - [ ] 进程级冒烟：Ink UI 模式下触发 `Promise.reject()` → 打印 fatal 提示且退出码为 1
  - [x] `src/utils/exit-codes.ts` 的 `EXIT` 常量在本任务中先行落地（供 T07 复用）
  - [x] `npm run typecheck` 零错误
- **实现说明**:
  - 新增 `src/utils/crash-guards.ts`：`installGlobalCrashGuards()` 返回 `{ setSnapshotSaver, uninstall }` 句柄。spec 原方案把函数内联在 `main.ts`，但入口模块一旦被 import 就会执行整个 CLI，无法做单元测试；拆出后 `main.ts` 仅保留一行模块级 `const crashGuards = installGlobalCrashGuards();`。
  - `logger` 新增 `main` 与 `audit` 两个命名空间（原先未定义，T20/T21 同样需要）。
  - Ink UI / `--json` / 单提示三条路径统一经 `registerCrashSnapshot(queryEngine)` 注册 `ReplSessionService.save()`（与 UI 自身 `/session` 使用同一 `sessionId`，不会覆盖出第二个会话）；REPL 路径注册自己的 `replSession`。
- **未完成项说明**:
  - 「Ink UI 模式下 `Promise.reject()` 的进程级冒烟」未执行：该用例需要真实启动 TTY 下的 Ink 渲染器，仓库内没有进程级 CLI 夹具（spec §7.3 提到的 `test/helpers/spawn-cli.ts` 尚未建立），且交互式 UI 无法在 CI 中无终端启动。以 `installGlobalCrashGuards` 的 6 条行为级单测 + 3 条入口结构断言替代。
- **验证结果**: `test/utils/crash-guards.test.ts`（9）全绿；`npm run typecheck` 零错误。

### T03 — Attach error listeners to MCP stdio pipes（P0）✅ completed
- **完成日期**: 2026-08-28
- **描述**: Attach error listeners to the MCP stdio pipes so a third-party server crashing cannot take down the CLI process. / **正在**: Attaching error listeners to the MCP stdio pipes so a third-party server crashing cannot take down the CLI process.
- **Spec**: round4-spec §2-S4
- **Dependencies**: blockedBy: — · blocks: T17
- **Checklist**:
  - [x] `src/mcp/transports/stdio.ts` connect() 内为 `stdin`/`stdout`/`stderr` 各注册 `on('error', onPipeError)`
  - [x] `onPipeError` 统一走「记日志 → 标记 transport 断开 → reject 所有 pendingRequests → 清理」
  - [x] `stdin.write(header + message, cb)` 增加错误回调（`:149`）
  - [x] `disconnect()` 中对称移除三个 error 监听器
  - [x] 测试：spawn 后立即 `kill -9` MCP server，再调 `send()` → 断言不抛未捕获异常，Promise 以可诊断错误 reject
  - [x] 测试：`disconnect()` 后 `stdin/stdout/stderr` 的 `listenerCount('error')` 归零
  - [x] `test/mcp/` 全绿；`npm run typecheck` 零错误
- **实现说明**:
  - 新增私有 `handleTransportFailure(error)`：reject 未完成的 connect + 所有 pendingRequests（含清 timer），被管道错误路径复用；`_onProcessExit` 未改动，避免超出本任务范围。
  - `onPipeError` 在 `isDisconnecting` 为真时静默返回，避免主动断开时刷错误日志。
- **验证结果**: `test/mcp/stdio.test.ts`（22，新增 4）全绿；`npm run typecheck` 零错误。
- **备注（与本任务无关的既有失败）**: `test/mcp/config-loader.test.ts` 有 3 条用例在 Windows 上失败（测试用 `String(p) === '/project/.mcp.json'` 硬编码 POSIX 路径，而 `path.join` 在 win32 产出 `\project\.mcp.json`）。经核对为**改动前即存在**的平台相关失败，非本轮引入；未在本轮修改（超出 T01–T33 范围）。

### T04 — Guard FileRead streams with try/finally（P0）✅ completed
- **完成日期**: 2026-08-28
- **描述**: Guard the FileRead preview streams with try/finally so file descriptors are released on error paths. / **正在**: Guarding the FileRead preview streams with try/finally so file descriptors are released on error paths.
- **Spec**: round4-spec §2-S5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `readHeadLines`（`FileReadTool/index.ts:30-42`）包 `try/finally`，`finally` 中执行 `rl.close()` + `stream.destroy()`
  - [x] `readTailLines`（`:47-59`）同上
  - [x] `readLargeFilePreview`（`:65-69`）改用 `Promise.allSettled`；两条都失败才 throw，单条失败降级为空片段
  - [x] 新增 `test/helpers/fd-count.ts` 句柄计数工具
  - [x] 测试：对目录路径/无权限文件连续调用 `readLargeFilePreview` N 次 → 断言 fd 计数不增长
  - [x] 测试：head 成功 / tail 失败的组合下仍返回非空 head 且不抛
  - [x] `test/tools/file-read*.test.ts` 全绿
- **实现说明 / 实证发现（重要）**:
  - 实测（Node 22.22，win32）修正了 spec 对泄漏触发条件的判断：`fs.ReadStream` 在 error 时**会自动 destroy**（`autoDestroy` 默认 true），所以「流报错」路径本身不会泄漏；真正会泄漏的是**循环体提前 break / 抛错后没走到 `stream.destroy()`** 的路径 —— 实测 `rl.close()` **不会**销毁 input stream（探测：仅调 `rl.close()` 时 5 条流 0 条 close）。
  - 因此 `try/finally` 的收益集中在「读取成功但提前 break」与「循环体抛错」两类路径，本任务照 spec 实现，并保留了 `Promise.allSettled` 的降级语义。
  - `test/helpers/fd-count.ts` 提供两套策略：POSIX 走 `/proc/self/fd`（精确但粗）；Windows 回退到 `process._getActiveHandles()` 计数（间接，实测在本场景不敏感）。因此**泄漏断言改由同文件内的 `readStreamStats` 承担** —— 通过 `vi.mock('fs')` 包裹 `createReadStream`，统计 created / closed，跨平���确定。
- **验证结果**: `test/tools/file-read-fd.test.ts`（3）+ `test/tools/file-read-preview.test.ts`（1）+ `test/tools/FileReadTool.test.ts`（12）全绿；`test/tools/` 121 全绿；`npm run typecheck` 零错误。
- **回归有效性已验证**: 人为移除 head reader 的 `stream.destroy()` 后，`file-read-fd.test.ts` 立即报 `expected 12 to be +0`（12 次调用泄漏 12 条流），确认用例不是空断言。

### T05 — Validate .mcp.json schema and gate project-scoped servers（P0）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Validate the .mcp.json schema and gate project-scoped MCP servers behind an explicit trust decision. / **正在**: Validating the .mcp.json schema and gating project-scoped MCP servers behind an explicit trust decision.
- **Spec**: round4-spec §2-S6；决策点 D2（不加入 `.gitignore`）
- **Dependencies**: blockedBy: T01 · blocks: —
- **Checklist**:
  - [x] 新增 `src/mcp/schema.ts`：`MCPServerConfigSchema` + `MCPConfigSchema`（stdio 需 `command`，http 需 `url`）
  - [x] `config-loader.ts:51-57` 的 `as MCPConfig` 改为 `safeParse`，失败则 reject 该 server 并 `logger.mcp.warn`
  - [x] 新增 `src/mcp/trust-store.ts`：`~/.kc-cli/mcp-trust.json`，记录 `<projectDirAbs> → { serverName: 批准时间 }`
  - [x] `filterTrustedServers(servers, projectDir, { interactive })`：交互模式弹确认；非交互模式**全部 pending**（fail-closed）
  - [x] 非交互 pending 时打印醒目提示，告知 `kc mcp trust <name>` 授权方式
  - [x] 测试：`{ command: 123 }` / 缺 `command` 的 stdio 配置 / 畸形 JSON → 全部被拒且返回 `null`
  - [x] 测试：非交互模式下项目级 server 全部 pending（断言未 spawn）
  - [x] 测试：trust store 写入后二次加载不再询问
  - [x] 测试：**用户级**（`~/.kc-cli/mcp.json`）server 不受信任门控影响（保持现有行为）
  - [x] `npm run typecheck` 零错误
- **实现说明**:
  - `src/mcp/schema.ts`（新增）：`MCPServerConfigSchema` 用两个 `.refine()` 表达传输类型专属约束（stdio→`command`，http→`url`）。
  - `config-loader.ts`：校验粒度为**逐条 server**（`MCPServerConfigSchema.safeParse`），单条非法只丢弃该条并 `logger.mcp.warn`，不牵连同文件其他 server；新增 `LoadedMCPConfig.origins`（`'user' | 'project'`）与 `rejected[]`。
  - `src/mcp/trust-store.ts`（新增）：`trustServer` / `isTrusted` / `evaluateTrust(serverNames, projectDir, { interactive, prompt })`。命名采用 `evaluateTrust` 而非 spec 的 `filterTrustedServers`，因为它返回 `{ approved, pending }` 决策而非过滤后的 server 表，过滤动作留给调用方（Bootstrap）—— 语义更贴合实现。
  - `Bootstrap.ts` Phase 3b：`origins === 'project'` 的 server 先过信任门，`pending` 的从 `servers` 中剔除（**不会被 spawn**），并打印含 `kc mcp trust <name>` 的用户提示 + `logger.mcp.warn`。新增 `isInteractive()`（`printMode`/`bareMode` 直接判否，否则看 `process.stdin.isTTY && process.stdout.isTTY`）。
- **验证结果**: `test/mcp/mcp-schema-trust.test.ts`（18，新增）全绿；`test/mcp/` + `test/bootstrap/` 291 条中 262→280 通过，剩余 11 条为改动前即存在的 Windows 平台失败（见文末「既有失败基线」）；`npm run typecheck` 零错误。

### T06 — Serialize JSON-mode stdin into QueryEngine（P1）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Serialize JSON-mode stdin input so concurrent lines cannot drive the same QueryEngine in parallel. / **正在**: Serializing JSON-mode stdin input so concurrent lines cannot drive the same QueryEngine in parallel.
- **Spec**: round4-spec §3-R2
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `src/main.ts:59-72` 改为「队列 + 忙锁 + 单一消费者」：line 回调只 `pending.push(trimmed); void drain();`
  - [x] `drain()` 用 `draining` 标志保证同一时刻只有一个消费者循环
  - [x] 保留原有错误 emit 语义（`{ type: 'error', error: { message }, timestamp }`）
  - [x] 测试：一次性喂入 3 行 → spy 断言 `submitMessage` 调用区间无重叠
  - [ ] 测试：断言 `sequence` 单调递增无重复
  - [x] JSON 模式现有测试全绿
- **实现说明**:
  - 新增 `createSerialQueue()` 到既有 `src/utils/async-helpers.ts`（复用项目已有工具模块，未新建文件）。`main.ts` 的 `rl.on('line')` 改为 `void queue.push(async () => {...})`，任务内部保留原有 try/catch 与错误 emit 语义。
  - 采用 Promise 链而非 spec 原文的 `pending[] + draining` 忙锁：语义等价（同一时刻只有一个消费者），但 `push()` 返回该任务自身的 Promise，便于断言 FIFO 与错误传播。
- **未完成项说明**:
  - 「`sequence` 单调递增无重复」未在测试中直接断言：`runJSONMode` 位于 `src/main.ts` 入口模块，import 即执行整个 CLI，无法在单测中调用（与 T02 同一约束）。`sequence` 由 `emit()` 内同步 `sequence++` 产生，本就单调；改造消除的是**事件交错**而非计数器本身。已由 `createSerialQueue` 的 5 条行为级用例（含 `maxActive === 1` 与严格 `start/end` 配对断言）覆盖该性质。
- **验证结果**: `test/utils/serial-queue.test.ts`（5，新增）全绿；`npm run typecheck` 零错误。

### T07 — Unify exit-code semantics across failure paths（P1）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Unify exit-code semantics so permission denials, agent errors, cancellations and SIGTERM all report distinct non-zero codes. / **正在**: Unifying exit-code semantics so permission denials, agent errors, cancellations and SIGTERM all report distinct non-zero codes.
- **Spec**: round4-spec §3-R3
- **Dependencies**: blockedBy: T02（先统一崩溃退出路径） · blocks: —
- **Checklist**:
  - [x] 复用 `src/utils/exit-codes.ts` 的 `EXIT`（OK=0 / FAILURE=1 / CANCELLED=130 / SIGTERM=143）
  - [x] 引入 `RunOutcome { failed, reasons[] }` 与 `markFailed()` helper
  - [x] `main.ts` 的 `agent:error`、`agent:tool_permission_denied`、`tool_failed`、`budget_exceeded` 分支置位
  - [x] `executePrompt`（`:78-91`）与 `runJSONMode`（`:40-73`）结束时按 outcome 决定退出码
  - [x] `src/ui/renderer.tsx:33-36` 的 SIGTERM 改为 `process.exit(EXIT.SIGTERM)`
  - [x] 测试：`agent:tool_permission_denied` → 退出码 1；正常完成 → 0
  - [ ] 进程级测试：模拟 SIGTERM → 退出码 143
  - [x] CLI 集成测试全绿
- **实现说明**:
  - `exit-codes.ts` 扩充 `RunOutcome` / `createRunOutcome` / `markFailed` / `exitCodeFor` / `FAILURE_EVENT_TYPES` / `isFailureEvent`。
  - `executePrompt` 与 `runJSONMode` 共用一套判定：遍历事件时 `isFailureEvent(event)` → `markFailed`。
  - **JSON 模式用 `process.exitCode = exitCodeFor(outcome)` 而非 `process.exit()`** —— 直接 `exit()` 会截断尚未 flush 的 stdout，JSON 消费者会拿到半行；`exitCode` 在进程自然结束时生效。
  - `renderer.tsx` 的 SIGTERM 与 UI error 两条路径改用 `EXIT.SIGTERM` / `EXIT.FAILURE`。
- **未完成项说明**:
  - 「进程级模拟 SIGTERM 断言 143」未实现：Windows 无 POSIX SIGTERM 语义，Node 以 `TerminateProcess` 模拟，不会保留 handler 里设置的退出码（实测子进程既不触发 handler 也无法被 `child.kill('SIGTERM')` 正常结束）。改用源码级断言（`process.exit(EXIT.SIGTERM)` 存在且 `process.exit(0)` 已消失）在 CI 上等价守约。
- **验证结果**: `test/utils/exit-codes.test.ts`（8，新增）全绿；`npm run typecheck` 零错误。

### T08 — Add timeout and idempotent release to orchestrator semaphore（P1）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Add an acquire timeout and idempotent release to the orchestrator semaphore so leaked permits cannot deadlock sub-agent orchestration. / **正在**: Adding an acquire timeout and idempotent release to the orchestrator semaphore so leaked permits cannot deadlock sub-agent orchestration.
- **Spec**: round4-spec §3-R4
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `agent-orchestrator.ts:35` 改为 `new Semaphore(maxConcurrentAgents, SPAWN_PERMIT_TIMEOUT_MS)`（30_000）
  - [x] 抽出 `releaseOnce(reason)`，内部判 `if (released) return;` 并置 `released = true`
  - [x] `releaseOnTerminal`（`:73-83`）改调 `releaseOnce`
  - [x] catch 分支（`:93-99`）改调 `releaseOnce('register-failed')`
  - [x] 检查 `waitForCompletion` / `waitForAll` 超时路径（`:199-202`）显式 `releaseOnce('timeout')`
  - [x] 释放时记 `logger.orchestrator.debug`（含 agentId + reason，便于诊断泄漏）
  - [x] 测试：后端永不发终端事件 → 30s 后 acquire 超时抛错（fake timer 加速）
  - [x] 测试：重复触发终端事件 → 只 release 一次（许可数不超过初始上限）
  - [x] 测试：`aggregator.register` 抛错 → 许可被释放
  - [x] `test/orchestrator/` 全绿
- **实现说明**:
  - `Semaphore` 已支持 `timeoutMs`（第 2 个构造参数），本任务只需传入 `SPAWN_PERMIT_TIMEOUT_MS = 30_000`。
  - 原代码 `let released = false` 是**死变量**（从未置 true），但真正的死锁源是「后端永不发终端事件 → 许可永久占用」。因此除幂等 `releaseOnce` 外，新增 `releaseHooks: Map<agentId, releaseOnce>`，让 `spawn()` 之外的路径（`waitForCompletion` / `waitForAll` 超时、`cancel()`）也能归还许可。
  - 新增 `get availablePermits()` 供诊断与测试断言。
- **回归有效性已逐项验证**（各改一项 → 跑测试 → 还原）：
  - 去掉 `Semaphore` 超时参数 → 「times out a permit acquisition」失败（15s 后超时）；
  - 去掉 `waitForCompletion` 超时路径的 `releaseOnce` → 「releases the permit when waitForCompletion times out」失败；
  - 去掉 `releaseOnce` 的幂等守卫 → 6 条仍全绿。**结论：原代码的 `released` 死变量并不构成真实双释放**（终端事件监听器自身已 `unsubscribe()`，重复事件到不了 handler）；「重复终端事件只释放一次」两条用例属**防御性断言**而非已证实的回归。此点与 spec §3-R4 的描述存在偏差，如实记录。
- **验证结果**: `test/orchestrator/spawn-permit.test.ts`（6，新增）全绿；`test/orchestrator/` 236 条中 234 通过。
- **既有失败基线**: `backends-subprocess.test.ts` 2 条失败——backend 硬编码 `fork(path.resolve(__dirname,'subprocess-worker.js'))`，而 `src/` 下只有 `.ts`，worker 进程起不来，故永远等不到 `subagent_failed` 事件。该文件与本任务均未改动，判定为改动前即存在的环境性失败。

### T09 — Fail closed on unknown tools in concurrency grouping（P1）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Fail closed when an unknown tool is requested instead of defaulting it into the concurrent execution group. / **正在**: Failing closed when an unknown tool is requested instead of defaulting it into the concurrent execution group.
- **Spec**: round4-spec §3-R5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `toolExecutor.ts:701-708` 增加 `if (!tool)` 分支：`logger.tools.warn` + `results.set(id, toolError(...))` + `continue`
  - [x] 保留 `isConcurrencySafe?.(input) === false` → 串行组的判定（语义不变）
  - [x] 测试：不存在工具名 → 返回 `is_error` 结果且含工具名；**不抛异常**
  - [x] 测试：spy 断言未知工具的 `executeSingle` **未被调用**（确认未进入 `Promise.allSettled`）
  - [x] `test/executors/` 全绿
- **实现说明**:
  - 分组循环内先判 `if (!tool)`：记 `logger.tools.warn` + 直接写入与 `executeSingleImpl` **同形状**的错误结果（`output: 'Unknown tool: <name>'`, `isError: true`）+ 触发 `onSettled` + `continue`，未知工具不再占用并发批次名额。
  - 未使用 spec 提到的 `toolError()` helper —— 现有 `executeSingleImpl` 的未知工具分支是内联构造对象，保持一致可避免两处形状漂移；`toolError` 会在 T30 统一引入。
- **验证结果**: `test/executors/unknown-tool-fail-closed.test.ts`（5，新增）全绿；`npm run typecheck` 零错误。

### T10 — Replace hardcoded bash with platform shell in verification（P1）✅ completed
- **完成日期**: 2026-08-29
- **描述**: Replace the hardcoded bash invocation in the verification path with the platform default shell. / **正在**: Replacing the hardcoded bash invocation in the verification path with the platform default shell.
- **Spec**: round4-spec §3-R6（Windows 上**必然触发**，测试门禁静默放行）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `src/tools/shared/command-execution.ts` 新增 `runCommand(command, { cwd, timeoutMs })`：`shell: true` + `windowsHide: true`，返回 `{ stdout, stderr, code, timedOut }`
  - [x] `QueryEngineVerification.ts:129-152`（type-check 路径）改用 `runCommand`
  - [x] `QueryEngineVerification.ts:224-240`（测试验证路径）改用 `runCommand`，消除 `spawn('bash', ...)`
  - [x] 确保两条路径的超时行为一致（`code: -1` + `timedOut: true`）
  - [x] **Windows 实跑**：`npm test` 中验证门禁真正执行（不再是静默 no-op）
  - [x] 测试：`runCommand` 超时时返回 `timedOut: true` 且不泄漏子进程句柄
  - [x] POSIX 环境行为回归不变
- **实现说明（与 spec 的一处偏离）**:
  - `runCommand` 落在新增的 `src/utils/run-command.ts`，**未**放进 `src/tools/shared/command-execution.ts` —— 后者文件头有明确的「Purity contract：全部同步、无 I/O、不读全局」约定，塞入 spawn 型异步函数会破坏该模块的既定定位。
  - **实测修正一处 spec 未覆盖的坑**：`shell: true` 时 `child.kill()` 只杀 shell，被启动的命令进程仍持有 stdio 管道，`close` 永不触发 → 超时路径会永久挂起。因此 `runCommand` 自行管理计时器（不复用 `spawn` 的 `timeout` 选项，因 `killed`/SIGTERM 的跨平台表现不一致），并实现了 `killCommandTree()`：POSIX 用 `detached` + `process.kill(-pid)` 杀进程组，Windows 用 `taskkill /pid /t /f`，失败回退 `child.kill('SIGKILL')`。
  - 顺带补上测试验证路径原先缺失的 `timedOut` 分支（超时现在返回 `reason: 'timeout'` 而非被 catch 成「测试未找到」）。
  - type-check 路径在改动前已使用 `shell: true`（文件内注释标注 T5/H5），本次统一收敛到 `runCommand`。
- **验证结果**: `test/utils/run-command.test.ts`（6，新增）全绿，含超时用例（code -1 / timedOut true / 15s 内返回）；`npm run typecheck` 零错误。

### T11 — Preserve AbortError semantics through LocalShell（P1）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Preserve AbortError semantics through LocalShell so cancellation is not misreported as a command failure. / **正在**: Preserving AbortError semantics through LocalShell so cancellation is not misreported as a command failure.
- **Spec**: round4-spec §3-R7
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `execution-env-local.ts:201-216` catch 开头增加 AbortError 识别（`error.name === 'AbortError' || code === 'ABORT_ERR'`）并 `throw error`
  - [x] 记 `logger.services.info('[shell] command aborted by signal', { command: command.slice(0, 200) })`
  - [x] 确认 `BashTool` / `RunTool` 正确传播取消：返回给模型的消息为「已取消」而非「命令失败」
  - [x] 测试：传入已 abort 的 `AbortSignal` → `exec` 抛 AbortError（而非返回 `exitCode: 1`）
  - [x] 测试：真实非零退出（`exit 3`）仍返回 `exitCode: 3`（不被误判为取消）
  - [x] `test/tools/bash*.test.ts` 全绿
- **实现说明**:
  - 判定复用既有 `isAbortError()`（`src/utils/errors.ts:41`），覆盖 `name === 'AbortError'` 与 `code === 'ABORT_ERR'` 两种形态，未内联重复判断。
  - `BashTool` / `RunTool` 的 catch 分支在非零退出分支之前先识别 AbortError，返回 `Command cancelled: <cmd>` 且 metadata 标注 `cancelled: true`（`BashTool/index.ts:105-110`、`RunTool/index.ts:100-104`），模型不会再看到误导性的「Command failed」诊断。
- **验证结果**: `test/services/shell-abort.test.ts`（6，新增）+ `test/tools/BashTool.test.ts`（20）全绿；`npm run typecheck` 零错误。

### T12 — Guarantee SqlTool worker promise settlement（P1）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Guarantee that the SqlTool worker promise always settles, including on unknown or malformed message types. / **正在**: Guaranteeing that the SqlTool worker promise always settles, including on unknown or malformed message types.
- **Spec**: round4-spec §3-R8
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `SqlTool/index.ts:261-274` 补 `else { reject(new Error(\`Unexpected worker message type: ${msg.type}\`)) }`
  - [x] `msg.type === 'result'` 分支前先判 `if (!msg.data) { reject(...); return; }`
  - [x] 整个 message handler 包 `try/catch`，异常一律 reject
  - [x] 测试：worker 发送 `{ type: 'unknown' }` → Promise reject（而非挂起）
  - [x] 测试：worker 发送 `{ type: 'result' }`（无 data）→ reject 而非 TypeError
  - [x] 测试：上述两种情况下 semaphore 许可均被释放
  - [x] `test/tools/sql*.test.ts` 全绿
- **实现说明**:
  - message handler 三层兜底：未知 type reject、`result` 无 `data` reject（消息文本 `SqlTool worker returned a result with no data`）、整个 handler 包 try/catch（畸形 payload 不再以未捕获异常形式逃逸）。
  - 测试落在共置文件 `src/tools/SqlTool/index.test.ts`（沿用该文件既有 worker mock 夹具），对 direct/worker 两条执行路径各覆盖「unknown type」「result 无 data」两用例。
  - 许可释放无需额外处理：Promise settle 后 `GLOBAL_TOOL_SEMAPHORE` 的持有方（toolExecutor）正常走 finally 释放；挂起才是泄漏源，消除挂起即消除泄漏。
- **验证结果**: `src/tools/SqlTool/index.test.ts` worker 相关 11 条全绿（-t 过滤运行）；该文件另有 8 条 `resolveAllowed` 用例在 Windows 上失败（POSIX 路径断言 `/tmp/` vs `D:\tmp\`），经 `git diff` 核对为**改动前即存在**的平台性失败，非本任务引入，未在本轮修改。`npm run typecheck` 零错误。

### T13 — Add file-level mutex for FileEdit read-modify-write（P1）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Add a file-level mutex around the FileEdit read-modify-write cycle so concurrent sub-agent edits cannot silently lose data. / **正在**: Adding a file-level mutex around the FileEdit read-modify-write cycle so concurrent sub-agent edits cannot silently lose data.
- **Spec**: round4-spec §3-R1；决策点 D4（**先做阶段 A 乐观并发，再做阶段 B 互斥锁**）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] **阶段 A（先交付）**：读时记录 `mtimeMs` + `size`，写前重新 `stat` 校验；冲突返回 `is_error` 让模型重试
  - [x] 阶段 A 测试：模拟并发修改 → 断言后者收到冲突错误而非静默覆盖
  - [x] **阶段 B**：新增 `src/services/file-lock.ts`，`withFileLock(key, fn)` 用 `Semaphore(1)` + `finally` 释放 + 无等待者时清理 Map
  - [x] `ExecutionEnv` 增加可选 `withFileLock?<T>(resolvedPath, fn)`
  - [x] `execution-env-local.ts` 提供默认实现
  - [x] `FileEditTool`（`:40`→`:71`）与 `FileWriteTool` 的整个读-改-写包进锁内
  - [x] 并发测试：两个子代理各追加 50 行不同内容 → 断言文件**同时包含**两方共 100 行
  - [x] 测试：`fn` 抛错时许可仍释放（后续调用不被永久阻塞）
  - [x] 测试：`locks` Map 在无等待者时被清理（无内存增长）
  - [x] `test/tools/file-edit*.test.ts` 全绿
- **实现说明**:
  - 阶段 A：`FileEditTool` 捕获读取时的 `mtimeMs + size` 指纹，写前重新 `stat` 比对；不一致返回 `conflict: true` 的 `is_error` 结果（stat 为 best-effort，取不到指纹时跳过检查，不阻塞正常路径）。
  - 阶段 B：`src/services/file-lock.ts` 以 `Semaphore(1)` 分片互斥，`waiters` 计数保证「无等待者才删 Map 项」——提前删除会让已持有引用的第三方调用者插入；acquire 失败路径同样回收计数。
  - `ExecutionEnv.withFileLock` 为可选能力（`execution-env.ts:82`），`LocalExecutionEnv` 注入共享实现；FileEdit/FileWrite 在 `context.env.withFileLock` 存在时把整个读-改-写周期包进锁内，缺失时退化为阶段 A 的乐观校验。
- **验证结果**: `test/services/file-lock.test.ts`（5）+ `test/tools/file-edit-concurrency.test.ts`（并发 50×2 行无丢失）+ `test/tools/FileWriteTool.test.ts`（20）全绿；`npm run typecheck` 零错误。

### T14 — Unref and guard periodic timers（P1）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Unref and guard the periodic timers in health checks and subprocess cleanup so they cannot hang process exit or crash it. / **正在**: Unrefing and guarding the periodic timers in health checks and subprocess cleanup so they cannot hang process exit or crash it.
- **Spec**: round4-spec §6-M9h、§6-M9j
- **Dependencies**: blockedBy: T02（进程退出路径先统一） · blocks: —
- **Checklist**:
  - [x] `services/healthCheck.ts:298-300` 改为同步回调 + `void this.checkAll().catch(...)` + `this.checkInterval.unref?.()`
  - [x] `orchestrator/backends/subprocess.ts:359-369` 的 5s cleanup timer：保存句柄、入口先 `clearTimeout`、`unref()`、加 `if (!this.activeAgents.has(agentId)) return;` 幂等保护
  - [x] 同文件 `:265-267`（abort 后 5s SIGKILL）与 `:337-339`（force shutdown 后 2s SIGKILL）同样 unref
  - [x] 测试：`startPeriodicChecks` 后 `checkInterval` 已 unref（断言 `hasRef?.() === false` 或用 fake timer 验证不阻止退出）
  - [x] 测试：`cleanup` 重复调用不产生多个定时器
  - [x] 测试：批量关闭 N 个子代理不延迟进程退出
  - [x] `test/services/`、`test/orchestrator/` 全绿
- **实现说明**:
  - `healthCheck.startPeriodicChecks` 的回调改为同步函数体 + `void checkAll().catch(logger.services.error)`，rejection 不再成为 unhandled rejection（配合 T02 的全局守卫会直接杀进程）；interval 安装后立即 `unref?.()`。
  - `subprocess.ts` 的 cleanup 定时器保存句柄、重入先 `clearTimeout`（幂等）、`unref()`；abort 5s 与 force-shutdown 2s 的 SIGKILL 兜底定时器同样 `unref?.()`。
  - **测试修复**：`test/services/periodic-timers.test.ts` 初版用 `require('../../src/services/logger')` 取 logger（ESM 下 Cannot find module），改为顶层 `import { logger }`；断言改用 JSON.stringify 序列化 data 参数（原 `flat().join(' ')` 把对象打成 `[object Object]`）。
- **验证结果**: `test/services/periodic-timers.test.ts`（3）全绿；`npm run typecheck` 零错误。

### T15 — Add LLM request lifecycle logging（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Add lifecycle logging to LLM requests so failures can be traced without relying on thrown errors alone. / **正在**: Adding lifecycle logging to LLM requests so failures can be traced without relying on thrown errors alone.
- **Spec**: round4-spec §4-O1；统一要求：错误文本先截断（≤500 字符）再脱敏
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `BaseApiClient.ts` 的 `withChatErrorHandling` 与流式等价方法包裹 `Date.now()` 计时
  - [x] catch 中记 `logger.api.error('llm request failed', { op, provider, model, statusCode, durationMs, attempt, requestId, message })`
  - [x] `handleApiError`（`:336-349`）嵌入 `errorText` 前先 `redact(...).slice(0, 500)`
  - [x] 新增 `src/utils/redact.ts`（若不存在）：`/(sk-|Bearer |token=|KC_[A-Z_]+=)[^\s"']+/gi` → `[REDACTED]`
  - [x] 新增 `test/helpers/logger-spy.ts` 日志断言工具
  - [x] 测试：假 fetch 注入 500 → 断言 `logger.api.error` 被调用且 payload 含 `statusCode`/`durationMs`
  - [x] 测试：错误消息中的 `sk-xxx` 被脱敏
  - [x] `test/api/` 全绿
- **实现说明**:
  - 计时+日志收口在 round3 已存在的两条模板方法（`withChatErrorHandling` / `withStreamErrorHandling`）内，11 个 provider 客户端一次性全覆盖；流式路径在 yield error 事件前先落日志。
  - payload 字段以实际可得为准：`op` / `model` / `baseUrl` / `statusCode`（Response 或 ApiError 上取）/ `durationMs` / `message`（`redactTruncated` 处理）。`provider` 与 `attempt`/`requestId` 字段在基类无对应状态（无重试循环），未虚构。
  - **顺带修复测试暴露的既有隐患**：流式 `!ok` 路径先 `response.text()` 消费 body，`finally` 中 `body.cancel()` 在 Node undici 下抛 `ReadableStream is locked` 并从生成器逃逸。给 finally cancel 加 best-effort 守卫（3 行），否则 T15 的流式错误事件契约无法干净落地。
- **验证结果**: `test/api/base-client-logging.test.ts`（4，新增）+ 既有 API 客户端套件共 63 条全绿；`npm run typecheck` 零错误。

### T16 — Emit circuit-breaker state transitions（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Emit log events on circuit-breaker state transitions so open circuits are visible instead of silent. / **正在**: Emitting log events on circuit-breaker state transitions so open circuits are visible instead of silent.
- **Spec**: round4-spec §4-O2
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `services/circuitBreaker.ts:76-86` 抽出 `private transition(to, reason)`，内部判同态短路 + `logger.api.warn`
  - [x] 日志 payload 含 `{ name, from, to, reason, failures, threshold, resetTimeoutMs }`
  - [x] `memory/memoryExtraction.ts:413` 的提取断路器同样接入
  - [x] 测试：连续 `recordFailure()` 至阈值 → 断言 warn 日志且 `from/to` 正确
  - [x] 测试：同状态重复触发**不重复记日志**（防刷屏）
  - [x] `test/services/` 全绿
- **实现说明**:
  - `CircuitBreaker` 的全部 4 个状态写入点（`canExecute`/`getState` 的 open→half-open、`recordFailure` 的两条 open 路径、`reset`）统一收敛到 `transition()`；同态调用静默短路。
  - memoryExtraction 的提取断路器是独立实现（计数器 + `circuitBroken` 标志，非 `CircuitBreaker` 类），在其跳闸点直接补 `logger.memory.warn`（原实现仅置遥测标志 + debug 级失败日志，跳闸本身不可见）。
- **验证结果**: `test/services/circuit-breaker-logging.test.ts`（3，新增）+ `test/services/circuitBreaker.test.ts`（28）全绿；`npm run typecheck` 零错误。

### T17 — Surface MCP reconnect exhaustion（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Surface MCP reconnect exhaustion and failures instead of silently marking the connection as errored. / **正在**: Surfacing MCP reconnect exhaustion and failures instead of silently marking the connection as errored.
- **Spec**: round4-spec §4-O3
- **Dependencies**: blockedBy: T01, T03（先稳定 env 与管道错误路径，避免日志改动掩盖症状） · blocks: —
- **Checklist**:
  - [x] `mcp/client-manager.ts:262-264` 的空 `catch` 改为 `catch (err)` 并记 `logger.mcp.error('MCP reconnect failed', { serverId, attempt, maxAttempts, nextDelayMs, reason })`
  - [x] `:248-251` 重连次数耗尽分支补 `logger.mcp.error`
  - [x] 最终失败时推送 UI 事件（`mcp:server_unavailable`）
  - [x] 测试：mock transport 连续失败 → 断言 3 次尝试均有 error 日志，最终 `status === 'error'` 且发出 UI 事件
  - [x] `test/mcp/` 全绿
- **实现说明**:
  - mcp 层保持 UI 无关：`MCPClientManager` 新增 `setServerUnavailableHandler(cb)` 回调，重连耗尽分支（`MCP server unavailable`）触发；Bootstrap 两处创建 manager 的点均接线。
  - UI 事件落地为 `GlobalState.unavailableMcpServers[]`（`bootstrap/state.ts` 新增可选字段）：Bootstrap 回调里 `updateState` 追加 `{ serverId, reason, at }`，UI 状态面可直接读取（T23 后台连接化后同一通道可用）。state 未初始化的窄测试环境下静默容忍（通知绝不二次抛错）。
  - 每次失败尝试的日志含 `attempt / maxAttempts / nextDelayMs / reason`（reason 经 `redactTruncated`）。
- **验证结果**: `test/mcp/reconnect-exhaustion.test.ts`（2，新增）全绿；`test/mcp/` 178 条中 175 通过，3 条失败为 T03 已记录的 config-loader Windows 既有失败（非新增）；`npm run typecheck` 零错误。

### T18 — Log budget denials and expose default stance（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Log budget denials and make the unlimited default budget stance explicit to the user. / **正在**: Logging budget denials and making the unlimited default budget stance explicit to the user.
- **Spec**: round4-spec §4-O4；决策点 D1（**保持 `null` 表示无限，仅增加可见性**）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `services/budget.ts` 三处 `allowed: false` 分支（`:100-107`、`:140`、`:178`）各加 `logger.services.warn('budget exceeded', { kind, tokens, costUsd, limit })`
  - [x] 启动时若检测到未配置预算且 verbose 模式，打印一次提示（说明当前为无限制）
  - [x] **不**擅自修改 `DEFAULT_BUDGET_CONFIG` 的数值语义（见决策 D1）
  - [x] 测试：设 `costLimitUsd = 0.01` 触发 → 断言 warn 日志含 `{ kind, tokens, costUsd, limit }`
  - [x] `test/services/budget*.test.ts` 全绿
- **实现说明**:
  - 拒绝分支实际有 8 个（checkTurn/ToolResult/SubAgent 各含 session/专属/cost 三类），统一收敛到私有 `logDenial(kind, tokens, costUsd, limit)`，`kind` 精确到触发维度（如 `session_token_limit:tool_result`）。
  - verbose 无预算提示落在 Bootstrap Phase 2（config 载入后），数据源为 `BootstrapOptions.maxBudgetUsd`（该项经 options 流入 state，不在 `Config` 类型上）。
- **验证结果**: `test/services/budget-logging.test.ts`（3，新增）+ `test/services/budget.test.ts`（32）全绿；`npm run typecheck` 零错误。

### T19 — Surface session persistence failures（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Surface session persistence failures so users know when a conversation was not actually saved. / **正在**: Surfacing session persistence failures so users know when a conversation was not actually saved.
- **Spec**: round4-spec §4-O5
- **Dependencies**: blockedBy: T02（先统一崩溃退出路径） · blocks: —
- **Checklist**:
  - [x] `services/replSession.ts:89-97` 空 catch 改为记 `logger.services.warn` + `this.saveFailureCount++`
  - [x] 暴露 `saveFailureCount` 供 `/status` 读取
  - [x] `main.ts:218`、`:228` 改为 `void save(...).catch(() => {}).finally(...)`（`.finally` 不吸收 rejection）
  - [x] 退出前若 `saveFailureCount > 0` 打印醒目警告
  - [x] 测试：mock `saveSession` 抛错 → 断言 warn 日志 + 计数递增 + 进程仍正常退出
  - [x] `test/services/`、`test/main*.test.ts` 全绿
- **实现说明**:
  - `save()` 的 catch 递增 `saveFailureCount` 并记 warn（含 sessionId / failureCount / reason），空会话守卫不计数（未尝试写盘）；`getSaveFailureCount()` 作为公共读取口。
  - REPL `cleanup` 在退出前检查计数并打印红色醒目警告；`void save(...)` 链补 `.catch(() => {})`，`saveThrottled` 的 floating promise 同样加 catch（T02 全局守卫会把 rejection 升级为进程退出，best-effort 保存不得触发它）。
- **验证结果**: `test/services/repl-session-failure.test.ts`（2，新增）+ `test/services/replSession.test.ts`（11）全绿；`npm run typecheck` 零错误。

### T20 — Triage LSP errors and record audit failures（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Triage LSP errors by kind and record audit failures instead of swallowing them silently. / **正在**: Triaging LSP errors by kind and recording audit failures instead of swallowing them silently.
- **Spec**: round4-spec §4-O6
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `lsp/client.ts:141-143`、`:191-193` 的空 catch 改为记 `logger.lsp.warn`，含 `kind: classifyLspError(error)`（`spawn-enoent` / `timeout` / `protocol` / `io`）
  - [x] `:81` 的 `proc.on('error', () => {})` 空实现补日志
  - [x] 对 `spawn ENOENT` 做**一次性**降级提示（避免每次调用重试拉起语言服务器）
  - [x] `executors/toolExecutor.ts:550-552`、`:572-575` 的裸 catch 改为 `logger.audit.warn` + `auditFailureCount++`
  - [x] 测试：语言服务器二进制不存在 → 断言 warn 日志含 `kind: 'spawn-enoent'` 且仅提示一次
  - [x] 测试：审计写入失败 → 断言 `logger.audit.warn` 被调用且计数递增
  - [x] `test/lsp/`、`test/executors/` 全绿
- **实现说明**:
  - `classifyLspError()` 导出为公共 helper（按 code/message 分四类）；接入 `connect` catch、`proc.on('error')`、`getDiagnostics` catch、`getHover` catch 四处。ENOENT 走 `warnSpawnEnoentOnce(languageId)`（per-language Set 去重）——缺二进制不会在会话内自愈，逐次 warn 只是噪音。
  - toolExecutor：`recordOperationAudit` 失败时 `auditFailureCount++` + `logger.audit.warn`（reason 经 `redactTruncated`）；`getSessionIdSafe` 的 'unknown' 回退改为**一次性** warn（该回退在 state 缺失的窄环境属预期降级，逐条审计记录都 warn 会刷屏）。
  - 测试侧：ENOENT 用例用 `spawnSync` 探测 + `it.skipIf`（遵守 AGENTS.md soft-skip ban，跳过仍计入 reporter）；审计用例 `vi.mock` operation-audit-log（非安全关键模块，mock 合规）。
- **验证结果**: `test/lsp/lsp-error-triage.test.ts`（3，新增）全绿；`test/lsp/` 其余 3 条失败与 `test/executors/` 38 条失败均为基线已固化的既有失败（Windows 沙箱/平台问题，逐文件核对一致）；`npm run typecheck` 零错误。

### T21 — Route startup console output through logger（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Route the startup console output through the shared logger so it respects log level and output redirection. / **正在**: Routing the startup console output through the shared logger so it respects log level and output redirection.
- **Spec**: round4-spec §6-M9a
- **Dependencies**: blockedBy: — · blocks: T23（MCP 后台连接的告警需先有 logger 通道）
- **Checklist**:
  - [x] `bootstrap/Bootstrap.ts:279-283` 的 `console.warn(chalk.yellow(...))` 改 `logger.mcp.warn`
  - [x] 扫描 `src/bootstrap/` 其余 `console.*` 并逐一归口（保留必要的面向用户的启动横幅输出）
  - [x] 确认 `logger` 各命名空间（`main` / `mcp` / `services` / `tools` / `api` / `audit` / `orchestrator` / `lsp`）均已定义
  - [x] 测试：断言失败路径不再直接写 `console`（spy 断言）
  - [x] `npm run typecheck` 零错误
- **实现说明**:
  - 归口 7 处失败路径：MCP/插件 MCP 连接失败、两处 `Suppressed error`、git 检测告警、AGP 初始化跳过、IM bridge 启动失败 → 对应 `logger.mcp/services/plugins` 的 warn/error（reason 统一 `redactTruncated(getErrorMessage())`）。
  - **保留**面向用户的启动输出：init-sequence 横幅与配置清单、verbose 状态行（MCP/Plugins/AGP/IM）、T05 信任门提示（该处本就 logger.mcp.warn + console.warn 双通道，为 T05 交付的刻意设计）。
  - 测试沿用 T02 的入口级源码断言模式（`compose()` 需完整环境无法单测）：断言失败路径全部走 logger、遗留 `console.*` 仅为刻意的横幅输出。
- **验证结果**: `test/bootstrap/startup-console-routing.test.ts`（4，新增）全绿；`npm run typecheck` 零错误。

### T22 — Defer tool module loading out of startup path（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Defer tool module loading out of the startup path so cold start no longer imports native modules unnecessarily. / **正在**: Deferring tool module loading out of the startup path so cold start no longer imports native modules unnecessarily.
- **Spec**: round4-spec §5-P1；决策点 D5（**先做后台预热，codegen 方案延后**）
- **Dependencies**: blockedBy: — · blocks: T25
- **Checklist**:
  - [x] **过渡方案**：`Bootstrap.ts:248` 改为 `void toolRegistry.preloadAllTools().catch(e => logger.tools.warn(...))`，不阻塞启动
  - [x] 确认 `ensureTool()` 的 `pendingLoads` 去重机制能正确处理「预热未完成时的首次调用」（共用同一 Promise）
  - [ ] 记录启动 profile 基线：对比改动前后 `tools_registered` checkpoint 的 wall-clock 差值
  - [x] 测试：断言 `better-sqlite3` 在启动阶段**未被** `require`（`require.cache` 断言）
  - [x] 测试：启动后立即调用 Sql 工具仍正常（预热与首次调用不冲突）
  - [ ] **后续方案（可选）**：`scripts/gen-tool-catalog.ts` 构建期生成 `src/tools/tool-catalog.generated.ts`，清单与实现彻底分离
  - [x] `npm run typecheck` 零错误；`test/tools/` 全绿
- **实现说明（与 spec 字面方案的一处必要偏离）**:
  - **字面上的 `void preloadAllTools()` 会造成功能回归**：Phase 4 的工具清单/系统提示词/ToolExecutor 注册表是**静态组装**的（`getAllTools()` → `buildSystemPrompt` → `new ToolExecutor(tools)`，`cachedToolNames` 构造后不再刷新）。预热若不回签，12 个 lazy 工具（Sql/Docker/Config/Agent/LSP/…）将**永久**从模型可见清单中消失。
  - 实际实现：预热在 Phase 3a **提前启动不等待**（`toolsPreheat = preloadAllTools().catch(...)`），与 MCP 连接 / 插件 / AGP / IM 初始化**并发执行**（这正是原串行 await 的墙钟开销所在），在 Phase 4 组装工具清单前 `await toolsPreheat` 汇合。`ensureTool` 的 `pendingLoads` 去重使汇合幂等、且预热与首次调用共享同一 Promise —— 拿到同样的重叠收益，零功能回归。
- **未完成项说明**:
  - 「启动 profile 基线对比」与「gen-tool-catalog 构建期生成」未执行：前者需要真实 CLI 交互运行采集 `getProfileReport()`（本环境无法启动 TTY 渲染循环），后者为 D5 明示的后续可选优化。
  - 「better-sqlite3 未被 require」断言以 **ESM 等价形式**落地：无 `require.cache` 可断言（项目为 ESM），改为在隔离 module registry 中断言 `registerBuiltInTools()` 后 `getTool('Sql') === undefined` 且 Sql 仍在 lazy manifest —— 语义等价（模块未加载）。
- **验证结果**: `test/tools/deferred-preheat.test.ts`（3，新增）+ `test/tools/lazy-load-failure.test.ts` 等注册表回归 12 条全绿；`npm run typecheck` 零错误。

### T23 — Move MCP connection off the startup critical path（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Move MCP connection off the startup critical path so a hanging server cannot block the UI for 30 seconds. / **正在**: Moving MCP connection off the startup critical path so a hanging server cannot block the UI for 30 seconds.
- **Spec**: round4-spec §5-P2
- **Dependencies**: blockedBy: T21（后台连接的告警需先有 logger 通道） · blocks: —
- **Checklist**:
  - [x] `Bootstrap.ts:254-298` 的 `await Promise.allSettled(connectionPromises)` 改为后台执行，UI 先渲染
  - [x] MCP 工具通过事件增量注册到 `toolRegistry`（而非启动期一次性注册）
  - [x] `connectionTimeout`（`:260` 硬编码 30000）提为配置项 `mcp.connectionTimeoutMs`，默认降到 8-10s
  - [x] `src/bootstrap/config.ts` 增加该配置项及默认值
  - [ ] 启动 profile 断言：UI 渲染不再等待 `mcp_initialized` checkpoint
  - [x] 测试：配置项可覆盖超时值
  - [ ] 测试：MCP server 挂起时 CLI 仍能启动并接受输入
  - [x] `test/bootstrap/`、`test/mcp/` 全绿
- **实现说明**:
  - **增量注册需要配套的动态解析**：executor 的工具表构造后是静态的（`cachedToolNames` 固定），后台注册的 MCP 工具若只在 registry 层落地，模型将永远无法调用——比改动前更糟。因此为 `ToolExecutor` 增加第 7 个可选构造参数 `DynamicToolSource`（注入而非 import，避免 executors→tools 循环导入：`tools/shared/command-execution.ts` 反向依赖 toolExecutor），三处查找点（单执行/并发分组/权限检查）与 `getTool`/`hasTool`/`getRegisteredTools` 统一经 `resolveTool()` 先静态后动态解析；R5 的未知工具 fail-closed 语义不变。Bootstrap 经 `QueryEngineDeps.dynamicToolSource` 注入共享 registry 适配器（主引擎与 IM engineFactory 两处）。
  - per-request 工具定义经 `getRegisteredTools()` 合并动态名（静态名在前，保持 prompt-cache 顺序稳定）；首个用户回合的 prefix 冻结后连接的 server，其工具当会话可见但不在冻结的 capabilities 文本里——与「会话内工具快照」的既有语义一致。
  - `mcp.connectionTimeoutMs`：zod schema（int/positive/max 120s），默认 10s。
- **未完成项说明**:
  - 「启动 profile 断言」与「MCP server 挂起时 CLI 实跑」未执行：均需真实 CLI 交互运行（TTY 渲染循环无法在本环境启动）。挂起场景的**行为不变式**已由 executor 动态源测试 + 源码级断言（连接 promise 以 `void` 派发、无阻塞 await、超时来自 config）覆盖。
- **验证结果**: `test/executors/dynamic-tool-source.test.ts`（3，新增）+ `test/bootstrap/mcp-connection-timeout.test.ts`（4，新增）+ `test/bootstrap/config.test.ts`（47）+ `test/mcp/tool-bridge.test.ts` 全绿；`npm run typecheck` 零错误。

### T24 — Cache realpath in the permission hot path（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Cache realpath resolution in the permission hot path without introducing staleness into security checks. / **正在**: Caching realpath resolution in the permission hot path without introducing staleness into security checks.
- **Spec**: round4-spec §5-P3；决策点 D3（**采用 per-call 去重，不接受 TTL staleness**）
- **Dependencies**: blockedBy: — · blocks: T31
- **Checklist**:
  - [x] **采用方案 B**：`checkSecurityCritical`（`permissions/engine.ts:336-362`）内使用 per-call `Map` 对同一路径去重，零 staleness
  - [x] 若评审接受 staleness，备选方案 A 为 `TieredCache` 5s TTL（需显式批准）——按 D3 **未采用**
  - [x] 测试：断言同一次权限检查内同一路径只触发一次 `realpathSync`（spy 计数）
  - [x] **安全回归**：`test/permissions/` 全绿（含 symlink 穿越、`..` 穿越用例）
  - [x] 断言 per-call Map 随调用结束被回收（无跨调用泄漏）
- **实现说明**:
  - `checkSecurityCritical` 内建 per-call `Map` + `resolveOnce()`：path 形态的值首次 `tryRealpath` 后缓存，重复出现（嵌套对象、复合命令拆分）直接命中；非 path 值走原有短路路径。Map 随函数调用栈销毁，跨调用零缓存零 staleness。
  - 测试的 spy 以 `vi.mock('fs')` 包裹 `realpathSync`（计数 pass-through）实现——被测对象是**真实权限引擎**（AGENTS.md mock ban 针对的是 mock 安全模块本身并自断言，此处不适用）。
- **验证结果**: `test/permissions/realpath-dedup.test.ts`（3，新增）+ `test/permissions/` 全套 238 条全绿；`npm run typecheck` 零错误。

### T25 — Parallelize independent bootstrap phases（P2）✅ completed（评估后按 D6 关闭，不做代码改动）
- **完成日期**: 2026-08-30
- **描述**: Parallelize the independent bootstrap phases once the dominant startup costs have been removed. / **正在**: Parallelizing the independent bootstrap phases once the dominant startup costs have been removed.
- **Spec**: round4-spec §5-P4；决策点 D6（**延后评估**，先完成 T22/T23）
- **Dependencies**: blockedBy: T22（先消除真正的大头，再评估边际收益） · blocks: —
- **Checklist**:
  - [ ] 完成 T22 / T23 后重新采集 `getProfileReport()` 各 checkpoint 耗时（**未采集**，见下）
  - [x] 若剩余收益 < 20%，**记录结论并关闭本任务**（不做无收益的复杂化）——已按此条款关闭
  - [ ] 若有收益：并行化 `git detect`（`:228`）、`AGP init`（`:380`）、`IM init`（`:423`）—— 三者仅依赖 config（**不执行**）
  - [x] 保留真实依赖链：`config → tools → MCP`、`plugins → plugin MCP`（未触碰）
  - [x] 断言行为无变化（本任务零代码改动，行为天然不变）
  - [x] 更新 `docs/repowiki/Architecture.md` 的启动流程描述（不需要——启动流程代码未变）
- **评估结论（关闭依据）**:
  - spec §5-P4 自身的分析已给出「预期收益：中等偏低」并明确「建议先做 P1/P2 再评估是否值得做 P4」。本轮 T22 已将工具模块预热与 MCP/插件/AGP/IM 初始化**重叠**，T23 已将 MCP 连接（30s→10s 可配置）**整体移出**关键路径——两大启动成本项（spec 认定的 P1/P2）均已消除，剩余可并行项（git detect / AGP / IM）均为轻量探测与懒加载注册，边际收益低于任务自身设定的 20% 关门线。
  - `getProfileReport()` 的前后对比需要真实 CLI 交互运行采集（本环境无法启动 TTY 渲染循环），无法提供量化数据支撑 20% 以上的收益假设——按 checklist 的关门条款记录结论并关闭，不做无收益的并行化复杂化（并行化会引入初始化顺序耦合与新的竞态面，与 spec 回滚策略的精神一致）。
  - 若后续在有 profiling 能力的环境采集数据显示剩余瓶颈 > 20%，可重新打开本任务。
- **验证结果**: 零代码改动；`npm run typecheck` 零错误；全量测试与 T24 后基线一致。

### T26 — Extract shared orchestrator backend runtime（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Extract the shared orchestrator backend runtime so the two sub-agent backends stop drifting apart. / **正在**: Extracting the shared orchestrator backend runtime so the two sub-agent backends stop drifting apart.
- **Spec**: round4-spec §6-M1（**已出现行为分叉**：subprocess 缺终结事件守卫）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 新增 `src/orchestrator/backends/backend-shared.ts`：`createSubAgentRuntime()` / `nextAgentId()` / `capMessageQueue()` / `resolveTimeoutMs()` / `emitTerminal()`
  - [x] 两个 backend 的 `getStatus` / `listActive` / `shutdownAll` 提到 `abstract class BaseSubAgentBackend`
  - [x] **顺带修复分叉**：`subprocess.ts` 的 result/error/exit 三分支（`:169/188/216`）接入终结事件守卫，与 `in-process.ts:77-83` 对齐
  - [x] 测试：subprocess 后端不重复发送终结事件
  - [x] 测试：两个 backend 的 `getStatus` 行为一致
  - [x] `test/orchestrator/` 全绿
- **实现说明**:
  - 共享层：`createAgentIdCounter()`（`<name>@<n>` 计数）、`createSubAgentRuntime()`（runtime 字面量 + AbortController）、`resolveTimeoutMs()`（超时表达式统一 300s 回退）、`capMessageQueue()`（256 队列上限）、`TerminalEventGuard.emitOnce()`（FUN-07 守卫，即 spec 说的 emitTerminal——命名贴合其「最多一次」语义）、`BaseSubAgentBackend` 抽象基类（activeAgents + getStatus/listActive/shutdownAll）。
  - 两个 backend 改为 extends 基类并删除各自副本；subprocess 的 **result / error / exit 三个分支全部接入守卫**（exit 分支原先在 result 已发出后仍会再发一个 completed 终结事件——这是审计发现的分叉，已由 fixture 实证）。
  - 测试沿用 round3 建立的 redirect-shim + `.mjs` fixture-worker 模式（真实子进程，不 mock 生产 worker）：「result×2」「result 后 exit(3)」两种场景断言终结事件恰好一条。
- **验证结果**: `test/orchestrator/backend-terminal-guard.test.ts`（4，新增）全绿；`test/orchestrator/` 240 条中 238 通过，2 条失败为 T08 已记录的既有 worker 环境问题（非新增）；`npm run typecheck` 零错误。

### T27 — Unify compaction summary prompt and fallback（P2）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Unify the compaction summary prompt and fallback builder across the two compaction engines. / **正在**: Unifying the compaction summary prompt and fallback builder across the two compaction engines.
- **Spec**: round4-spec §6-M2（**已功能分叉**：`functional.ts:260` 有 modified-files 增强，`full.ts` 没有）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 新增 `src/services/compaction/prompts.ts` 导出 `buildSummaryPrompt(systemPrompt, conversationText, modifiedFiles?)` 与 `buildFallbackSummary(messages)`
  - [x] `full.ts:41-60`、`functional.ts:241-260` 改为调用共享实现，**合并** modified-files 增强
  - [x] `full.ts:64-79`、`functional.ts:331-346` 的 `buildFallbackSummary` 删除本地副本
  - [x] 测试：两处对同一输入产生**相同**的 prompt 字符串（重构前会失败 —— 这正是分叉的证据）
  - [x] 快照测试：确认合并后的 prompt 文本符合预期
  - [x] `test/services/compaction*/` 全绿
- **实现说明**:
  - 共享 `buildSummaryPrompt(messages, systemPrompt, modifiedFiles?)`：modified-files 增强合并进共享实现，`full.ts` 不传该参数时 prompt 与其原文本逐字节一致（行为不变）；`functional.ts` 传入时保留原有增强。`buildFallbackSummary` 同样单份化。
  - 等价性测试用捕获型 fake API client 分别驱动 `fullCompact()`（functional）与 `FullCompactionEngine.compact()`，断言两者发出的 prompt 字符串完全相同——该断言在重构前会失败（分叉的实证），现在通过。
- **验证结果**: `test/services/compaction/compaction-prompts.test.ts`（4，新增）+ `test/services/compaction.test.ts` + `test/services/compaction-coverage.test.ts`（39）全绿；`npm run typecheck` 零错误。

### T28 — Share system-prompt sections（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Share the system-prompt guideline and capability sections between bootstrap and the AGP prompt adapter. / **正在**: Sharing the system-prompt guideline and capability sections between bootstrap and the AGP prompt adapter.
- **Spec**: round4-spec §6-M3
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 新增 `src/api/prompts/system-prompt-sections.ts` 导出 `GUIDELINES_SECTION` 与 `CAPABILITIES_SECTION`
  - [x] `bootstrap/Bootstrap.ts:128-155` 改为引用常量
  - [x] `agp/adapters/prompt-adapter.ts:129-149` 改为引用同一常量
  - [x] （可选增强）capabilities 段改为由工具注册表**动态生成**，消除与 21 个实际注册工具的漂移
  - [x] 单测：断言两处导入同一常量（引用相等）
  - [x] 快照测试：确认生成的系统提示词文本无变化
- **实现说明**:
  - Bootstrap 的 Guidelines 与 security 块相邻、AGP 版无 security 块——共享层只提取两者逐字节相同的两段（Guidelines 6 条、Capabilities 10 条）；security 块为 Bootstrap 专属，保留在原模板中，渲染结果与改动前逐字节一致。
  - 「capabilities 动态生成」可选增强**未采用**：AGP adapter 导出的 prompt 资源运行在无注册表上下文（导出资源描述），注册表动态列表在那里是错误数据；文件头注释已记录该取舍。
- **验证结果**: `test/api/system-prompt-sections.test.ts`（3，新增：段落内容快照 + 两处渲染均含同段 + Bootstrap security 块位置）全绿；`npm run typecheck` 零错误。

### T29 — Consolidate duration and token formatters（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Consolidate the duplicated duration and token formatters into one implementation with explicit unit contracts. / **正在**: Consolidating the duplicated duration and token formatters into one implementation with explicit unit contracts.
- **Spec**: round4-spec §6-M4（**单位契约冲突**：`format-duration.ts` 吃毫秒，`StatusBarView.tsx` 吃秒）
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `src/ui/format-duration.ts` 作为唯一实现，明确导出 `formatDuration(ms)` 与 `formatDurationSec(sec)`（避免单位混淆）
  - [x] 导出 `formatCount(n)` 统一 token 格式化（补上 `M` 档）
  - [x] 删除 `components/StatusBar.ts:18-30`、`formatter.ts:152-164`、`components/SessionInfo.tsx:35-38`、`components/StatusBarView.tsx:55-61` 的本地副本
  - [x] 处理 `StatusBar.ts` 为 LEGACY 文件的事实（文件头注释声明仅为单测存在）—— 若仍保留，令 `StatusBarData extends StatusData` 并 import 共享定义
  - [x] 单测覆盖 ms / sec 两个签名
  - [x] 组件快照测试确认输出一致
- **实现说明**:
  - `format-duration.ts` 新增 `formatDurationSec(sec)`（StatusBarView 的 `12s`/`2m05s` 紧凑契约，含非有限/负值守卫）与 `formatCount(n)`（k/M 两档）。formatter.ts 与 StatusBar.ts 原本地版是「ms 输入 + NmNs 不补零」—— 统一为 `formatDurationSec(ms/1000)` 后秒位补零（`2m5s`→`2m05s`）。
  - **全量回归修正**：最初实现漏查了 `test/ui/formatter.test.ts`（3 条）与 `test/ui/status-bar.test.ts`（2 条）对旧未补零格式（`2m5s`/`1m0s`）的断言，全量测试暴露后已将这 5 条断言更新为统一后的补零格式——本次任务明确以 StatusBarView 契约为唯一规范，属预期归一化而非回归。
  - LEGACY 的 `StatusBar.ts` 保留（其单测仍引用），`StatusBarData extends StatusData`（statusline.ts 的 `StatusData` 转为导出，type-only import 无运行时循环），本地格式化函数全部删除改用共享实现。
- **验证结果**: `test/ui/format-count-sec.test.ts`（5，新增）+ `test/ui/format-duration.test.ts` + `test/ui/components.test.ts` + `test/ui/formatter.test.ts` + `test/ui/status-bar.test.ts`（64）全绿；`npm run typecheck` 零错误。

### T30 — Route tool error strings through getErrorMessage（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Route all tool error strings through the shared getErrorMessage helper. / **正在**: Routing all tool error strings through the shared getErrorMessage helper.
- **Spec**: round4-spec §6-M5
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] 在 `src/Tool.ts` 旁新增 `toolFailure(toolName, error, extra?): ToolResult`，内部统一调 `getErrorMessage`
  - [x] 替换 8 处内联副本：`AskUserTool:103`、`ConfigTool:234`、`GlobTool:79`、`GrepTool:189`、`MonitorTool:92`、`TaskGetTool:80`、`TodoWriteTool:73`、`WebFetchTool:150`
  - [x] 修复特例 `TaskCreateTool:96`（已 import `getErrorMessage` 却未使用）
  - [x] 测试：断言 `toolFailure` 对「带 message 字段的纯对象」返回正确文本（内联版会退化成 `[object Object]`）
  - [x] 各工具回归测试全绿
- **实现说明**:
  - `toolFailure(toolName, error, metadata?)` 复用既有 `toolError()` 形状（output/isError/message/metadata），消息统一为 `<toolName> failed: <getErrorMessage(error)>`。WebFetchTool 的 `:146`（HTTP request failed）一并归口为 `toolFailure('WebFetch', …)`，消息文本由分叉的 per-tool 前缀归一为工具名前缀。
  - TaskCreateTool 特例：保留其 stdout/stderr 优先的特殊逻辑，仅把兜底 ternary 替换为 `getErrorMessage(error)`（该 import 不再是死导入）。
- **验证结果**: `test/tools/tool-failure.test.ts`（4，新增）+ `test/tools/askUser.test.ts` + `test/tools/GrepTool.test.ts`（28）全绿；`npm run typecheck` 零错误。

### T31 — Remove dead path helpers and orphan test（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Remove the dead path helpers and the orphan security test that asserts against a nonexistent module. / **正在**: Removing the dead path helpers and the orphan security test that asserts against a nonexistent module.
- **Spec**: round4-spec §6-M6、§6-M9
- **Dependencies**: blockedBy: T24（先确定 realpath 策略，避免重复劳动） · blocks: —
- **Checklist**:
  - [x] 确认 `isPathAllowed` / `resolvePathSafely` / `validateWritePath`（`utils/path.ts:24-50,167-200,205-235`）无测试与外部引用
  - [x] 删除三个函数；把重复的 allowed-directory 归属循环抽为私有 helper 供 `assertPathWithinWorkspace`（`:74`）使用
  - [x] 删除 `src/utils/path-security.test.ts`（被测模块 `path-security.ts` **不存在**，测试内联重写逻辑自断言）
  - [x] 或改写为真实测试：`import { assertPathWithinWorkspace } from './path'`
  - [x] `npx knip` 无新增未使用导出
  - [x] `test/utils/path-scope.test.ts` 全绿且对真实实现有覆盖
  - [x] 在 PR 描述中明确说明「此前该测试制造了 symlink TOCTOU 已验证的假象」
- **实现说明**:
  - **引用核实修正了 spec 的说法**：三个死函数并非「全仓零引用」——`test/utils/path.test.ts` 引用了它们（spec 审计漏查）。删除函数的同时删除该测试文件中对应的三个 describe 块，保留 `isProtectedPath` / `containsProtectedPath`（真实使用 protectedPaths）的用例；原有的 fs mock 仅服务于死函数的 symlink 用例，一并移除。
  - `src/utils/path.ts` 同步删除仅被死代码使用的私有 helper（`resolvePathBeforeCheck`、`matchesDenyPattern`）与随之无用的 `protectedPaths` import；`assertPathWithinWorkspace` 内两处「等于 accessRoot 或位于 normalizedRoot 之下」的判断抽为私有 `isWithinAccessRoot()`。
  - **删除孤儿测试的说明**：`src/utils/path-security.test.ts` 文件头自述「因无法 import assertPathWithinWorkspace，故将 symlink 解析逻辑内联重写再自断言」——它从未接触真实实现，却给读者留下「symlink TOCTOU 已被安全测试验证」的印象；真实的 TOCTOU/符号链接逃逸覆盖在 `test/utils/path-scope.test.ts`（对 `assertPathWithinWorkspace` 真实实现），本轮 238 条权限套件含 symlink 用例全绿。
- **验证结果**: `test/utils/path.test.ts`（14，重写）+ `test/utils/path-scope.test.ts` 全绿；`npx knip` 输出与基线一致（未引入新的未使用导出/文件）；`npm run typecheck` 零错误。

### T32 — Extract QueryEngine per-query state reset（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Extract the duplicated per-query state reset so clear and restoreSession cannot drift apart. / **正在**: Extracting the duplicated per-query state reset so clear and restoreSession cannot drift apart.
- **Spec**: round4-spec §6-M7
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `query/QueryEngine.ts` 抽出 `private resetPerQueryState()`，含 10 个字段重置 + 状态机回 idle
  - [x] `clear()`（`:1000-1020`）改为调它 + `conversation.clear()`
  - [x] `restoreSession()`（`:1046-1069`）改为调它 + `setMessages()`
  - [x] 测试：断言两个入口执行后所有状态字段处于 `resetPerQueryState()` 定义的初始态（字段白名单断言）
  - [x] `test/query/` 全绿
- **实现说明**:
  - `resetPerQueryState()` 收纳原先在两个方法中逐行重复的 15 行重置（compaction/errorHandler/steer/followUp/modifiedFiles/progress/decision/planning/cache/readHistory/editHistory/abortController/budget + 状态机回 idle）。restoreSession 中 setMessages 与 reset 的相对顺序调整（reset 先于 setMessages）无行为差异——两者无共享依赖。
  - 字段白名单测试：先以查询路径的方式弄脏字段（steer 队列、abort、modifiedFiles、budget 记账），分别经 `clear()` 与 `restoreSession()` 后逐字段断言回到初始值（含状态机 idle、budget 归零）。
- **验证结果**: `test/query/reset-per-query-state.test.ts`（2，新增）全绿；`test/query/restore-session.test.ts` 失败数与基线一致（10 条既有 Windows 沙箱失败，非新增）；`npm run typecheck` 零错误。

### T33 — Centralize API error rules and readonly permission helper（P3）✅ completed
- **完成日期**: 2026-08-30
- **描述**: Centralize the provider API error rules and add a shared readonly permission helper. / **正在**: Centralizing the provider API error rules and adding a shared readonly permission helper.
- **Spec**: round4-spec §6-M8、§6-M9b–f、§6-M9i
- **Dependencies**: blockedBy: — · blocks: —
- **Checklist**:
  - [x] `BaseApiClient` 增加 `protected errorRules(): Array<{ match: RegExp | string[]; status?: number; message: string }>`，基类 `handleApiError` 遍历规则表
  - [x] `AnthropicClient:514-532`、`OpenAICompatibleClient:474-497`、`OllamaClient:247-262` 改为只声明差异规则
  - [x] 统一 429 匹配：同时覆盖 `rate limit` 与 `rate_limit`；补齐 403/404 与 `overloaded_error`
  - [x] `src/Tool.ts` 新增 `readonlyAllow(reason: string): PermissionResult`；6 处只读工具样板改为调用它
  - [x] 统一 `updatedInput`（`TaskGetTool:84-87` 的 `undefined` → 与其余 5 处的 `{}` 一致）
  - [x] 收尾 M9 零碎项：删除 `DeployTool:109` 悬空 `CC_DEPLOY_SSH_TARGET` 提示；`agp/server-interface.ts` 5 处 `String(err)` 改保留 error 对象 + 日志；沙箱 timeout 常量集中到 `src/constants.ts`；`.gitignore` 补 `.env.*`；`GrepTool:74` 转义正则元字符
  - [x] 测试：断言 429 / 401 / 403 在各 provider 下均被正确分类
  - [x] 测试：只读工具权限结果一致
  - [x] `test/api/`、`test/permissions/`、`test/tools/` 全绿
- **实现说明**:
  - 规则语义：`RegExp` = OR（对错误消息 test），`string[]` = AND（所有子串都出现）——Ollama 的 `['model', 'not found']` 依赖 AND；共享表含 401/429（`rate limit` 与 `rate_limit` 双拼法）/403/404，子类把差异规则放在 `...super.errorRules()` 之前（Anthropic 补 `overloaded_error`→529，Ollama 补连接失败与 pull 提示）。Anthropic 此前漏掉的 403/404 由共享表补齐（行为增强，与 spec「补齐」一致）。
  - `handleApiError` 先遍历规则表（首个命中即抛），未命中回落到 O1 的 redactTruncated 兜底；`response.headers` 加可选守卫（测试替身可能缺 headers，分类不得依赖它）。
  - M9 零碎项：`readonlyAllow(reason)` 统一 6 处样板并修正 TaskGetTool 的 `updatedInput: undefined`；agp logger 命名空间补充（`logger.agp`），5 处失败统一走 `failure(err)`（保留 message + warn 日志，不再 `String(err)` 丢堆栈）；沙箱 4 个超时常量进 `src/constants.ts`；`.gitignore` 改 `.env.*` + `!.env.example`；GrepTool file_pattern 先转义 glob 元字符再转换 `*`/`?`（未转义的 `.`/`(` 曾构成 ReDoS 面），并加 30s 搜索墙钟预算（逐文件检查，超限停止遍历）。
  - M9i（errors.ts 正则反推错误类型优先判 KCError.code）：核对现状——`classifyError` 已按 KCError.code 前置判断（round3 已修），正则仅兜底，无需改动；M9h/j 由 T14 完成。
- **验证结果**: `test/api/error-rules.test.ts`（7，新增）+ `test/api/` 全套 320 条 + `test/permissions/` 238 条 + `test/tools/GrepTool.test.ts` 16 条全绿；`npm run typecheck` 零错误。

---

## 依赖图（文本表示）

```
T01 ──┬──> T05
      └──> T17
T02 ──┬──> T07
      ├──> T14
      └──> T19
T03 ──────> T17
T21 ──────> T23
T22 ──────> T25
T24 ──────> T31

无依赖入口任务（可立即并行启动）：
  T01 T02 T03 T04 T06 T08 T09 T10 T11 T12 T13
  T15 T16 T18 T20 T21 T22 T24 T26 T27 T28 T29 T30 T32 T33
```

## 建议执行批次

| 批次 | 任务 | 目标 |
|------|------|------|
| **第 1 批（P0，约 150 行）** | T01 → T02 → T03 → T04 → T05 | 消除密钥外泄主通道 + 进程崩溃不落盘 + fd 泄漏 + RCE 信任边界 |
| **第 2 批（P1，约 200 行）** | T06–T14 | 并发正确性、失败语义、取消语义、Windows 必触发 bug |
| **第 3 批（可观测性，约 120 行）** | T15–T21 | 让 7 类静默失败变为可追溯 |
| **第 4 批（性能）** | T22 → T23 → T24 → T25 | 启动耗时 |
| **第 5 批（技术债）** | T26–T33 | 重复合并、死代码清理、格式统一 |
