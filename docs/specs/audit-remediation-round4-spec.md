# Audit Remediation Round 4 Specification — 运行时韧性 · 密钥与信任边界 · 并发正确性 · 可观测性基线

**Version**: 1.0.0
**Date**: 2026-08-28
**Source**: KC-CLI v3.2.0 四维度系统性代码审查（代码重复 / 系统稳定性 / 性能 / 硬编码与安全）
**审查方法**: 3 个专项子代理并行深查 + 人工逐行取证核验；审查范围 `src/` 301 文件 / 58,540 行；**全程只读，未修改任何源文件**。
**Status**: Draft — 待评审
**前序**: `audit-remediation-round3-spec.md`（T01–T26 已全部完成）· `audit-remediation-round2-spec.md` · `architecture-review-fixes-spec.md`
**审查原始报告**: `.workbuddy/code-review-2026-08-28.md`
**任务清单**: `docs/specs/audit-remediation-round4-tasks.md`

---

## 0. 审查核心结论（TL;DR）

> **Round 3 治理的是「信号失真」——项目自我描述与真实实现之间的裂缝。Round 4 治理的是另一类问题：「静默失败」——代码在关键边界上选择了不吭声，导致故障既不被阻止，也不被记录。**
>
> 三条互相独立、但都指向同一根因的发现：
> 1. **安全控制被一行代码绕过**：`buildSafeEnv()` 写好了、BashTool 也调了，但执行层用 `{ ...process.env, ...options.env }` 又把完整环境铺回底层，让过滤彻底失效。
> 2. **并发控制只有「限流」没有「互斥」**：`Semaphore` 用得很规范，但它只限制**数量**，从未保护**同一资源**。缺口恰好落在 FileEdit 的读-改-写上——全项目唯一会造成用户数据无声丢失的路径。
> 3. **失败信号在至少 7 个边界被吞掉**：LSP、审计、会话持久化、MCP 重连、断路器、预算、LLM 请求。4 个关键模块（`BaseApiClient` 481 行、`circuitBreaker`、`budget` 249 行、`client-manager`）logger 计数为 **0**。

证据链（标注 ✅ 为人工逐行核验，⚠️ 为子代理上报后抽查同文件上下文、未逐行 diff）：

| # | 发现 | 可验证事实 | 核验 |
|---|---|---|---|
| 1 | Bash 工具密钥过滤失效 | `execution-env-local.ts:191` `{...process.env, ...options.env}`；`BashTool/index.ts:69-74` 已传 `buildSafeEnv()` | ✅ |
| 2 | MCP 进程继承完整环境 | `mcp/transports/stdio.ts:51` 与 `:68` 两处同款合并 | ✅ |
| 3 | 主交互路径零异常兜底 | 全局 `process.on` 写在 `runREPL()` 内（`main.ts:230-231`），默认路径走 `onInteractiveUI`（`main.ts:501-504`） | ✅ |
| 4 | MCP 管道 error 未监听 | `stdio.ts:81-90` 只挂 `data`；`disconnect()` `:177-192` 只移除 data/exit | ✅ |
| 5 | FileRead 流 fd 泄漏 | `FileReadTool/index.ts:30-42`、`:47-59` 缺 `try/finally`；`:66-69` `Promise.all` 双流 | ✅ |
| 6 | `.mcp.json` 无校验即 spawn | `config-loader.ts:51-57` `as MCPConfig` 裸断言；`Bootstrap.ts:256-268` 自动连接；`.gitignore` 无 `mcp` 规则 | ✅ |
| 7 | FileEdit 跨执行器无互斥 | `FileEditTool/index.ts:40` 读 → `:71` 写；`isConcurrencySafe: false` 仅作用域于单批次（`toolExecutor.ts:698-708`） | ✅ |
| 8 | JSON 模式并发驱动引擎 | `main.ts:62-72` `rl.on('line', async ...)`，readline 不等 async 回调 | ✅ |
| 9 | 退出码全 0 | `main.ts:131-133`、`:147-149`；`ui/renderer.tsx:33-36` SIGTERM 也退 0 | ✅ |
| 10 | 编排器 semaphore 无超时 | `agent-orchestrator.ts:60,80-86`；`:35` `new Semaphore(8)` 无 timeout；`:86` `released` 恒 false | ✅ |
| 11 | 未知工具 fail-open | `toolExecutor.ts:703` `!== false` + 可选链 → `undefined` 落入并发组 | ✅ |
| 12 | Windows 硬编码 bash | `QueryEngineVerification.ts:226` vs 已修好的 `:129`；`:123-128` 注释自己警告了该模式 | ⚠️ |
| 13 | 启动加载全部 lazy 工具 | `tools.ts:102-105` + `Bootstrap.ts:248`；`registry.ts:62-76` 12 个 `eager:false` | ✅ |
| 14 | MCP 连接阻塞 UI 渲染 | `Bootstrap.ts:254-298`，`connectionTimeout = 30000` 硬编码 | ✅ |
| 15 | 孤儿测试制造假覆盖率 | `utils/path-security.test.ts` 被测模块 `path-security.ts` **不存在** | ⚠️ |

**修正说明**：重复维度子代理原报「compaction 两处 prompt 逐字节相同」，人工 diff 后证实**已功能分叉**（`functional.ts:260` 多出 modified-files 增强，`full.ts` 没有）。见 §6-M2。本轮所有重复类条目均按此标准复核。

---

## 1. 问题分类与优先级矩阵

### Priority Legend

| Level | Criteria |
|-------|----------|
| **P0** | 密钥泄露通道、进程崩溃、资源耗尽句柄泄漏、RCE 信任边界——**有实际可利用路径或必然触发的崩溃**，必须最先修复 |
| **P1** | 并发正确性缺陷、失败语义错误、静默数据丢失、平台必然触发的 bug——**会导致错误行为或错误的失败信号** |
| **P2** | 可观测性基线、启动性能、结构性重复——**不产生即时故障，但显著抬高排障成本或长期维护成本** |
| **P3** | 死代码清理、命名与格式统一、孤儿测试——**技术债偿还** |

### Summary Count

| Priority | Count | 编号 | 主要子系统 |
|----------|-------|------|-----------|
| P0 | 6 | S1–S6 | services/execution-env、mcp/transports、main、tools/FileRead、mcp/config-loader |
| P1 | 8 | R1–R8 | tools/FileEdit、main（JSON 模式）、退出码、orchestrator、executors、query/verification、services/shell、tools/Sql |
| P1/P2 | 6 | O1–O6 | api/BaseApiClient、services/circuitBreaker、mcp/client-manager、services/budget、services/replSession、lsp + executors 审计 |
| P2 | 4 | P1–P4 | tools 注册表、bootstrap、permissions、bootstrap 阶段编排 |
| P2/P3 | 9 | M1–M9 | orchestrator/backends、services/compaction、bootstrap+agp、ui、tools、utils/path、query、api、test |

**合计 33 条发现 → 33 个任务**（见配套 tasks 文件）。

---

## 2. P0 修复方案

### S1: LocalShell 环境合并绕过 `KC_*` 密钥过滤（严重-8）

**Severity**: Critical（密钥泄露）
**证据**:
- `src/services/execution-env-local.ts:187-195` —
  ```ts
  const { stdout, stderr } = await execAsync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
  ```
- `src/tools/BashTool/index.ts:69-74` — 调用方已正确过滤：`env: buildSafeEnv()`
- `src/tools/RunTool/secrets.ts:89-99` — `buildSafeEnv()` 确实剥离所有 `KC_*`

**Root Cause**: 调用方（BashTool）做了过滤，执行层（LocalShell）又把**完整 `process.env` 铺在底层**。`options.env` 中不含 `KC_*` 键，因此它们不会被覆盖，而是从底层的 `process.env` 原样透传到子进程。**过滤做对了，但被下游一行代码抵消。**

**影响**: 任何经 Bash 执行的命令（`env`、`curl -d @-`、读取父环境的子进程）都能拿到 `KC_API_KEY`、`KC_SEARCH_API_KEY`、`KC_IM_FEISHU_APP_SECRET`。整条 SEC-03 防护对 Bash 工具完全失效。

**修复方案**:
1. 新增 `src/utils/env-sanitize.ts`，把环境白名单逻辑从 `src/tools/RunTool/secrets.ts` 上提为共享工具（避免 `mcp/` 反向依赖 `tools/`）。
2. `execution-env-local.ts:191` 改为 `env: options.env`。
3. `RunTool` 切换到同一份共享实现，消除两份过滤逻辑漂移。

**技术实现**:
```ts
// src/utils/env-sanitize.ts（新增）
/** 允许透传给子进程的最小环境变量集 */
const ENV_ALLOWLIST = new Set([
  'PATH','HOME','USER','LOGNAME','SHELL','TERM','COLORTERM','LANG','LC_ALL','LC_CTYPE',
  'TEMP','TMP','TMPDIR','SystemRoot','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA',
  'NODE_ENV','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy',
]);
/** 无论调用方是否显式传入都拒绝的前缀（最后一道闸） */
const ENV_DENY_PREFIX = ['KC_', 'ANTHROPIC_', 'OPENAI_', 'AWS_SECRET', 'GITHUB_TOKEN'];

export function buildSafeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  // 逃生舱：KC_ALLOW_ENV_VARS=a,b,c
  for (const key of (process.env.KC_ALLOW_ENV_VARS ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (ENV_DENY_PREFIX.some(p => k.startsWith(p))) continue;   // 防止调用方无意注入
    out[k] = v;
  }
  return out;
}
```
```diff
// src/services/execution-env-local.ts:191
- env: options.env ? { ...process.env, ...options.env } : undefined,
+ // options.env is already sanitized by the caller (buildSafeEnv / filterEnvVars).
+ // Spreading process.env beneath it would re-introduce every KC_* secret the
+ // filter just stripped, so pass the filtered environment through verbatim.
+ env: options.env,
```

**涉及文件**: `src/utils/env-sanitize.ts`（新增）、`src/services/execution-env-local.ts`、`src/tools/RunTool/secrets.ts`、`src/tools/RunTool/index.ts`、`src/tools/BashTool/index.ts`
**验证**:
- `npm run typecheck` 零错误
- 新增集成测试：设 `process.env.KC_API_KEY='sk-test-secret'` → 执行 `Bash` 的 `env` 命令 → 断言 stdout 不含 `KC_API_KEY` 与 `sk-test-secret`
- 回归：`test/tools/` Bash/Run 套件全绿；确认 `PATH`/`HOME` 等仍可用（`node -v`、`pwd` 正常）

---

### S2: MCP stdio 传输把完整 `process.env` 注入第三方服务器（严重-9）

**Severity**: Critical（密钥泄露）
**证据**:
- `src/mcp/transports/stdio.ts:49-51`（SDK transport 路径）— `env: { ...process.env, ...env },`
- `src/mcp/transports/stdio.ts:68-73`（内置 fallback）—
  ```ts
  const mergedEnv = { ...process.env, ...env };
  this.process = spawn(command, args, { stdio: ['pipe','pipe','pipe'], env: mergedEnv });
  ```

**Root Cause**: 与 S1 同构。MCP 服务器是**第三方进程**（可能来自 npm / npx / 不可信仓库），却继承宿主完整环境。

**影响**: 恶意或被投毒的 MCP server 可直接读取 `KC_API_KEY`。与 S6 组合构成完整攻击链：恶意 `.mcp.json` → spawn 恶意进程 → 窃取 `KC_API_KEY` → 外传。

**修复方案**: 两条路径都接入 S1 的 `buildSafeEnv()`；MCP 配置中显式声明的 `env` 字段作为 `overrides` 传入（仍受 `ENV_DENY_PREFIX` 约束）。

**技术实现**:
```diff
// src/mcp/transports/stdio.ts:49-51
- env: { ...process.env, ...env },
+ env: buildSafeEnv(env),          // MCP 声明的 env 作为 overrides 进入
```
```diff
// src/mcp/transports/stdio.ts:68
- const mergedEnv = { ...process.env, ...env };
+ const mergedEnv = buildSafeEnv(env);
```

**涉及文件**: `src/mcp/transports/stdio.ts`、`src/utils/env-sanitize.ts`
**blockedBy**: S1（`buildSafeEnv` 需先上提为共享工具）
**验证**:
- 单元测试：spawn 一个 dump env 的 mock MCP server（`node -e "console.log(JSON.stringify(process.env))"`），断言结果不含任何 `KC_` 前缀键
- 断言 MCP 配置中显式声明的 `env: { FOO: 'bar' }` **仍然生效**（不能把合法用法也堵死）
- `test/mcp/` 套件全绿

---

### S3: 主交互路径无全局异常兜底（严重-1）

**Severity**: Critical（进程崩溃 + 会话丢失）
**证据**:
- `src/main.ts:230-231` — 全局兜底注册在 **`runREPL()` 函数体内部**
- `src/main.ts:500-507` — 默认路径是 `onInteractiveUI`（Ink UI），`onRunREPL` 仅在 bare / 非 TTY 时触发
- 全仓 `grep uncaughtException|unhandledRejection` 仅 4 处：`main.ts:230,231` + `subprocess-worker.ts:147,155`；`src/bootstrap/**`、`src/ui/**` **零命中**

**Root Cause**: 兜底写在降级 REPL 分支里，而默认路径走 Ink UI。JSON 模式（`main.ts:49-73`）与单提示模式（`main.ts:78-91`）同样没有。

**影响**: 默认交互模式下，任何 floating promise 的 rejection（UI 层 `void openFilePicker()`、`void replSession.saveThrottled()`、事件回调里的 async 抛错）都会让 Node 以退出码 1 终止，**会话不落盘**；Ink 的 React 树被硬杀，终端 raw mode / 备用屏幕来不及恢复。

**修复方案**: 在 `src/main.ts` **模块顶层**（`main({...})` 调用之前）注册全局守卫；移除 `runREPL` 内的重复注册，改为传入 runREPL 专属的保存回调。

**技术实现**:
```ts
// src/main.ts — 模块顶层
const EXIT = { OK: 0, FAILURE: 1, CANCELLED: 130, SIGTERM: 143 } as const;

function installGlobalCrashGuards(saveSnapshot: (reason: string) => Promise<void>): void {
  const onFatal = (err: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    const message = getErrorMessage(err);
    logger.main.error(`fatal ${kind}`, {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    console.error(chalk.red(`\n💥 Fatal ${kind}: ${message} — saving session before exit...`));
    void saveSnapshot(kind)
      .catch((saveErr) => logger.main.error('emergency save failed', { error: String(saveErr) }))
      .finally(() => process.exit(EXIT.FAILURE));
  };
  process.on('uncaughtException', (e) => onFatal(e, 'uncaughtException'));
  process.on('unhandledRejection', (e) => onFatal(e, 'unhandledRejection'));
}
```
`saveSnapshot` 在 REPL 路径传 `replSession.save`；在 Ink UI 路径传一个基于 `bootstrapState` 的等价快照函数（若 UI 路径暂无会话服务，至少落一份 emergency transcript 到 `~/.kc-cli/crash/`）。

**涉及文件**: `src/main.ts`（`:1-40` 顶层、`:214-231` 移除重复注册、`:500-513` 入口）
**验证**:
- 单元测试：`installGlobalCrashGuards` 注册后，`process.listenerCount('unhandledRejection') >= 1` 在任何 `onInteractiveUI` 路径下成立
- 手动冒烟：Ink UI 模式下触发一个 `Promise.reject()`，确认打印 fatal 提示且退出码为 1（而非 Node 默认堆栈后静默退出）
- `test/main*.test.ts` 全绿

---

### S4: MCP stdio 管道未监听 `'error'`（严重-2）

**Severity**: Critical（主进程崩溃）
**证据**:
- `src/mcp/transports/stdio.ts:81-90` — stdout/stderr 只挂 `data`，**没有 `error`**
- `src/mcp/transports/stdio.ts:149` — `this.process!.stdin!.write(header + message);` 无回调、无 error 监听
- `src/mcp/transports/stdio.ts:79` — 只有 `this.process.on('error', ...)`，仅覆盖 **spawn 级**失败，不覆盖**管道级**
- `src/mcp/transports/stdio.ts:177-192` — `disconnect()` 只移除 data/exit 监听器（侧面印证 error 监听器压根没加）

**Root Cause**: MCP server 进程意外退出（崩溃、被 OOM killer 杀、用户 kill）后继续 `sendRequest`，`stdin.write` 触发 `EPIPE`；或 stdout 流中途出错。`stream` 的 `'error'` 事件无监听器时 Node 会**向上抛未捕获异常**。

**影响**: **主 CLI 进程崩溃**。叠加 S3 后，一个第三方 MCP server 挂掉就能带走整个 agent 会话且不落盘。

**修复方案**: 为 `stdin` / `stdout` / `stderr` 各注册 `on('error')`，handler 统一走「记录 → 标记 transport 断开 → reject 所有 pendingRequests → 清理」；`stdin.write` 增加错误回调；`disconnect()` 中对称移除。

**技术实现**:
```ts
// src/mcp/transports/stdio.ts — connect() 内
const onPipeError = (err: Error): void => {
  logger.mcp.error('[MCP stdio] pipe error', { command, error: err.message, code: (err as NodeJS.ErrnoException).code });
  this.handleTransportFailure(err);   // 标记断开 + reject pendingRequests + 清理
};
this._onPipeError = onPipeError;
this.process.stdin?.on('error', onPipeError);
this.process.stdout?.on('error', onPipeError);
this.process.stderr?.on('error', onPipeError);
```
```ts
// send() 内
this.process!.stdin!.write(header + message, (err?: Error | null) => {
  if (err) onPipeError(err);
});
```
```ts
// disconnect() 内（对称移除）
if (this.process?.stdin && this._onPipeError) this.process.stdin.off('error', this._onPipeError);
if (this.process?.stdout && this._onPipeError) this.process.stdout.off('error', this._onPipeError);
if (this.process?.stderr && this._onPipeError) this.process.stderr.off('error', this._onPipeError);
```

**涉及文件**: `src/mcp/transports/stdio.ts`
**验证**:
- 新增测试：spawn 后立即 `kill -9` MCP server，再调 `send()` → 断言**不抛出未捕获异常**，而是 Promise 以可诊断错误 reject
- 断言 `disconnect()` 后 `process.listenerCount('error')` 归零（无监听器泄漏）
- `test/mcp/` 套件全绿

---

### S5: FileRead 流式预览在错误路径不 destroy（严重-5）

**Severity**: Critical（文件描述符泄漏 → 全局不可用）
**证据**:
- `src/tools/FileReadTool/index.ts:30-42`（`readHeadLines`）—
  ```ts
  for await (const line of rl) { lines.push(line); if (lines.length >= count) break; }
  rl.close();
  stream.destroy();   // ← 仅在成功路径执行
  ```
- `src/tools/FileReadTool/index.ts:47-59`（`readTailLines`）同构
- `src/tools/FileReadTool/index.ts:65-69`（`readLargeFilePreview`）用 `Promise.all` 并发开**两条**流

**Root Cause**: `for await` 抛错（EACCES、EISDIR、文件被并发删除、磁盘 I/O 错误、编码错误）时直接跳出，`rl.close()` / `stream.destroy()` 永不执行。`Promise.all` 下其中一条流 reject，另一条同样不会被销毁。

**影响**: **文件描述符泄漏**。长会话里反复读大文件/受限文件，fd 持续累积，最终 `EMFILE: too many open files`，此后所有文件工具、乃至配置加载与日志写入全部失败。Windows 上还会导致文件被句柄占用、无法删除或覆盖。

**修复方案**: 两个读取函数各包一层 `try/finally`；`readLargeFilePreview` 改用 `Promise.allSettled` 并保证部分失败仍能返回可用预览。

**技术实现**:
```ts
async function readHeadLines(filePath: string, count: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
      if (lines.length >= count) break;
    }
    return lines.join('\n');
  } finally {
    rl.close();
    stream.destroy();
  }
}
```
```ts
// readLargeFilePreview
const results = await Promise.allSettled([
  readHeadLines(filePath, PREVIEW_LINES),
  readTailLines(filePath, PREVIEW_LINES),
]);
// 两条都失败才抛出；单条失败降级为空片段，保证另一端句柄已由 finally 释放
if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
const head = results[0].status === 'fulfilled' ? results[0].value : '';
const tail = results[1].status === 'fulfilled' ? results[1].value : '';
```

**涉及文件**: `src/tools/FileReadTool/index.ts`
**验证**:
- 新增测试：对无权限文件（或目录路径）连续调用 `readLargeFilePreview` N 次，断言 `process._getActiveHandles?.()` 中 fs stream 数量不增长（或用 `lsof`/句柄计数间接断言）
- 新增测试：head 成功 / tail 失败的组合下仍返回非空 head 且不抛
- `test/tools/file-read*.test.ts` 全绿

---

### S6: `.mcp.json` 无 schema 校验即 spawn，且启动自动连接（严重-7）

**Severity**: Critical（RCE by clone）
**证据**:
- `src/mcp/config-loader.ts:51-57` —
  ```ts
  const parsed = JSON.parse(content);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') { return null; }
  return parsed as MCPConfig;   // ← 运行时不校验 command / args
  ```
- `src/mcp/config-loader.ts:19-24` — 项目级配置路径 `path.join(projectDir, '.mcp.json')`
- `src/bootstrap/Bootstrap.ts:256-268` — 启动阶段自动连接，无用户确认
- 最终落到 `src/mcp/transports/stdio.ts:70` — `spawn(command, args, ...)`
- `.mcp.json` 位于**项目目录**且**未被 `.gitignore` 覆盖**（`grep -n "mcp" .gitignore` 无输出），会随仓库提交

**Root Cause**: 配置来源与仓库同级、无 schema 校验、无信任确认、启动即执行。

**影响**: **RCE by clone** —— 克隆恶意仓库 → `cd` 进去 → 运行 `kc` → 其 `.mcp.json` 声明的任意命令被执行。与 S2 组合形成完整窃取链。

**修复方案**（三层防御）:
1. **Schema 校验**：Zod 定义 `MCPServerConfig`，`safeParse` 失败即拒绝该 server 并 warn。
2. **信任门控**：项目级（非 `~/.kc-cli/`）配置首次加载需用户确认，信任决策持久化到 `~/.kc-cli/mcp-trust.json`。
3. **非交互逃生舱**：非 TTY / `--yes` 模式下默认**跳过**项目级 server 并打印醒目警告（fail-closed），而非静默执行。

**技术实现**:
```ts
// src/mcp/schema.ts（新增）
export const MCPServerConfigSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  type: z.enum(['stdio', 'http']).default('stdio'),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
}).refine((c) => c.type === 'http' ? !!c.url : !!c.command, {
  message: 'stdio servers require `command`; http servers require `url`',
});
export const MCPConfigSchema = z.object({ mcpServers: z.record(MCPServerConfigSchema) });
```
```ts
// src/mcp/config-loader.ts — loadConfigFile 替换裸断言
const parsed = MCPConfigSchema.safeParse(JSON.parse(content));
if (!parsed.success) {
  logger.mcp.warn('MCP config rejected by schema', { filePath, issues: parsed.error.issues });
  return null;
}
return parsed.data;
```
```ts
// src/mcp/trust-store.ts（新增）
//  ~/.kc-cli/mcp-trust.json  { "<projectDirAbs>": { "serverName": "<iso8601 批准时间>" } }
export async function filterTrustedServers(
  servers: Record<string, MCPServerConfig>,
  projectDir: string,
  opts: { interactive: boolean },
): Promise<{ approved: Record<string, MCPServerConfig>; pending: string[] }>;
```
- `interactive === true`：对未信任项弹确认（复用 `AskUserTool` 的交互通道或 ink dialog），批准后写入 trust store
- `interactive === false`（CI / 管道输入）：**全部 pending**（不执行），并 `logger.mcp.warn` + 启动横幅提示 `kc mcp trust <name>` 如何授权

**涉及文件**: `src/mcp/schema.ts`（新增）、`src/mcp/config-loader.ts`、`src/mcp/trust-store.ts`（新增）、`src/bootstrap/Bootstrap.ts:254-298`
**blockedBy**: S1 / S2（`buildSafeEnv` 先就位，保证即使被信任的 server 也拿不到 `KC_*`）
**验证**:
- 单测：`{ mcpServers: { x: { command: 123 } } }`、缺 `command` 的 stdio 配置、畸形 JSON → 全部被拒且返回 `null`
- 单测：非交互模式下项目级 server 全部 pending（不 spawn）
- 单测：trust store 写入后二次加载不再询问
- 集成：`.gitignore` 增加 `.mcp.json` 建议项（写入 `.env.example` 旁的说明或 README 小节）——**注意**：是否默认 ignore 需产品决策，见 §9 风险

---

## 3. P1 修复方案 —— 并发与运行时正确性

### R1: FileEdit 读-改-写跨执行器无互斥（严重-3）

**Severity**: Critical（静默数据丢失）
**证据**:
- `src/tools/FileEditTool/index.ts:40` 读 → `:71` 写，中间无锁
- `src/tools/FileEditTool/index.ts:129` — `isConcurrencySafe: () => false`
- `src/executors/toolExecutor.ts:698-708` — 该标志只能把**单个** `executeParallel` 批次内降级为串行
- 每个子代理（`InProcessBackend`）持有**各自的** QueryEngine 与 ToolExecutor，串行化作用域不跨执行器；`GLOBAL_TOOL_SEMAPHORE`（`toolExecutor.ts:123`）不含 FileEdit
- 全仓 grep `Mutex|mutex|withLock|fileLock` 无有效命中；`Semaphore`（`src/utils/semaphore.ts`）只用于限流

**Root Cause**: `writeFileAtomic`（随机 tmp + rename）只保证**不撕裂**，不保证**不覆盖**。

**影响**: 两个子代理（或 AgentTool 编排的并行任务）同时编辑同一文件时，后写者基于过期 `content` 整体覆盖，前者的修改无声消失，而 `changes` 与 diff 预览都显示「成功」。**全项目唯一会造成用户数据无声丢失的路径。**

**修复方案（分两阶段）**:
- **阶段 A（过渡，约 20 行）—— 乐观并发控制**：读时记录 `mtimeMs` + `size`，写前重新 `stat` 校验，冲突时返回 `is_error` 让模型重试。
- **阶段 B（完整）—— 文件级互斥锁**：在 `ExecutionEnv` 增加 `withFileLock(path, fn)`，按 `resolvedPath` 分片，把整个读-改-写包进锁内。

**技术实现（阶段 B）**:
```ts
// src/services/file-lock.ts（新增）
const locks = new Map<string, Semaphore>();

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let sem = locks.get(key);
  if (!sem) { sem = new Semaphore(1); locks.set(key, sem); }
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
    if (sem.pendingCount === 0) locks.delete(key);   // 防止 Map 无限增长
  }
}
```
```ts
// src/services/execution-env.ts — ExecutionEnv 增加可选能力
export interface ExecutionEnv {
  fs: FileSystem;
  shell: Shell;
  /** 按 resolvedPath 分片的互斥锁；未提供时调用方退化为无锁路径 */
  withFileLock?<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T>;
}
```
```ts
// FileEditTool / FileWriteTool 调用点
const run = async () => { /* 读 → 改 → writeFileAtomic */ };
const out = context.env.withFileLock
  ? await context.env.withFileLock(resolvedPath, run)
  : await run();
```

**涉及文件**: `src/services/file-lock.ts`（新增）、`src/services/execution-env.ts`、`src/services/execution-env-local.ts`、`src/tools/FileEditTool/index.ts`、`src/tools/FileWriteTool/index.ts`
**验证**:
- 并发测试：两个协程/子代理对同一文件各追加一行不同内容，各执行 50 次；断言最终文件**同时包含**两方的 100 行（而非只剩一方）
- 单测：`withFileLock` 在 `fn` 抛错时仍释放许可（后续调用不被永久阻塞）
- 单测：`locks` Map 在无等待者时被清理（无内存增长）
- 回归：`test/tools/file-edit*.test.ts` 全绿

---

### R2: JSON 模式 readline 并发驱动同一 QueryEngine（严重-4）

**Severity**: Critical（状态机非法转移 / 对话污染）
**证据**: `src/main.ts:59-72` — `rl.on('line', async (line) => { for await (const event of queryEngine.submitMessage(trimmed)) ... })`

**Root Cause**: `readline` 的 `'line'` 是事件回调，**不会等待 async 回调完成**。管道连续喂入多行（脚本化调用、CI、`kc --json < input.txt`）会立即并发进入多个 `submitMessage`，共享同一 `conversation`、状态机（`src/state/machine.ts`）与 compaction 状态。

**影响**: 并发 `submitMessage` 争抢状态机，`transitionTo` 抛 `InvalidTransitionError`（`machine.ts:59-61`），事件序列与 `sequence` 编号交错错乱、对话历史交叉污染；严重时查询永久卡在非终态。

**修复方案**: 忙锁 + 队列串行化 —— line 回调只 push 到队列，另起单一消费者循环 `await` 处理。

**技术实现**:
```ts
// src/main.ts — runJSONMode 内
const pending: string[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const line = pending.shift()!;
      try {
        for await (const event of queryEngine.submitMessage(line)) emit(event);
      } catch (error) {
        emit({ type: 'error', error: { message: getErrorMessage(error) }, timestamp: Date.now() });
      }
    }
  } finally {
    draining = false;
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pending.push(trimmed);
  void drain();
});
```

**涉及文件**: `src/main.ts:59-72`
**验证**:
- 新增测试：一次性通过 stdin 喂入 3 行，断言 `submitMessage` 被串行调用（用 spy 记录进入/离开时序，断言无重叠区间）
- 断言 `sequence` 单调递增无重复
- 回归：JSON 模式现有测试全绿

---

### R3: 退出码与失败路径不一致（严重-6）

**Severity**: Critical（CI 无法判定失败）
**证据**:
- `src/main.ts:131-133` — `case 'agent:tool_permission_denied': console.log(...); break;`（退出码仍 0）
- `src/main.ts:147-149` — `case 'agent:error': console.error(...); break;`（仍正常结束）
- `src/ui/renderer.tsx:33-36` — `const onTerminate = () => { process.exit(0); };`
- 只有真正抛异常才是 1（`main.ts:89`、`:510-513`）

**Root Cause**: 没有统一的「本次运行是否成功」标记。

**影响**: 被拒权限、超预算、agent 内部错误、被取消全部返回 0，自动化流水线把失败当成功放行。SIGTERM 返回 0 会让编排系统误判为优雅退出。

**修复方案**:
1. 定义 `EXIT` 常量表（成功 0 / 失败 1 / 用户取消 130 / SIGTERM 143）。
2. 引入 `RunOutcome { failed: boolean; reason?: string }`，在 `agent:error`、`agent:tool_permission_denied`、`tool_failed`、`budget_exceeded` 分支置位。
3. `executePrompt` / `runJSONMode` / REPL 结束时按 outcome 决定退出码。
4. `renderer.tsx` 的 SIGTERM 改为 `EXIT.SIGTERM`。

**技术实现**:
```ts
// src/utils/exit-codes.ts（新增）
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  CANCELLED: 130,     // SIGINT（用户 Ctrl+C）
  SIGTERM: 143,       // 128 + 15
} as const;

export interface RunOutcome { failed: boolean; reasons: string[]; }
export const createOutcome = (): RunOutcome => ({ failed: false, reasons: [] });
export const markFailed = (o: RunOutcome, reason: string): void => {
  o.failed = true;
  if (!o.reasons.includes(reason)) o.reasons.push(reason);
};
```
```ts
// ui/renderer.tsx:33-36
const onTerminate = () => { process.exit(EXIT.SIGTERM); };
```

**涉及文件**: `src/utils/exit-codes.ts`（新增）、`src/main.ts`（`:95-160` handleStreamEvent、`:78-91` executePrompt、`:40-73` runJSONMode）、`src/ui/renderer.tsx:33-36`
**blockedBy**: S3（先统一崩溃退出路径，再统一正常退出路径，避免两处打架）
**验证**:
- 单测：`agent:tool_permission_denied` 事件 → outcome.failed === true → 退出码 1
- 单测：正常完成 → 退出码 0
- 集成：模拟 SIGTERM → 退出码 143（用子进程实跑断言）
- 回归：现有 CLI 集成测试全绿

---

### R4: 编排器 semaphore 无超时、无兜底释放（严重-10）

**Severity**: Critical（子代理编排永久死锁）
**证据**:
- `src/orchestrator/agent-orchestrator.ts:60` `await this.semaphore.acquire();`
- `:73-84` `releaseOnTerminal` 是**唯一**释放路径
- `:86` `let released = false;` —— **从未被赋 `true`**，该保护路径是死代码
- `:35` `new Semaphore(maxConcurrentAgents)` 未传 `timeoutMs`（默认 0 = 无超时）

**Root Cause**: 释放唯一依赖后端发出四个终端事件之一。若 agent 被外部 kill、事件总线丢事件（`event-bus.ts` buffer 有 size limit 可能覆盖旧事件）、或 spawn 成功后 agent 从未发出任何终端事件，许可**永久泄漏**。

**影响**: 泄漏累计至 8 后 `spawn()` 在 `:60` **永久阻塞**，所有子代理编排（AgentTool / TeamCreate）彻底死锁，无超时、无告警、无法自愈。

**修复方案**: acquire 加超时；`releaseOnTerminal` 置 `released = true` 并做幂等；超时/取消路径显式释放；释放时记录日志便于诊断泄漏。

**技术实现**:
```diff
- this.semaphore = new Semaphore(maxConcurrentAgents);
+ this.semaphore = new Semaphore(maxConcurrentAgents, SPAWN_PERMIT_TIMEOUT_MS); // 30_000
```
```ts
let released = false;
const releaseOnce = (reason: string): void => {
  if (released) return;                    // 幂等
  released = true;
  this.semaphore.release();
  unsubscribe();
  logger.orchestrator.debug('subagent permit released', { agentId, reason });
};

const releaseOnTerminal = (event: AgentEvent | MultiAgentEvent): void => {
  if (isTerminalEvent(event.type)) releaseOnce(`terminal:${event.type}`);
};
const unsubscribe = this.eventBus.on(agentId, releaseOnTerminal);

try {
  this.aggregator.register(agentId, config);
  return agentId;
} catch (error) {
  releaseOnce('register-failed');
  throw error;
}
```
同步检查 `waitForCompletion` / `waitForAll` 的超时路径（`:199-202`）是否显式调用 `releaseOnce('timeout')`。

**涉及文件**: `src/orchestrator/agent-orchestrator.ts`
**验证**:
- 单测：spawn 后后端**永不**发终端事件 → 30s 后 `acquire` 超时抛错（可用 fake timer 加速）
- 单测：重复触发终端事件 → 只 release 一次（断言 `semaphore` 可用许可数不超过初始上限）
- 单测：`aggregator.register` 抛错 → 许可被释放
- `test/orchestrator/` 全绿

---

### R5: 未知工具被默认判定为并发安全，fail-open（严重-11）

**Severity**: Critical（副作用交错）
**证据**:
- `src/executors/toolExecutor.ts:701-708` —
  ```ts
  const tool = this.tools.get(toolCall.toolName);
  if (tool?.isConcurrencySafe?.(toolCall.input) !== false) { concurrentTools.push(toolCall); }
  ```
- `src/Tool.ts:35` — `isConcurrencySafe: definition.isConcurrencySafe ?? (() => true)`

**Root Cause**: 可选链 + `!== false` 比较，使「查不到工具」这一**异常**情况落入并发分组。

**影响**: LLM 幻觉出的工具名、MCP 工具未加载完成、插件工具卸载后残留调用，都会命中 —— 未知工具被放进 `Promise.allSettled` 并发执行（`:727`），有副作用的工具可能并行产生不可预期的交错。

**修复方案**: 未知工具不进入任何执行分组，直接返回 `tool_not_found` 错误结果。

**技术实现**:
```ts
for (const toolCall of toolCalls) {
  const tool = this.tools.get(toolCall.toolName);
  if (!tool) {
    logger.tools.warn('unknown tool requested — refusing to execute', { toolName: toolCall.toolName });
    results.set(toolCall.id, toolError(`Unknown tool: ${toolCall.toolName}`));
    continue;                                   // 不进入并发组，也不进入串行组
  }
  if (tool.isConcurrencySafe?.(toolCall.input) === false) sequentialTools.push(toolCall);
  else concurrentTools.push(toolCall);
}
```

**涉及文件**: `src/executors/toolExecutor.ts:698-708`
**验证**:
- 单测：传入不存在的工具名 → 返回 `is_error` 结果且错误信息含工具名；**不抛异常**
- 单测：确认未知工具未被放入 `Promise.allSettled`（用 spy 断言 `executeSingle` 未被调用）
- `test/executors/` 全绿

---

### R6: `QueryEngineVerification` 测试路径硬编码 `bash`（轻微-8，本轮升为 P1）

**Severity**: Major（Windows 上测试门禁**静默放行**）
**证据**:
- `src/query/QueryEngineVerification.ts:129-152` — type-check 路径已用 `shell: true` + `windowsHide`
- `src/query/QueryEngineVerification.ts:224-240` — 测试验证路径仍是 `spawn('bash', ['-c', command], ...)`
- `src/query/QueryEngineVerification.ts:123-128` — 注释明确说明「T5 (H5) 改用平台默认 shell 而不是硬编码 bash，否则 Windows 上成为静默 no-op」

**Root Cause**: 上一轮修复只改了 type-check 路径，测试路径漏改。

**影响**: **在本项目当前的 Windows 开发环境下必然触发** —— `spawn('bash')` 报 ENOENT → `child.on('error', reject)` → catch → 测试门禁静默放行。正是 123-128 注释所警告的失败模式。

**修复方案**: 抽取共享的 `runCommand()`，两处统一使用平台默认 shell。

**技术实现**:
```ts
// src/tools/shared/command-execution.ts — 新增（已有模块，见 round3 T19）
export interface RunCommandResult {
  stdout: string; stderr: string; code: number; timedOut: boolean;
}
export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,          // 平台默认 shell（Windows: cmd.exe / POSIX: /bin/sh）
      windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); resolve({ stdout, stderr, code: -1, timedOut: true }); }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1, timedOut: false }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
```
调用点 `QueryEngineVerification.ts:129` 与 `:226` 统一改为 `runCommand(command, { cwd, timeoutMs })`。

**涉及文件**: `src/tools/shared/command-execution.ts`、`src/query/QueryEngineVerification.ts`（`:129-152`、`:224-240`）
**验证**:
- Windows 实跑：`npm test` 中验证门禁**真正执行**（不再是静默 no-op）
- 单测：`runCommand` 在超时时返回 `timedOut: true` 且不泄漏子进程句柄
- 回归：POSIX 环境行为不变

---

### R7: `LocalShell` 把 AbortError 当普通命令失败（中等-1）

**Severity**: Major（取消后继续产生副作用）
**证据**:
- `src/services/execution-env-local.ts:201-216` — catch 内 `const exitCode = typeof err.code === 'number' ? err.code : 1;`（AbortError 落到这里 = 1）
- `src/tools/BashTool/index.ts:69-74` 传 `signal`，`:76` 只按 `exitCode !== 0` 判定失败

**Root Cause**: catch 不区分 AbortError / 超时 kill / 真实非零退出，统一降级为 `exitCode: 1` 的成功返回（不抛错）。

**影响**: 用户 Ctrl+C 或工具超时后，Bash 工具**不是**返回「已取消」，而是返回 `Command failed: ...`，还会走 `handleNonZeroExit` 生成**误导性诊断**。模型据此认为命令本身有问题并**自动重试 / 改写命令**，而用户以为已取消 —— 取消后继续产生副作用。

**修复方案**: catch 中优先识别取消信号并向上抛，让 `executeWithTimeout` 与上层区分「取消」与「失败」。

**技术实现**:
```ts
} catch (error: unknown) {
  // 取消必须上抛：否则调用方只看到 exitCode 1，会误判为「命令本身有问题」并自动重试
  const maybeAbort = error as { name?: string; code?: string };
  if (maybeAbort?.name === 'AbortError' || maybeAbort?.code === 'ABORT_ERR') {
    logger.services.info('[shell] command aborted by signal', { command: command.slice(0, 200) });
    throw error;
  }
  const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
  ...
}
```
同步确认 `BashTool` / `RunTool` 的调用点能正确传播取消（返回给模型的消息应为「已取消」而非「命令失败」）。

**涉及文件**: `src/services/execution-env-local.ts:201-216`、`src/tools/BashTool/index.ts:69-80`、`src/tools/RunTool/index.ts`
**验证**:
- 单测：传入已 abort 的 `AbortSignal` → `exec` 抛 AbortError（而非返回 exitCode 1）
- 单测：真实非零退出（如 `exit 3`）仍返回 `exitCode: 3`（不被误判为取消）
- 回归：`test/tools/bash*.test.ts` 全绿

---

### R8: SqlTool worker 未知消息时 Promise 永不 settle（中等-3）

**Severity**: Major（永久挂起 + 全局信号量饿死）
**证据**: `src/tools/SqlTool/index.ts:261-274` —
```ts
worker.on('message', (msg) => {
  clearTimeout(timer);                              // ← 先解除超时保护
  if (msg.type === 'error') { reject(...); }
  else if (msg.type === 'result') {
    if ('rows' in msg.data) { resolve(...); }        // msg.data 为 undefined 时抛 TypeError
    else { resolve(...); }
  }
  // ← 没有 else 分支
});
```

**Root Cause**: `msg.type` 既非 `'error'` 也非 `'result'`（worker 版本不匹配、新增消息类型、畸形 payload）时既不 resolve 也不 reject，而 `clearTimeout(timer)` 已执行、超时保护被提前解除。

**影响**: 查询**永久挂起**；期间全局 `GLOBAL_TOOL_SEMAPHORE` 许可（`toolExecutor.ts:110,123` 含 `'Sql'`）被一直占用，多次触发可耗尽全部许可，导致后续 Bash / Run / Sql / WebFetch **全部排队饿死**。

**修复方案**: 补 `else` reject；resolve 前校验 `msg.data`；整体包 try/catch。

**技术实现**:
```ts
worker.on('message', (msg: { type: string; data?: any; error?: string }) => {
  clearTimeout(timer);
  try {
    if (msg.type === 'error') {
      reject(new Error(msg.error ?? 'Unknown worker error'));
      return;
    }
    if (msg.type === 'result') {
      if (!msg.data) { reject(new Error('Malformed worker result: missing data')); return; }
      if ('rows' in msg.data) { resolve({ type: 'select', rows: msg.data.rows }); return; }
      resolve({ type: 'write', changes: msg.data.changes, lastInsertRowid: msg.data.lastInsertRowid });
      return;
    }
    reject(new Error(`Unexpected worker message type: ${msg.type}`));
  } catch (e) {
    reject(e instanceof Error ? e : new Error(String(e)));
  }
});
```

**涉及文件**: `src/tools/SqlTool/index.ts:261-274`
**验证**:
- 单测：worker 发送 `{ type: 'unknown' }` → Promise 以可诊断错误 reject（而非挂起）
- 单测：worker 发送 `{ type: 'result' }`（无 data）→ reject 而非 TypeError
- 单测：上述两种情况下 semaphore 许可均被释放
- `test/tools/sql*.test.ts` 全绿

---

## 4. 可观测性修复方案（O1–O6）

> **共性问题**：301 个源文件中统一 logger 仅 166 处调用；`console.*` 134 处里 80 处堆在 `main.ts`。以下 6 个模块的 `logger.*` 计数为 **0**：`api/BaseApiClient.ts`(481 行)、`services/circuitBreaker.ts`、`services/budget.ts`(249 行)、`mcp/client-manager.ts`、`lsp/client.ts`、`executors/toolExecutor.ts`（审计分支）。
>
> **统一要求**：每条日志至少带 `{ ..., durationMs?, attempt?, requestId? }`；错误文本一律先截断（≤500 字符）再正则脱敏（`/(sk-|Bearer |token=|KC_[A-Z_]+=)[^\s"']+/gi` → `[REDACTED]`）。

### O1: LLM 请求全链路零日志（中等-5）

**证据**: `src/api/BaseApiClient.ts:336-349`（`handleApiError` 只 throw）、`:386-388`（失败路径）；`grep -c "logger\." src/api/BaseApiClient.ts` → 0 ⚠️
**影响**: 429 / 500 / 超时**完全无法追溯**；无法区分「网络问题」与「密钥失效」。另 `:380` 把 `errorText` 原样嵌入错误消息，若上游代理回显请求头，密钥可能经错误消息进入 UI 与日志。
**修复**: 在 `withChatErrorHandling` 与流式等价方法中包裹计时与日志：
```ts
const startedAt = Date.now();
try {
  ...
} catch (error) {
  logger.api.error('llm request failed', {
    op, provider: this.provider, model: this.model,
    statusCode: extractStatus(error), durationMs: Date.now() - startedAt,
    attempt, requestId,
    message: redact(getErrorMessage(error)).slice(0, 500),
  });
  this.handleApiError(error, failureContext ?? `Failed to call ${op} API`);
}
```
`handleApiError` 同理：嵌入消息前先 `redact(...).slice(0, 500)`。
**涉及文件**: `src/api/BaseApiClient.ts`
**验证**: 单测用假 fetch 注入 500 → 断言 `logger.api.error` 被调用且 payload 含 `statusCode`/`durationMs`；断言 `errorText` 中的 `sk-xxx` 被脱敏。

---

### O2: 断路器状态转换静默（中等-6）

**证据**: `src/services/circuitBreaker.ts:76-86`（`_state = 'open'` 处无日志）；`memory/memoryExtraction.ts:413` 提取断路器（`CIRCUIT_BREAKER_THRESHOLD = 3`）同样静默 ⚠️
**影响**: 用户只看到「请求莫名失败/被拒」，无法得知断路器已开闸。
**修复**: 每次状态迁移打日志，并在 UI 状态栏暴露断路器状态。
```ts
private transition(to: CircuitState, reason: string): void {
  if (this._state === to) return;
  const from = this._state;
  this._state = to;
  logger.api.warn('circuit breaker state transition', {
    name: this.name, from, to, reason,
    failures: this.failureCount, threshold: this.config.failureThreshold,
    resetTimeoutMs: this.config.resetTimeoutMs,
  });
}
```
**涉及文件**: `src/services/circuitBreaker.ts`、`src/memory/memoryExtraction.ts:413`
**验证**: 单测连续 `recordFailure()` 至阈值 → 断言 warn 日志产生且 `from/to` 正确；断言重复触发不刷屏（同状态不重复记）。

---

### O3: MCP 重连耗尽后静默降级（中等-7）

**证据**: `src/mcp/client-manager.ts:248-264` — `if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { conn.status = 'error'; return; }`；catch 块为**空 catch**（连错误对象都不接收）⚠️
**影响**: MCP server 崩溃后其注册的所有工具静默变为不可用，用户只看到「工具不存在」，看不到真实原因。
**修复**:
```ts
} catch (err) {
  logger.mcp.error('MCP reconnect failed', {
    serverId, attempt: conn.reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS,
    nextDelayMs: BASE_RECONNECT_DELAY_MS * 2 ** conn.reconnectAttempts,
    reason: redact(getErrorMessage(err)),
  });
  conn.status = 'error';
}
```
重连最终失败时额外推送一条 UI 事件（`mcp:server_unavailable`）。
**涉及文件**: `src/mcp/client-manager.ts:248-264`
**blockedBy**: S4（先修管道 error 监听，再改重连日志，避免两个改动互相掩盖症状）
**验证**: 单测 mock transport 连续失败 → 断言 3 次尝试均有 error 日志，最终 `status === 'error'` 且发出 UI 事件。

---

### O4: 预算耗尽无日志，且默认配置实为「无限」（中等-8）

**证据**: `src/services/budget.ts:100-107`、`:140`、`:178` 三处 `allowed: false` 分支均无日志；`grep -c "logger\." src/services/budget.ts` → 0；`DEFAULT_BUDGET_CONFIG`（`:46-52`）为 `Number.MAX_SAFE_INTEGER` + `costLimitUsd: null` ⚠️
**影响**: 预算拒绝不落日志 —— 审计与告警无从下手；默认值无限意味着绝大多数用户其实没有保护。
**修复**: 三处分支加 warn 日志。**默认值变更需产品决策**（见 §9）：建议改为「关闭但显式」（`null` 表示无限，但启动时若检测到未配置则在 verbose 下提示一次），而非悄悄给一个数字。
**涉及文件**: `src/services/budget.ts`
**验证**: 单测设 `costLimitUsd = 0.01` 后触发 → 断言 warn 日志含 `{ kind, tokens, costUsd, limit }`。

---

### O5: 会话持久化失败被完全静默吞掉（中等-12）

**证据**: `src/services/replSession.ts:89-97` 空 catch；调用点 `src/main.ts:218`（`void replSession.save(queryEngine).finally(() => process.exit(0));`）、`:228`、`:255` ✅ 已核验
**影响**: 磁盘满 / 权限变更 / `.kc-cli` 被误删时，用户看到「👋 Goodbye!」以为已保存，`/session list` 却查不到 —— 数小时对话无声消失。且 `:218` 的 `.finally()` 无 `.catch()`。
**修复**:
```ts
} catch (error) {
  this.saveFailureCount++;
  logger.services.warn('session persistence failed (best-effort)', {
    sessionId: state.sessionId, failureCount: this.saveFailureCount,
    reason: redact(getErrorMessage(error)),
  });
}
```
`main.ts` 侧改为 `void save(...).catch(() => {}).finally(...)`；退出前若 `saveFailureCount > 0` 打印醒目警告。
**涉及文件**: `src/services/replSession.ts:89-97`、`src/main.ts:214-231,255,266`
**blockedBy**: S3（先统一崩溃退出路径，再改正常退出的保存失败提示）
**验证**: 单测 mock `saveSession` 抛错 → 断言 warn 日志 + `saveFailureCount` 递增 + 进程仍正常退出（不崩溃）。

---

### O6: LSP 静默吞异常 + 审计空 catch（中等-11 / 严重-12）

**证据**: `src/lsp/client.ts:141-143`（`catch { return []; }`）、`:191-193`（`catch { return null; }`）、`:81`（`proc.on('error', () => {})` 空实现）；`src/executors/toolExecutor.ts:550-552`（审计 `catch {}`）、`:572-575`（`getSessionIdSafe` 裸 catch）⚠️
**影响**: LSP 诊断整体失效时，用户和模型只看到「没有任何诊断」，会**误判为「代码没有问题」**进而做出错误决策。审计覆盖 FileWrite/FileEdit/Bash/Run/Git 等高危操作，失败**完全无声** —— 磁盘满/权限问题时审计 trail 静默缺失，事后无法追溯 agent 做过什么。
**修复**:
```ts
// lsp/client.ts
} catch (error) {
  logger.lsp.warn('LSP request failed', {
    method, filePath,
    reason: redact(getErrorMessage(error)),
    kind: classifyLspError(error),   // 'spawn-enoent' | 'timeout' | 'protocol' | 'io'
  });
  return [];
}
```
```ts
// toolExecutor.ts 审计分支
} catch (error) {
  this.auditFailureCount++;
  logger.audit.warn('operation audit record failed', {
    toolName, sessionId: safeSessionId, failureCount: this.auditFailureCount,
    reason: redact(getErrorMessage(error)),
  });
}
```
对 `spawn ENOENT` 做一次性降级提示（避免每次调用都重试拉起语言服务器）。
**涉及文件**: `src/lsp/client.ts:63-193`、`src/executors/toolExecutor.ts:536-575`
**验证**:
- 单测：语言服务器二进制不存在 → 断言 warn 日志含 `kind: 'spawn-enoent'`，且仅提示一次
- 单测：审计写入失败 → 断言 `logger.audit.warn` 被调用且计数递增
- 回归：`test/lsp/`、`test/executors/` 全绿

---

## 5. 性能修复方案（P1–P4）

### P1: 启动期 `preloadAllTools()` 强制加载全部 lazy 工具（中等-13）

**证据**: `src/tools.ts:102-105`（`await Promise.all(entries.map(entry => this.ensureTool(entry.name)))`）；`src/bootstrap/Bootstrap.ts:248`；`src/tools/registry.ts:62-76`（12 个 `eager: false`）✅
**Root Cause**: `Bootstrap.ts:244-247` 注释说明了动机（「否则 getAllTools() 只返回 eager 工具，模型看不到 deferred 的」）—— 为了让**工具清单**完整，把**模块加载**也一并做了。
**影响**: 每次冷启动都 `import` 12 个模块，含 `better-sqlite3`（原生模块，链接开销大）、LSP、Docker。实际只需要它们的**名字和 schema** 来组装 prompt。
**修复方案（推荐：清单与实现分离）**:
1. 把 `name` / `description` / `inputSchema` 抽为构建期生成的清单文件 `src/tools/tool-catalog.generated.ts`（用 `tsx scripts/gen-tool-catalog.ts` 从各模块导出提取，纳入 `prebuild`）。
2. `TOOL_MANIFEST` 保留 `modulePath` 用于真正调用时的动态 import。
3. `getAllTools()` 从 catalog 合成清单项；首次 `call` 时再 `ensureTool()`。
4. **过渡方案**（若 catalog 生成成本过高）：`preloadAllTools()` 改为后台预热，不阻塞启动：
```ts
// Bootstrap.ts:248
void toolRegistry.preloadAllTools().catch((e) => logger.tools.warn('tool preload failed', { error: String(e) }));
```
**涉及文件**: `src/tools.ts`、`src/tools/registry.ts`、`src/bootstrap/Bootstrap.ts:243-249`、`scripts/gen-tool-catalog.ts`（新增）、`package.json`（prebuild hook）
**验证**: 启动 profile（`getProfileReport()`）对比 `tools_registered` checkpoint 耗时；断言 `better-sqlite3` 在启动阶段未被 `require`（用 `require.cache` 断言）。

---

### P2: MCP 连接阻塞启动关键路径 + 30s 硬编码（中等-14）

**证据**: `src/bootstrap/Bootstrap.ts:254-298`（`await Promise.allSettled(connectionPromises)`，位于 UI 渲染之前）；`:260` `const connectionTimeout = 30000;` 硬编码，配置表（`src/bootstrap/config.ts` 643 行）**无此项** ✅
**影响**: 配了 3-5 个 MCP server 且其中一个挂起时，**启动被阻塞最长 30 秒**，期间无 UI。另 `:279-283` 用 `console.warn` 绕过统一 logger。
**修复方案**:
1. MCP 连接移出关键路径 —— 先渲染 UI，后台连接，工具通过事件增量注册。
2. `connectionTimeout` 提为配置项 `mcp.connectionTimeoutMs`，默认降到 8-10s。
3. `console.warn` 改 `logger.mcp.warn`。
**涉及文件**: `src/bootstrap/Bootstrap.ts:252-303`、`src/bootstrap/config.ts`、`src/mcp/client-manager.ts`
**blockedBy**: O1–O6 中的 logger 改造（至少 `logger.mcp` 可用）—— 轻量依赖，可与 T18 并行
**验证**: 启动 profile 断言 UI 渲染不再等待 `mcp_initialized`；单测断言配置项可覆盖超时。

---

### P3: 权限热路径 `realpathSync`（本次审查新发现）

**证据**: `src/permissions/engine.ts:330` `fs.realpathSync(value)` ← `tryRealpath()` ← `checkSecurityCritical()` 对 `extractAllStringValues(input)` 返回的**每一个**「看起来像路径」的字符串（`:356-362`）调一次 ✅
**Root Cause**: 同步系统调用位于每次工具调用的权限检查路径上；嵌套输入或长命令场景下单次检查可能触发多次 realpath。
**修复方案**: 引入短 TTL 缓存（路径 → realpath），复用现有 `TieredCache`。
```ts
const realpathCache = getCacheManager().getOrCreate<string>('permissions-realpath', 'permissions', {
  maxSize: 2000, defaultTtlMs: 5_000,
});
function tryRealpathCached(value: string): string | null {
  const hit = realpathCache.get(value);
  if (hit !== undefined) return hit;
  const resolved = tryRealpath(value);
  if (resolved) realpathCache.set(value, resolved);
  return resolved;
}
```
**权衡**：5s TTL 意味着符号链接被重新指向后最多有 5s 窗口使用旧解析结果。**安全相关，需评审确认** —— 若不接受，改为仅在「同一批次内去重」的 per-call Map（零 staleness，仍有去重收益）。
**涉及文件**: `src/permissions/engine.ts:321-334,356-362`
**验证**: 单测断言同一路径在 TTL 内只触发一次 `realpathSync`（spy 计数）；安全回归测试（`test/permissions/`）全绿。

---

### P4: 启动阶段串行化

**证据**: `src/bootstrap/Bootstrap.ts` 各 Phase 为串行 await，checkpoint 位于 `:211,221,239,250,303,324,373,417,477,523,556` ✅
**分析**: 真实依赖链为 `config → tools → MCP` 与 `plugins → plugin-MCP`；而 `git detect`（`:228`）、`AGP`（`:380`）、`IM`（`:423`）与它们**基本独立**。
**修复方案**: 并行化无依赖分支：
```
config load ─┬─→ git detect（并行）
             └─→ tools register → MCP connect → plugin MCP
plugins load → plugin init      （与 tools/MCP 并行）
AGP init / IM init              （与 plugins 并行，仅依赖 config）
```
**预期收益**：**中等偏低** —— 各阶段本身耗时不长，主要收益在于把 AGP / IM / 插件初始化从串行链中摘出。真正的启动大头是 P1（工具模块加载）与 P2（MCP 连接），建议**先做 P1/P2 再评估是否值得做 P4**。
**涉及文件**: `src/bootstrap/Bootstrap.ts`
**blockedBy**: P1 / P2（先消除两个大头，再评估并行化的边际收益）
**验证**: `getProfileReport()` 对比各 checkpoint 的 wall-clock 差值；断言行为无变化（集成测试全绿）。

---

## 6. 可维护性修复方案（M1–M9）

> 本节为技术债偿还，无即时故障风险。建议按模块分批，优先做**已经出现行为/功能分叉**的 M1、M2。

### M1: orchestrator 两个 backend 生命周期大面积复制（轻微-1）

**证据**: `in-process.ts:128-143` vs `subprocess.ts:109-124`（runtime 字面量）、`in-process.ts:221-228` vs `subprocess.ts:290-297`（catch 返回）、`in-process.ts:357-365` vs `subprocess.ts:306-314`（队列 256 上限）、`in-process.ts:432-450` vs `subprocess.ts:346-357`（getStatus/listActive/shutdownAll）、`in-process.ts:246` vs `subprocess.ts:271`（超时表达式）⚠️
**已出现行为分叉**: `in-process.ts:77-83` 有 `tryEmitTerminalEvent()` 防重复终结事件守卫；`subprocess.ts` 的 result/error/exit 三个分支（`:169/188/216`）直接 `emit`，**没有该守卫**。
**修复**: 新建 `src/orchestrator/backends/backend-shared.ts`，导出 `createSubAgentRuntime()` / `nextAgentId()` / `capMessageQueue()` / `resolveTimeoutMs()` / `emitTerminal()`；两个 backend 的 `getStatus/listActive/shutdownAll` 提到 `abstract class BaseSubAgentBackend`。**顺带统一终结事件守卫。**
**涉及文件**: `src/orchestrator/backends/backend-shared.ts`（新增）、`in-process.ts`、`subprocess.ts`
**验证**: `test/orchestrator/` 全绿；新增「subprocess 后端不重复发送终结事件」用例。

---

### M2: compaction 摘要 prompt 重复**且已功能分叉**（轻微-2）

**证据（✅ 已人工 diff 核验，修正子代理「逐字节相同」的说法）**:
- `src/services/compaction/full.ts:41-60` vs `functional.ts:241-260` — 摘要 prompt 主体 **17 行相同**，但结构不同：`full.ts:41` 用 `return \`...\``；`functional.ts:241` 用 `let prompt = \`...\``，随后 `:260` 追加 `// Append modified files list for explicit preservation` —— **functional.ts 多了一个 full.ts 没有的增强**
- `full.ts:64-79` vs `functional.ts:331-346` — `buildFallbackSummary()` **15 行实质相同**（仅末尾空行差异）
**影响**: 两份 prompt 已分叉，同样会话走不同引擎会得到不同压缩质量；改 prompt 措辞时极易漏改一边。
**修复**: 抽 `src/services/compaction/prompts.ts` 导出 `buildSummaryPrompt(systemPrompt, conversationText, modifiedFiles?)` 与 `buildFallbackSummary(messages)`；两处 import，并把 modified-files 增强合并进共享实现。
**涉及文件**: `src/services/compaction/prompts.ts`（新增）、`full.ts`、`functional.ts`
**验证**: 单测断言 `full.ts` 与 `functional.ts` 对同一输入产生**相同**的 prompt 字符串（当前会失败 —— 这正是分叉的证据）。

---

### M3: 系统提示词 Guidelines + Capabilities 跨文件精确重复（轻微-3）

**证据（✅ `diff` 输出为空 = 完全相同）**: `Bootstrap.ts:128-134` == `prompt-adapter.ts:129-135`（7 行）；`Bootstrap.ts:143-155` == `prompt-adapter.ts:137-149`（13 行）
**影响**: 能力清单是 10 条硬编码字符串，与实际注册的 21 个工具无关联；只改 Bootstrap 会导致 AGP 导出的 prompt 资源描述过期。
**修复**: 新建 `src/api/prompts/system-prompt-sections.ts` 导出 `GUIDELINES_SECTION` 与 `CAPABILITIES_SECTION`；理想情况由工具注册表**动态生成** capabilities 段。
**涉及文件**: `src/api/prompts/system-prompt-sections.ts`（新增）、`src/bootstrap/Bootstrap.ts:126-156`、`src/agp/adapters/prompt-adapter.ts:127-150`
**验证**: 单测断言两处导入同一常量；快照测试确认生成的系统提示词文本无变化。

---

### M4: `formatDuration` / `formatTokenCount` 各 3-4 套实现，单位契约冲突（轻微-4）

**证据（✅ grep 核验）**:
```
src/ui/components/StatusBar.ts:18       formatTokenCount(count)
src/ui/components/StatusBar.ts:24       formatDuration(ms)
src/ui/components/StatusBarView.tsx:55  formatDuration(sec)   ← 入参是「秒」
src/ui/format-duration.ts:12            export formatDuration(ms)
src/ui/formatter.ts:152                 formatTokenCount(count)
src/ui/formatter.ts:158                 formatDuration(ms)
```
另有 `src/ui/components/SessionInfo.tsx:35-38` 第三套 `formatTokens`（缺 `M` 档）。
**影响**: **单位不一致是真实 bug 源** —— 同名函数不同契约；SessionInfo 用 `m:ss` 而 StatusBar 用 `NmNs`，同一会话时长在两个组件显示不同；token 数超 100 万时 SessionInfo 不缩写为 `M`。
**修复**: `src/ui/format-duration.ts` 作为唯一实现，明确导出 `formatDuration(ms)` 与 `formatDurationSec(sec)` 两个签名避免单位混淆；`formatCount(n)` 统一 token 格式化；删除其余本地副本。
**涉及文件**: `src/ui/format-duration.ts`、`src/ui/formatter.ts`、`src/ui/components/StatusBar.ts`、`StatusBarView.tsx`、`SessionInfo.tsx`
**验证**: 单测覆盖 ms/sec 两个签名；组件快照测试确认输出一致。

---

### M5: 8 个工具内联错误取串，已有 `getErrorMessage` 未被采用（轻微-5）

**证据**: 已有实现 `src/utils/errors.ts:38-51`；内联副本在 `AskUserTool:103`、`ConfigTool:234`、`GlobTool:79`、`GrepTool:189`、`MonitorTool:92`、`TaskGetTool:80`、`TodoWriteTool:73`、`WebFetchTool:150`；特例 `TaskCreateTool:96` **import 了却没用** ⚠️
**影响**: 内联版不处理「带 message 字段的纯对象」（跨进程/反序列化错误常见），会退化成 `[object Object]`。
**修复**: 在 `src/Tool.ts` 旁新增 `toolFailure(toolName, error, extra?): ToolResult`，内部统一调 `getErrorMessage`；9 处 catch 全部替换。
**涉及文件**: `src/Tool.ts` + 上述 9 个工具目录
**验证**: 单测断言 `toolFailure` 对「带 message 的纯对象」返回正确文本；各工具回归全绿。

---

### M6/M9: `utils/path.ts` 死代码 + 孤儿测试（轻微-6 / 轻微-11）

**证据**: `src/utils/path.ts:24-50`（`isPathAllowed`，默认 `ask`）、`:167-200`（`resolvePathSafely`，默认 `deny`）、`:205-235`（`validateWritePath`，默认 `valid: false`）三者内含**同一段 8 行 allowed-directory 循环 × 3**，且全仓除定义处**零引用**；唯一在用的是 `assertPathWithinWorkspace`（`:74`）。`src/utils/path-security.test.ts:8-11` 被测模块 `path-security.ts` **不存在**，测试内联重写逻辑自断言。⚠️
**影响**: 三份死代码仍在被维护，且各自安全语义不同 —— 新人容易误用其中一份以为在做路径校验，而它们**根本没被接线**。**孤儿测试制造了「symlink TOCTOU 已被验证」的假象，是本次审查中最值得警惕的伪安全信号。**
**修复**:
1. 删除 `isPathAllowed` / `resolvePathSafely` / `validateWritePath`（先确认无测试引用）
2. 目录归属判断抽为私有 helper 供 `assertPathWithinWorkspace` 使用
3. 删除 `src/utils/path-security.test.ts`，或改写为 `import { assertPathWithinWorkspace } from './path'` 的真实测试
**涉及文件**: `src/utils/path.ts`、`src/utils/path-security.test.ts`
**blockedBy**: P3（先确定 realpath 缓存策略，再清理 path.ts，避免重复劳动）
**验证**: `knip` 无新增未使用导出；`test/utils/path-scope.test.ts` 全绿且对真实实现有覆盖。

---

### M7: `QueryEngine.clear()` 与 `restoreSession()` 状态重置重复（轻微-7）

**证据**: `src/query/QueryEngine.ts:1000-1020` vs `:1046-1069`；重复区间 `:1007-1019` vs `:1051-1060`（10 个字段）+ `:1017-1019` vs `:1067-1069`（状态机回 idle）⚠️
**影响**: QueryEngine 有 20+ 个可变状态字段。新增有状态成员时必须记得在**两处**都加 reset，否则 `/clear` 后残留旧会话状态 —— 难复现。
**修复**: 抽 `private resetPerQueryState()`，`clear()` 调它 + `conversation.clear()`，`restoreSession()` 调它 + `setMessages()`。
**涉及文件**: `src/query/QueryEngine.ts`
**验证**: 单测断言 `clear()` 与 `restoreSession()` 后所有状态字段处于 `resetPerQueryState()` 定义的初始态（可断言字段白名单）。

---

### M8: API client 错误规则分散 + 只读权限样板重复（轻微-9 / 轻微-10）

**证据**: `AnthropicClient.ts:514-532`、`OpenAICompatibleClient.ts:474-497`、`OllamaClient.ts:247-262` 骨架 × 3；Anthropic 匹配 `'rate_limit'`（下划线）而 OpenAI 匹配 `'rate limit'`（空格）；Anthropic 漏 403/404，OpenAI 漏 `overloaded_error` ⚠️。只读权限样板 `GlobTool:83-86`、`GrepTool:193-196`、`MonitorTool:96-99`、`AskUserTool:107-110`、`TodoWriteTool:77-80` 均为 `updatedInput: {}`，而 `TaskGetTool:84-87` 是 `undefined` ⚠️
**影响**: 两条 429 规则覆盖率不同；`updatedInput` 的 `{}` vs `undefined` 语义不同（「用空输入替换」vs「不改输入」），可能导致行为分叉。
**修复**:
1. `BaseApiClient` 增加 `protected errorRules(): Array<{ match: RegExp | string[]; status?: number; message: string }>`，基类遍历规则表；子类只声明差异规则。
2. `src/Tool.ts` 提供 `readonlyAllow(reason: string): PermissionResult`；更彻底的做法是让 `buildTool` 在 `isReadOnly()` 为真时自动注入默认 allow。
**涉及文件**: `src/api/BaseApiClient.ts`、`AnthropicClient.ts`、`OpenAICompatibleClient.ts`、`OllamaClient.ts`、`src/Tool.ts` + 6 个只读工具
**验证**: 单测断言 429 / 401 / 403 在各 provider 下均被正确分类；只读工具权限结果一致。

---

### M9: 零碎项收尾（轻微-13）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| a | `bootstrap/Bootstrap.ts:279-283` | `console.warn` 绕过 logger | 改 `logger.mcp.warn` |
| b | `tools/DeployTool/index.ts:109` | 提示 `Set CC_DEPLOY_SSH_TARGET`，全仓无代码读取 —— 悬空配置 | 删除提示或实现读取 |
| c | `agp/server-interface.ts:79-80,102-103,194-195,210-211,264-265` | 5 处 `catch (err) { return { success:false, error: String(err) } }` 丢堆栈无日志 | 保留 error 对象 + 加日志 |
| d | `services/sandbox-probe.ts:60,110,148,188` / `sandbox-docker.ts:28,40` / `sandbox-monitor.ts:140,183,203` | 分散硬编码 timeout（10000/5000/2000/3000） | 集中到 `src/constants.ts` |
| e | `.gitignore` | 只忽略 `.env`/`.env.local`/`.env.*.local`，**`.env.production` 不匹配** | 改 `.env` / `.env.*` / `!.env.example` |
| f | `tools/GrepTool/index.ts:62-65,74` | 用户正则无 ReDoS 保护；`file_pattern` 转换未转义元字符 | 加单文件处理时长上限；转义元字符 |
| g | `api/capabilities.ts:528-543` | 未知模型静默回落 provider 默认能力 | 加 `logger.api.warn`（用 cache 去重） |
| h | `orchestrator/backends/subprocess.ts:359-369` | cleanup 的 5s `setTimeout` 未 unref、未 clearTimeout、非幂等 | 保存句柄 + `unref()` + 幂等保护 |
| i | `utils/errors.ts:184-194` | 基于 message 文本正则反推错误类型，业务输出含「timeout」会被误判 | 优先判定 `KCError.code`，正则仅兜底 |
| j | `services/healthCheck.ts:292-301` | interval 内 async 无 catch、未 unref | 见 R8 同族的定时器任务 |
| k | 仓库根 `-p/` | 空目录，疑似 `mkdir -p` 参数解析失误残留 | 确认后删除 |
| l | `api/provider-specs.ts:55-106` | 9 个 provider baseUrl 硬编码（属合理注册表设计） | 可选：支持 per-provider 覆盖 |

---

## 7. 全局验证与测试方案

### 7.1 每任务必过的门禁

```bash
npm run typecheck          # tsc --noEmit 零错误
npx vitest run             # 全量测试无新增失败
npm run test:coverage      # lines 不低于当前基线
npx knip                   # 无新增未使用导出（M6 类任务）
```

### 7.2 分类测试策略

| 类别 | 测试形态 | 示例 |
|---|---|---|
| **安全（S1/S2/S6）** | **负面集成测试** —— 真实 spawn 进程并断言环境/行为 | S1: 设 `KC_API_KEY` 后跑 `env`，断言不含密钥；S6: 畸形 `.mcp.json` 被拒、非交互模式不 spawn |
| **崩溃防护（S3/S4）** | 进程级测试 —— 子进程实跑断言退出码与是否抛出未捕获异常 | S4: kill MCP server 后 send 不崩进程 |
| **并发（R1/R2/R4/R5）** | 并发不变式测试 —— 断言无重叠区间 / 无许可泄漏 / 无数据丢失 | R1: 50×2 并发追加后文件含全部 100 行 |
| **资源（S5/R8）** | 句柄/许可计数测试 | S5: N 次失败读取后 fd 计数不增长 |
| **可观测性（O1–O6）** | spy 断言日志被**调用**且 payload 含必需字段 | O1: 假 500 → `logger.api.error` 含 `statusCode`/`durationMs` |
| **性能（P1–P4）** | profile 基线对比 —— `getProfileReport()` checkpoint 差值 | P1: `tools_registered` 阶段耗时下降 |
| **重构（M1–M8）** | 行为等价测试 —— 重构前后快照一致 | M2: 两处 prompt 对同一输入产生相同字符串 |

### 7.3 需要新增的测试基建

1. **进程级测试夹具**（`test/helpers/spawn-cli.ts`）：以子进程方式启动 CLI，喂 stdin、收集 stdout、断言退出码。S3/R3/R6 都需要。
2. **fd 计数工具**（`test/helpers/fd-count.ts`）：跨平台统计打开的文件描述符数（POSIX 读 `/proc/self/fd`，Windows 用 `handle`-free 的间接断言）。S5 需要。
3. **logger spy 工具**（`test/helpers/logger-spy.ts`）：拦截 `logger.*` 各命名空间，断言调用次数与 payload 字段。O1–O6 都需要。

### 7.4 回归红线

以下**正面项**经本轮逐行核查确认实现正确，修改时**不得削弱**，且应有测试守护：

| 措施 | 位置 | 守护测试 |
|---|---|---|
| SSRF fail-closed + 每跳重定向复检 | `utils/ssrf.ts:147-177`、`WebFetchTool/index.ts:82` | `test/utils/ssrf*.test.ts` |
| 路径穿越 + 符号链接双重校验 | `utils/path.ts:73-155` | `test/utils/path-scope.test.ts` |
| bypass 双闸门 | `permissions/engine.ts:99-106,129-134` | `test/permissions/` |
| 沙箱 fail-closed | `services/sandbox.ts:42-49,125-140` | `test/integration/sandbox-e2e.test.ts` |
| HMAC timingSafeEqual | `executors/toolExecutor.ts:48,80-89` | `test/executors/` |
| Grep/Glob 限流 | `GrepTool:24,37,92,96`、`GlobTool:15` | `test/tools/` |

---

## 8. 进度追踪表

> 回填规则：每任务完成时更新 `docs/specs/audit-remediation-round4-tasks.md` 的状态总表与本表，并附完成日期。

| # | 编号 | 任务 | Priority | Spec § | Status | 完成日期 |
|---|------|------|----------|--------|--------|----------|
| T01 | S1+S2 | Fix environment leakage in LocalShell and MCP stdio transports | P0 | §2-S1/S2 | 🔄 in_progress | — |
| T02 | S3 | Hoist global crash handlers to process entry point | P0 | §2-S3 | ⬜ pending | — |
| T03 | S4 | Attach error listeners to MCP stdio pipes | P0 | §2-S4 | ⬜ pending | — |
| T04 | S5 | Guard FileRead streams with try/finally | P0 | §2-S5 | ⬜ pending | — |
| T05 | S6 | Validate .mcp.json schema and gate project-scoped servers | P0 | §2-S6 | ⬜ pending | — |
| T06 | R2 | Serialize JSON-mode stdin into QueryEngine | P1 | §3-R2 | ⬜ pending | — |
| T07 | R3 | Unify exit-code semantics across failure paths | P1 | §3-R3 | ⬜ pending | — |
| T08 | R4 | Add timeout and idempotent release to orchestrator semaphore | P1 | §3-R4 | ⬜ pending | — |
| T09 | R5 | Fail closed on unknown tools in concurrency grouping | P1 | §3-R5 | ⬜ pending | — |
| T10 | R6 | Replace hardcoded bash with platform shell in verification | P1 | §3-R6 | ⬜ pending | — |
| T11 | R7 | Preserve AbortError semantics through LocalShell | P1 | §3-R7 | ✅ completed | 2026-08-30 |
| T12 | R8 | Guarantee SqlTool worker promise settlement | P1 | §3-R8 | ✅ completed | 2026-08-30 |
| T13 | R1 | Add file-level mutex for FileEdit read-modify-write | P1 | §3-R1 | ✅ completed | 2026-08-30 |
| T14 | M9h/j | Unref and guard periodic timers | P1 | §6-M9 | ✅ completed | 2026-08-30 |
| T15 | O1 | Add LLM request lifecycle logging | P2 | §4-O1 | ✅ completed | 2026-08-30 |
| T16 | O2 | Emit circuit-breaker state transitions | P2 | §4-O2 | ✅ completed | 2026-08-30 |
| T17 | O3 | Surface MCP reconnect exhaustion | P2 | §4-O3 | ✅ completed | 2026-08-30 |
| T18 | O4 | Log budget denials and expose default stance | P2 | §4-O4 | ✅ completed | 2026-08-30 |
| T19 | O5 | Surface session persistence failures | P2 | §4-O5 | ✅ completed | 2026-08-30 |
| T20 | O6 | Triage LSP errors and record audit failures | P2 | §4-O6 | ✅ completed | 2026-08-30 |
| T21 | M9a | Route startup console output through logger | P2 | §6-M9a | ✅ completed | 2026-08-30 |
| T22 | P1 | Defer tool module loading out of startup path | P2 | §5-P1 | ✅ completed | 2026-08-30 |
| T23 | P2 | Move MCP connection off the startup critical path | P2 | §5-P2 | ✅ completed | 2026-08-30 |
| T24 | P3 | Cache realpath in the permission hot path | P2 | §5-P3 | ✅ completed | 2026-08-30 |
| T25 | P4 | Parallelize independent bootstrap phases | P2 | §5-P4 | ✅ completed | 2026-08-30 |
| T26 | M1 | Extract shared orchestrator backend runtime | P2 | §6-M1 | ✅ completed | 2026-08-30 |
| T27 | M2 | Unify compaction summary prompt and fallback | P2 | §6-M2 | ✅ completed | 2026-08-30 |
| T28 | M3 | Share system-prompt sections | P3 | §6-M3 | ✅ completed | 2026-08-30 |
| T29 | M4 | Consolidate duration and token formatters | P3 | §6-M4 | ✅ completed | 2026-08-30 |
| T30 | M5 | Route tool error strings through getErrorMessage | P3 | §6-M5 | ✅ completed | 2026-08-30 |
| T31 | M6+M9 | Remove dead path helpers and orphan test | P3 | §6-M6/M9 | ✅ completed | 2026-08-30 |
| T32 | M7 | Extract QueryEngine per-query state reset | P3 | §6-M7 | ✅ completed | 2026-08-30 |
| T33 | M8+M9 | Centralize API error rules and readonly permission helper | P3 | §6-M8 | ✅ completed | 2026-08-30 |

**状态图例**: ⬜ pending · 🔄 in_progress · ✅ completed · ⛔ blocked

---

## 9. 风险与需决策项

| # | 决策点 | 选项 | 建议 | 影响面 |
|---|--------|------|------|--------|
| D1 | `DEFAULT_BUDGET_CONFIG` 是否从「无限」改为保守默认值 | A. 保持 `null`（无限）+ verbose 提示<br>B. 设保守默认（如 $5/session） | **A** —— 擅自加默认值会让已有用户在长任务中被中断。先用日志让「已触发」可见，默认值变更留给产品决策 | O4 |
| D2 | `.mcp.json` 是否建议加入 `.gitignore` | A. 加入 `.gitignore`<br>B. 不加，仅靠 trust gate | **B** —— 很多团队**故意**提交 `.mcp.json` 共享配置。信任门控（T05）已解决安全问题，ignore 会误伤合法用法 | S6 |
| D3 | P3 的 realpath 缓存是否接受 5s staleness | A. 5s TTL 全局缓存<br>B. per-call 去重 Map（零 staleness） | **B** —— 路径解析是安全相关操作，不接受 staleness。per-call Map 已能消除单次权限检查内的重复解析，收益足够 | P3 |
| D4 | T13 是否先上乐观并发（阶段 A）还是直接做互斥锁（阶段 B） | A. 先做阶段 A（20 行）<br>B. 直接做阶段 B | **A→B** —— 阶段 A 当天可交付、立即消除数据丢失；阶段 B 作为完整方案随后落地 | R1 |
| D5 | T22 工具清单生成方式 | A. 构建期生成 `tool-catalog.generated.ts`<br>B. 后台预热（`void preloadAllTools()`） | **先 B 后 A** —— B 是 5 行改动、立即见效；A 需要引入 codegen 与构建 hook，作为后续优化 | P1 |
| D6 | T25 启动并行化是否值得做 | A. 做<br>B. 不做 | **延后评估** —— 先完成 T22/T23（真正的启动大头），再据 profile 数据决定 | P4 |

### 回滚策略

- **S1/S2（env 过滤）**：风险点在于白名单漏掉必要变量导致命令执行失败。缓解：`KC_ALLOW_ENV_VARS` 逃生舱 + 完整回归（确认 `node -v` / `git` / `npm` 等在沙箱内外均可用）。若出问题，单行 revert 即可。
- **T13（文件锁）**：引入死锁风险。缓解：`Semaphore(1)` + `finally` 释放 + 单测断言「fn 抛错仍释放」。阶段 A（乐观并发）无死锁风险，可先独立上线。
- **T22（工具加载）**：后台预热可能带来「首次调用工具时模块尚未加载完」的竞态。缓解：`ensureTool()` 已有 `pendingLoads` 去重机制，预热与首次调用共用同一 Promise，不会重复加载。

---

## 10. 参考

- 本轮审查原始报告：`.workbuddy/code-review-2026-08-28.md`
- 前序：`docs/specs/audit-remediation-round3-spec.md`（T01–T26 已完成）
- 任务清单：`docs/specs/audit-remediation-round4-tasks.md`
- 相关领域文档：`docs/guides/mcp-integration.md`、`docs/guides/tool-development.md`、`docs/repowiki/Permission-System.md`、`docs/repowiki/Sandbox.md`、`docs/repowiki/Orchestrator.md`
