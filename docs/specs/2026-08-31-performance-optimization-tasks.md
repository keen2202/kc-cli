# kc-cli 性能优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按路线 A（基线先行 + 分阶段热点消除）优化 kc-cli 的启动速度、每轮响应与长会话稳定性，每项改动独立可回滚、数据可验证。

**Architecture:** 先建三个基准脚本 + 棘轮防护（阶段 0）；再并行化启动链、拆分重型工具模块去掉预热 join（阶段 1）；然后给会话状态加版本号缓存 `buildApiMessages`、增量化 token 估算（阶段 2）；阶段 3/4 为数据门控任务。

**Tech Stack:** TypeScript ESM / Node ≥22 / vitest / tsx（基准脚本运行器）

**Spec:** `docs/specs/2026-08-31-performance-optimization-design.md`

**与设计文档的偏差（实施前确认）：**
1. §5.2 中 `branch`/`checkout` 的 O(1) token 切换**降级保留全量重算**——二者是低频用户命令（`/branch`、`/checkout`），不在热路径；若长会话基准证明其有影响再跟进。
2. §4.2 工具拆分范围收窄为**实际导入重图的 4 个工具**（Sql/Agent/TeamCreate/LSP）；Docker/Deploy 经核实静态导入很轻（仅 child_process / errors），直接转 eager 注册即可，无需拆分。
3. **启动基准运行方式（Task 0.1 实证修订）**：`dist/` 产物相对导入不带扩展名，Node ESM 无法直接加载（`ERR_MODULE_NOT_FOUND`）；bench 改用 `node --import tsx src/main.ts`（与 `npm run kc` 一致的运行路径）。测量包含 tsx 转换开销，但所有测量同路径，相对比较（棘轮）仍有效。
4. **Windows bench 环境（Task 0.1 实证修订）**：本机无沙箱后端，`compose()` 会在退出点前抛错，bench 必须设 `KC_SANDBOX_FAIL_IF_NO_SANDBOX=false`（有后端的平台无副作用）；退出点输出用 `process.stderr.write` 而非 `console.error`（`startup-console-routing.test.ts` 对 Bootstrap.ts 有禁 console.error 的源码扫描约束）。

**运行环境注意：** 本机为 Windows + Git Bash。`npm test` 有少量已知环境性失败（sandbox/路径分隔符，以 CI ubuntu 为准，见 `docs/specs/optimization-tasks.md` 末尾对账记录）——开始任何任务前先跑一次 `npm test` 记录本机失败基线，后续以「不新增失败」为门槛。

---

## 文件结构

**新建：**
- `scripts/bench/startup.mjs` — 启动冷启动基准，写 `scripts/perf-current.json`
- `scripts/bench/turn-overhead.ts` — 单轮开销基准（消息构建 + token 估算）
- `scripts/bench/long-session.ts` — 长会话内存曲线基准
- `scripts/perf-ratchet.mjs` — 性能回归棘轮（仿 `scripts/coverage-ratchet.mjs`）
- `scripts/perf-baseline.json` — 提交入库的性能基线
- `src/tools/SqlTool/impl.ts` — Sql 运行时（better-sqlite3 等重依赖）
- `src/tools/AgentTool/impl.ts`、`src/orchestrator/team-create-impl.ts`、`src/lsp/tool-impl.ts` — 同上模式
- `test/tools/lazy-split.test.ts` — 拆分后的注册与加载行为测试
- `test/query/conversation-version.test.ts` — 版本号与增量 token 测试
- `test/bootstrap/dotenv.test.ts` — loadDotEnv 幂等测试

**修改：**
- `src/bootstrap/Bootstrap.ts` — bench 退出点、并行化、去重、去预热 join
- `src/bootstrap/config.ts` — loadDotEnv 幂等
- `src/bootstrap/app.ts` — 无（保留唯一 loadDotEnv 调用点）
- `src/tools.ts` — 全量 eager 注册
- `src/tools/registry.ts` — TOOL_MANIFEST 全部 eager:true
- `src/tools/{SqlTool,AgentTool}/index.ts`、`src/lsp/tool.ts`、`src/orchestrator/team-create-tool.ts` — 轻量化
- `src/query/QueryEngineState.ts` — 版本号、增量 trim、setMessages knownTotal
- `src/query/QueryEngine.ts` — apiMessages 版本缓存、压缩结果传 totalTokensAfter
- `src/services/compaction/functional.ts` — 结果附带 totalTokensAfter
- `src/query/QueryEngineCompaction.ts` — 透传 totalTokensAfter
- `src/main.ts` — 移除两处失效的 preloadAllTools 调用
- `src/acp/handlers.ts` — 移除失效的 preloadAllTools 调用
- `package.json` — bench 脚本

---

# 阶段 0：基准测量体系

### Task 0.1: 启动基准退出点（KC_BENCH_STARTUP）

**Files:**
- Modify: `src/bootstrap/Bootstrap.ts:16`（import）与 `src/bootstrap/Bootstrap.ts:645-647`（compose 结尾）

- [ ] **Step 1: 添加 bench 退出点**

`src/bootstrap/Bootstrap.ts:16` 的 profiler import 扩展：

```typescript
import { profileCheckpoint, getProfileReport } from './profiler';
```

在 compose 的 `profileCheckpoint('failure_bridging_wired');` 之后、`return {` 之前（约 :645）插入：

```typescript
    // Perf-benchmark exit point: KC_BENCH_STARTUP=1 runs the full bootstrap,
    // dumps the phase profile to stderr, and exits before any UI/REPL starts.
    if (process.env.KC_BENCH_STARTUP === '1') {
      console.error(getProfileReport());
      process.exit(0);
    }
```

- [ ] **Step 2: 构建并手工验证**

Run: `npm run build && KC_BENCH_STARTUP=1 node dist/main.js`
Expected: 进程以退出码 0 结束，stderr 输出 `Performance Profile:` 表格，含 `state_init`…`failure_bridging_wired` 共 12 个 checkpoint 与 Total 行；不出现任何交互界面。

- [ ] **Step 3: 类型检查与回归**

Run: `npm run typecheck && npx vitest run test/bootstrap`
Expected: 全部通过（对照任务开始前的失败基线，不新增失败）。

- [ ] **Step 4: Commit**

```bash
git add src/bootstrap/Bootstrap.ts
git commit -m "feat(bench): add KC_BENCH_STARTUP exit point for startup profiling"
```

---

### Task 0.2: 启动基准脚本与基线落库

**Files:**
- Create: `scripts/bench/startup.mjs`
- Create: `scripts/perf-baseline.json`（由脚本生成后提交）
- Modify: `package.json`（scripts 节）

- [ ] **Step 1: 写 startup.mjs**

```javascript
#!/usr/bin/env node
// Startup benchmark: cold-starts the CLI from source (via tsx, matching the
// npm run kc path) with KC_BENCH_STARTUP=1, records wall-clock p50/p95,
// writes scripts/perf-current.json. Wall time includes tsx transform
// overhead; every run pays it equally, so relative comparisons stay valid.
// Pass --update to (re)write the committed scripts/perf-baseline.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RUNS = 10;
const repoRoot = path.resolve(import.meta.dirname, '../..');
const entry = path.join(repoRoot, 'src', 'main.ts');

const samples = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      KC_BENCH_STARTUP: '1',
      LOG_LEVEL: 'error',
      // Windows has no sandbox backend; without this flag compose() aborts
      // before the bench exit point. No-op where a backend exists (CI linux).
      KC_SANDBOX_FAIL_IF_NO_SANDBOX: 'false',
    },
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 60_000,
  });
  const elapsed = performance.now() - t0;
  if (res.status !== 0) {
    console.error(`[bench:startup] run ${i} exited ${res.status}:`, String(res.stderr).slice(0, 500));
    process.exit(1);
  }
  samples.push(elapsed);
}

const round1 = (n) => Math.round(n * 10) / 10;
const sorted = [...samples].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
const result = {
  metric: 'startup_ms',
  runs: RUNS,
  p50: round1(p50),
  p95: round1(p95),
  samples: samples.map(round1),
  timestamp: new Date().toISOString(),
};

const currentPath = path.join(repoRoot, 'scripts', 'perf-current.json');
let current = {};
try { current = JSON.parse(fs.readFileSync(currentPath, 'utf8')); } catch { /* first run */ }
current.startup = result;
fs.writeFileSync(currentPath, JSON.stringify(current, null, 2) + '\n');

if (process.argv.includes('--update')) {
  const baselinePath = path.join(repoRoot, 'scripts', 'perf-baseline.json');
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { /* first run */ }
  baseline.startup = result;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`[bench:startup] baseline updated: p50=${result.p50}ms p95=${result.p95}ms`);
} else {
  console.log(`[bench:startup] p50=${result.p50}ms p95=${result.p95}ms (samples: ${result.samples.join(', ')})`);
}
```

- [ ] **Step 2: package.json 增加 bench 脚本**

在 `scripts` 节追加（保持现有项不动）：

```json
"bench:startup": "node scripts/bench/startup.mjs",
"bench:turn": "npx tsx scripts/bench/turn-overhead.ts",
"bench:long": "npx tsx scripts/bench/long-session.ts",
"perf:ratchet": "node scripts/perf-ratchet.mjs"
```

- [ ] **Step 3: 运行并落库基线**

Run: `npm run bench:startup -- --update`
Expected: 输出 `[bench:startup] baseline updated: p50=…ms p95=…ms`；生成 `scripts/perf-baseline.json` 含 `startup` 节。

- [ ] **Step 4: Commit**

```bash
git add scripts/bench/startup.mjs scripts/perf-baseline.json package.json
git commit -m "feat(bench): startup benchmark script + initial baseline"
```

---

### Task 0.3: 单轮开销基准

**Files:**
- Create: `scripts/bench/turn-overhead.ts`

- [ ] **Step 1: 写 turn-overhead.ts**

```typescript
// Per-turn overhead benchmark: measures buildApiMessages and full token
// re-estimation across transcript sizes 50/200/800.
// Run: npx tsx scripts/bench/turn-overhead.ts
import { randomUUID } from 'node:crypto';
import { ConversationState } from '../../src/query/QueryEngineState';
import { buildApiMessages } from '../../src/query/QueryEngineStreaming';
import { estimateMessageTokensArray } from '../../src/utils/tokenEstimation';
import type { ChatMessage } from '../../src/query/protocol';

function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 4 === 1) {
      // assistant with tool calls + following tool result — exercises pairing repair
      const callId = `call_${i}`;
      msgs.push({
        id: randomUUID(), role: 'assistant', timestamp: Date.now(),
        content: `step ${i}: ` + 'analysis of the code change '.repeat(8),
        toolCalls: [{ id: callId, toolName: 'FileRead', input: { path: `src/f${i}.ts` }, status: 'completed' }],
      } as ChatMessage);
      msgs.push({
        id: randomUUID(), role: 'tool', timestamp: Date.now(),
        content: `file content for step ${i} `.repeat(10),
        toolResults: [{ toolCallId: callId, output: `file content for step ${i} `.repeat(10) }],
      } as ChatMessage);
    } else {
      msgs.push({
        id: randomUUID(), role: i % 2 === 0 ? 'user' : 'assistant', timestamp: Date.now(),
        content: `message ${i}: ` + 'lorem ipsum context for benchmarking '.repeat(6),
      } as ChatMessage);
    }
  }
  return msgs;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function bench(fn: () => unknown, runs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Math.round(median(samples) * 1000) / 1000; // median ms
}

const results: Array<Record<string, unknown>> = [];
for (const n of [50, 200, 800]) {
  const cs = new ConversationState({ maxMessages: n + 100 });
  for (const m of makeMessages(n)) cs.addMessage(m);
  results.push({
    messages: cs.messageCount,
    buildApiMessages_ms: bench(() => buildApiMessages(cs.getMessagesCopy()), 100),
    estimateTokens_ms: bench(() => estimateMessageTokensArray(cs.getMessages()), 30),
  });
}
console.log(JSON.stringify({ metric: 'turn_overhead', results, timestamp: new Date().toISOString() }, null, 2));
```

- [ ] **Step 2: 运行验证**

Run: `npm run bench:turn`
Expected: 输出 JSON，三档消息数各有 `buildApiMessages_ms` 与 `estimateTokens_ms` 数值（量级应在亚毫秒~几十毫秒；记录进任务日志作为阶段 2 的对比基线）。

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/turn-overhead.ts
git commit -m "feat(bench): per-turn overhead benchmark (buildApiMessages + token estimation)"
```

---

### Task 0.4: 长会话基准

**Files:**
- Create: `scripts/bench/long-session.ts`

- [ ] **Step 1: 写 long-session.ts**

```typescript
// Long-session benchmark: drives QueryEngine with MockLLMClient for N turns,
// samples heap usage every K turns to produce a growth curve.
// Run: npx tsx scripts/bench/long-session.ts
import { initializeState } from '../../src/bootstrap/state';
import { QueryEngine } from '../../src/query/QueryEngine';
import { MockLLMClient } from '../../test/utils/mock-llm';
import type { BaseApiClient } from '../../src/api/BaseApiClient';

const TURNS = 60;
const SAMPLE_EVERY = 5;

initializeState();
process.env.KC_API_KEY = 'bench-dummy-key';

const mock = new MockLLMClient();
mock.setResponses(Array.from({ length: TURNS }, (_, i) => ({ content: `reply ${i}: ` + 'content '.repeat(40) })));

const engine = new QueryEngine(
  { model: 'bench-model', provider: 'anthropic', apiKey: 'bench-dummy-key', maxTurns: TURNS + 10, maxBudgetUsd: null },
  [],
  { apiClient: mock as unknown as BaseApiClient },
);

const curve: Array<{ turn: number; heapUsedMb: number }> = [];
for (let turn = 1; turn <= TURNS; turn++) {
  for await (const _event of engine.submitMessage(`turn ${turn}: please answer briefly`)) {
    // drain the stream; events are irrelevant for this benchmark
  }
  if (turn % SAMPLE_EVERY === 0) {
    curve.push({ turn, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) });
  }
}
console.log(JSON.stringify({ metric: 'long_session', turns: TURNS, curve, timestamp: new Date().toISOString() }, null, 2));
```

注意：`{ apiClient }` 作为第三参 deps 注入，与 `test/` 下现有 QueryEngine 测试的注入方式一致（构造器内 `d.apiClient` 优先生效）。若实际测试用的是别的注入字段，以 `test/QueryEngine.test.ts` 现有写法为准对齐。

- [ ] **Step 2: 运行验证**

Run: `npm run bench:long`
Expected: 输出 JSON 增长曲线（12 个采样点）；记录数值作为阶段 3 的决策依据。

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/long-session.ts
git commit -m "feat(bench): long-session memory growth benchmark"
```

---

### Task 0.5: 性能棘轮（perf-ratchet.mjs）

**Files:**
- Create: `scripts/perf-ratchet.mjs`

- [ ] **Step 1: 写 perf-ratchet.mjs**

语义对齐 `scripts/coverage-ratchet.mjs`：回归超阈值失败、显著改善自动收紧基线。

```javascript
#!/usr/bin/env node
// Performance ratchet: compares scripts/perf-current.json against the
// committed scripts/perf-baseline.json.
//   - startup p50 regresses more than REGRESSION_PCT above baseline -> exit 1
//   - startup p50 improves by >= RATCHET_PCT -> baseline lowered (commit it)
// Usage: npm run bench:startup && node scripts/perf-ratchet.mjs

import fs from 'node:fs';
import path from 'node:path';

const REGRESSION_PCT = 20; // CI machine noise margin
const RATCHET_PCT = 10;

const repoRoot = path.resolve(import.meta.dirname, '..');
const currentPath = process.argv[2] ?? path.join(repoRoot, 'scripts', 'perf-current.json');
const baselinePath = process.argv[3] ?? path.join(repoRoot, 'scripts', 'perf-baseline.json');

function fail(msg) {
  console.error(`[perf-ratchet] FAIL: ${msg}`);
  process.exit(1);
}

let current, baseline;
try { current = JSON.parse(fs.readFileSync(currentPath, 'utf8')); }
catch { fail(`current measurement not found at ${currentPath}. Run \`npm run bench:startup\` first.`); }
try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); }
catch { fail(`baseline not found at ${baselinePath}. Run \`npm run bench:startup -- --update\` first.`); }

if (!current.startup || !baseline.startup) {
  fail('both current and baseline must contain a `startup` section');
}

const cur = current.startup.p50;
const base = baseline.startup.p50;
const deltaPct = ((cur - base) / base) * 100;

console.log(`[perf-ratchet] startup p50: current=${cur}ms baseline=${base}ms delta=${deltaPct.toFixed(1)}%`);

if (deltaPct > REGRESSION_PCT) {
  fail(`startup p50 regressed ${deltaPct.toFixed(1)}% (> ${REGRESSION_PCT}% allowed)`);
}

if (deltaPct <= -RATCHET_PCT) {
  baseline.startup = current.startup;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`[perf-ratchet] RATCHETED DOWN (faster): baseline p50 ${base}ms -> ${cur}ms. Commit scripts/perf-baseline.json.`);
} else {
  console.log('[perf-ratchet] OK');
}
```

- [ ] **Step 2: 端到端验证棘轮**

Run: `npm run bench:startup && npm run perf:ratchet`
Expected: 输出 `delta=…%`（接近 0），以 `OK` 结束、退出码 0。

- [ ] **Step 3: Commit**

```bash
git add scripts/perf-ratchet.mjs
git commit -m "feat(bench): perf ratchet guarding startup p50 against regression"
```

---

# 阶段 1：启动路径

### Task 1.1: git 探测与配置加载并行

**Files:**
- Modify: `src/bootstrap/Bootstrap.ts:230-266`

- [ ] **Step 1: 修改 compose 的 Phase 2 / 2.5**

把 `Bootstrap.ts:230-266` 区域改为先发起 git 探测、后在消费点 await：

```typescript
    // ── Phase 2: Load configuration ──
    // Fire the git probe concurrently: it is independent of config loading and
    // tool registration; awaited only where its result is consumed (below).
    const gitProbe = isInsideGitRepo(cwd);
    const { config, layers } = await loadConfig(cwd);
```

（`updateState({ config })` 起至 Phase 2.5 注释之间的其余代码不动。）

Phase 2.5 处的 `const isGitRepo = await isInsideGitRepo(cwd);` 改为：

```typescript
    const isGitRepo = await gitProbe;
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run test/bootstrap && npm run build && npm run bench:startup`
Expected: 类型与测试通过；`perf-current.json` 中 `git_detect` checkpoint 的 delta 明显变小（探测耗时被并入 `config_load` 的并行窗口），p50 不劣化。

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/Bootstrap.ts
git commit -m "perf(bootstrap): run git probe concurrently with config load"
```

---

### Task 1.2: loadDotEnv 幂等

**Files:**
- Modify: `src/bootstrap/config.ts:271-330`
- Create: `test/bootstrap/dotenv.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/bootstrap/dotenv.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv, resetDotEnvForTesting } from '../../src/bootstrap/config';

describe('loadDotEnv idempotency', () => {
  let dir: string;
  const KEY = 'KC_DOTENV_IDEMPOTENCE_PROBE';

  beforeEach(() => {
    resetDotEnvForTesting();
    delete process.env[KEY];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[KEY];
    resetDotEnvForTesting();
  });

  it('reads .env only once across repeated calls', () => {
    fs.writeFileSync(path.join(dir, '.env'), `${KEY}=first\n`);
    loadDotEnv(dir);
    expect(process.env[KEY]).toBe('first');

    // If a second call re-read the file it would be ignored anyway (env wins),
    // so prove single-read by changing the file BEFORE the second call:
    fs.writeFileSync(path.join(dir, '.env'), `${KEY}=second\n`);
    delete process.env[KEY]; // remove env precedence so a re-read would surface
    loadDotEnv(dir);
    expect(process.env[KEY]).toBeUndefined(); // no re-read happened
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/bootstrap/dotenv.test.ts`
Expected: FAIL（`resetDotEnvForTesting` 未导出 / 第二次调用重读文件得到 `second`）。

- [ ] **Step 3: 实现幂等**

在 `src/bootstrap/config.ts` 的 `loadDotEnv` 上方加模块级标记，并包裹函数体：

```typescript
let dotEnvLoaded = false;

/** Test-only: clear the single-load guard. */
export function resetDotEnvForTesting(): void {
  dotEnvLoaded = false;
}

export function loadDotEnv(cwd: string): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  // …existing body unchanged…
}
```

（函数体其余部分原样保留；`app.ts:15` 的首次调用完成实际加载，`config.ts:332`（loadConfig 内）的第二次调用变为无操作。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/bootstrap/dotenv.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/config.ts test/bootstrap/dotenv.test.ts
git commit -m "perf(bootstrap): make loadDotEnv idempotent (was reading .env twice)"
```

---

### Task 1.3: loadMCPConfig 结果复用

**Files:**
- Modify: `src/bootstrap/Bootstrap.ts:285-409`

- [ ] **Step 1: 提升变量并复用**

在 Phase 3b 开始处（`let mcpManager: MCPClientManager | null = null;` 附近）增加：

```typescript
    let mcpConfigCache: Awaited<ReturnType<typeof loadMCPConfig>> | null = null;
```

Phase 3b 内（:288）的 `const mcpConfig = await loadMCPConfig(cwd);` 改为：

```typescript
        mcpConfigCache = await loadMCPConfig(cwd);
        const mcpConfig = mcpConfigCache;
```

Phase 3c.5 内（:409）的 `const mcpConfig = await loadMCPConfig(cwd);` 改为：

```typescript
        const mcpConfig = mcpConfigCache ?? await loadMCPConfig(cwd);
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run test/bootstrap test/mcp`
Expected: 通过，无新增失败。

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/Bootstrap.ts
git commit -m "perf(bootstrap): reuse loadMCPConfig result across phases (was called twice)"
```

---

### Task 1.4: AGP loadState 条件化

**Files:**
- Modify: `src/bootstrap/Bootstrap.ts:453-490`

- [ ] **Step 1: 仅在 evolution 启用时执行 loadState**

将 :470-473 的：

```typescript
        const loaded = agpRegistry.loadState();
        if (verbose && loaded.loaded > 0) {
          console.log(chalk.gray(`  AGP: ${loaded.loaded} resources restored from disk`));
        }
```

改为：

```typescript
        // Disk restore only matters when evolution is on; the default config
        // keeps evolution disabled, so skip the startup disk IO entirely.
        if (agpConfig?.evolution?.enabled ?? false) {
          const loaded = agpRegistry.loadState();
          if (verbose && loaded.loaded > 0) {
            console.log(chalk.gray(`  AGP: ${loaded.loaded} resources restored from disk`));
          }
        }
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run test/bootstrap`
Expected: 通过。注意：默认配置下（`evolution.enabled ?? false`）此改动跳过磁盘读取；若存在依赖启动恢复的 AGP 测试（检查 `test/` 下 agp 相关），确认其显式开启 evolution 配置。

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/Bootstrap.ts
git commit -m "perf(bootstrap): skip AGP disk restore when evolution is disabled"
```

---

### Task 1.5: AGP 初始化与插件初始化并行

**Files:**
- Modify: `src/bootstrap/Bootstrap.ts:378-490`

- [ ] **Step 1: 抽取 AGP 块为私有方法**

在 `Bootstrap` 类中新增（放在 `resolveNoninteractiveAskPolicy` 附近）：

```typescript
  /**
   * Phase 3d extracted: initializes the AGP registry. Errors are swallowed
   * (logged) exactly as before so the returned promise never rejects.
   */
  private async initAgpPhase(
    config: { agp?: { tracingEnabled?: boolean; evolution?: { enabled?: boolean; budget?: number; autoRollback?: boolean; persistState?: boolean } } },
    cwd: string,
    verbose: boolean,
    updateState: (patch: { agpRegistry: unknown }) => void,
  ): Promise<void> {
    // …把原 "Phase 3d" 块中 `try {…} catch {…}` 的完整内容原样搬入（getGlobalRegistry、
    // updateState({ agpRegistry })、loadState 门控、surface 注册、catch 告警）。
    // 外层条件 `!bareMode && (config.agp?.enabled ?? true)` 不搬——由 Step 2 的调用点判断。
  }
```

> 实施提示：直接剪切 `// ── Phase 3d: Initialize AGP ...` 到 `profileCheckpoint('agp_initialized');` 之前的代码块作为方法体；`updateState({ agpRegistry })` 改为通过参数调用。`createSurfacePromptRecords` 等 import 已在文件顶部，无需改动。

- [ ] **Step 2: 在 compose 中并行发起**

在 Phase 3c（插件）块**之前**插入：

```typescript
    // Phase 3d runs concurrently with plugin init: the two are independent.
    const agpInit = (!bareMode && (config.agp?.enabled ?? true))
      ? this.initAgpPhase(config, cwd, verbose, (patch) => updateState(patch))
      : Promise.resolve();
```

在 Phase 3c.5 结束之后、`profileCheckpoint('agp_initialized')` 原位置改为：

```typescript
    await agpInit;
    profileCheckpoint('agp_initialized');
```

（注意：IM 初始化依赖 `pluginManager`，保持在插件阶段之后不动。）

- [ ] **Step 3: 验证**

Run: `npm run typecheck && npx vitest run test/bootstrap && npm run build && npm run bench:startup`
Expected: 通过；`plugins_initialized` 与 `agp_initialized` 两段合计耗时下降（并行窗口重叠），p50 不劣化。

- [ ] **Step 4: Commit**

```bash
git add src/bootstrap/Bootstrap.ts
git commit -m "perf(bootstrap): run AGP init concurrently with plugin init"
```

---

### Task 1.6: SqlTool 拆分（轻量入口 + 运行时 impl）

**Files:**
- Create: `src/tools/SqlTool/impl.ts`
- Modify: `src/tools/SqlTool/index.ts`

- [ ] **Step 1: 创建 impl.ts**

把当前 `index.ts` 中**除**以下内容之外的全部代码搬入 `impl.ts`：
- `SqlInputSchema` / `SqlInput` 定义
- `stripSqlNoise` / `isReadOnlyQuery` / `isDestructiveQuery`（纯字符串逻辑，无重依赖，留在入口）
- `checkPermissions` 实现
- `buildTool` 包装

`impl.ts` 结构：

```typescript
// SQL tool runtime — heavy dependencies (better-sqlite3 native binding,
// worker_threads, connection cache) live here so the tool entry module stays
// cheap to import at startup. Loaded on first Sql invocation via index.ts.

// …原 index.ts 顶部的重导入原样搬来：
//   worker_threads, node:url, node:fs, node:path, createRequire,
//   toolResult/toolError, getState, getCacheManager, ToolResultType…
import type { SqlInput } from './index.js';
import type { ToolUseContext } from '../protocol.js';

const require = createRequire(import.meta.url);
const MAX_ROWS = 1000;
const dbCache = getCacheManager().getOrCreate<any>('sql-connections', 'tool', { /* 原配置原样 */ });

// …原 index.ts 的 SqliteDatabase/SqliteStatement 接口、getDb、查询执行、
// Worker 执行、错误净化等全部函数原样搬来…

export async function executeSql(
  input: SqlInput,
  context: ToolUseContext,
): Promise<ToolResultType<string>> {
  // …原 buildTool call 函数体原样搬来…
}
```

- [ ] **Step 2: 重写 index.ts 为轻量入口**

```typescript
// SQL tool — lightweight entry: metadata + permission scan only. The runtime
// (better-sqlite3 native binding, worker threads) is dynamically imported on
// first call via ./impl.js.

import { z } from 'zod';
import { buildTool } from '../../Tool';
import type { PermissionResult } from '../../permissions/protocol';

export const SqlInputSchema = z.object({
  query: z.string().describe('SQL query to execute'),
  database: z.string().describe('Database connection name or path to SQLite file'),
  params: z.array(z.unknown()).optional().describe('Query parameters (positional ? placeholders)'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

export type SqlInput = z.infer<typeof SqlInputSchema>;

// …stripSqlNoise / isReadOnlyQuery / isDestructiveQuery 原样保留在本文件…

export const tool = buildTool<SqlInput, string>({
  // name/description/inputSchema/isReadOnly 等元数据字段从原文件原样保留
  name: 'Sql',
  description: '…原描述字符串原样…',
  inputSchema: SqlInputSchema,
  async call(input, context) {
    const { executeSql } = await import('./impl.js');
    return executeSql(input, context);
  },
  checkPermissions: (input): PermissionResult => {
    // …原 checkPermissions 函数体原样保留（只依赖上面的纯字符串判断）…
    if (isReadOnlyQuery(input.query)) {
      return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'readonly', reason: 'Read-only SQL query' } };
    }
    if (isDestructiveQuery(input.query)) {
      return { behavior: 'ask', message: `Destructive SQL: ${input.query.slice(0, 100)}...` };
    }
    return { behavior: 'ask', message: `Execute SQL: ${input.query.slice(0, 100)}...` };
  },
});
```

- [ ] **Step 3: 运行现有 Sql 工具测试**

Run: `npm run typecheck && npx vitest run test/tools --testNamePattern "Sql"`
（若无 Sql 专项测试文件，则运行 `npx vitest run test/tools`。）
Expected: 全绿——动态导入路径经现有测试覆盖（调用即加载）。

- [ ] **Step 4: Commit**

```bash
git add src/tools/SqlTool/index.ts src/tools/SqlTool/impl.ts
git commit -m "perf(tools): split SqlTool — lazy better-sqlite3 runtime via dynamic import"
```

---

### Task 1.7: AgentTool / TeamCreate / LSP 同模式拆分

**Files:**
- Create: `src/tools/AgentTool/impl.ts`、`src/orchestrator/team-create-impl.ts`、`src/lsp/tool-impl.ts`
- Modify: `src/tools/AgentTool/index.ts`、`src/orchestrator/team-create-tool.ts`、`src/lsp/tool.ts`

三个文件按 Task 1.6 的同一模式处理（这是模式复用，不是省略——每个文件都执行下面完整的四步）：

拆分规则：
- **留在入口**：`z` schema、`buildTool` 元数据（name/description/inputSchema/isReadOnly/checkPermissions 若为纯逻辑）。
- **移入 impl**：所有运行时静态导入（AgentTool 的 `getOrchestrator`/`createAgentConfig`/`listAgentTypes`/`toolRegistry`；TeamCreate 的同名导入；LSP 的 `DiagnosticCollector`/`LSPClientManager`/`detectLanguage`）+ call 函数体，导出 `executeAgent` / `executeTeamCreate` / `executeLsp`。
- **入口 call**：`async call(input, context) { const { executeX } = await import('./impl.js'); return executeX(input, context); }`。

注意点：
- AgentTool 入口不再静态导入 `../../tools.js`（消除循环导入压力）；`toolRegistry` 的使用移入 `impl.ts`。
- `listAgentTypes` 若被入口的 description/checkPermissions 使用，则改为在 impl 内使用；入口描述用静态字符串（原样）。
- LSP 入口的 `checkPermissions` 若引用 `detectLanguage`，将其移入 impl 并通过 `call` 内前置校验实现，或保留为宽松的 `allow` 后由执行期校验——以现状语义为准，**不得放宽权限**：若现状是 `ask`，拆分后仍必须 `ask`。

验证与提交：

- [ ] **Step 1: 三个文件分别完成拆分**
- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run test/tools test/orchestrator test/lsp`
Expected: 全绿，无新增失败。

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool src/orchestrator/team-create-tool.ts src/orchestrator/team-create-impl.ts src/lsp/tool.ts src/lsp/tool-impl.ts
git commit -m "perf(tools): split Agent/TeamCreate/LSP — heavy graphs load on first call"
```

---

### Task 1.8: 全量 eager 注册 + 移除预热 join

**Files:**
- Modify: `src/tools/registry.ts:47-76`、`src/tools.ts`、`src/bootstrap/Bootstrap.ts:268-282,558-561`、`src/main.ts:400,547`、`src/acp/handlers.ts:51`
- Create: `test/tools/lazy-split.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/tools/lazy-split.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../../src/tools.js';
import { TOOL_MANIFEST } from '../../src/tools/registry';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  initializeState();
});

describe('eager registration after lazy split', () => {
  it('registers every manifest tool without any preload step', async () => {
    await registerBuiltInTools();
    const names = toolRegistry.getAllTools().map(t => t.name);
    for (const entry of TOOL_MANIFEST) {
      expect(names, `missing tool ${entry.name} without preload`).toContain(entry.name);
    }
  });

  it('split tool entries expose metadata without loading impl', async () => {
    await registerBuiltInTools();
    for (const name of ['Sql', 'Agent', 'LSP', 'TeamCreate'] as const) {
      const tool = toolRegistry.getTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(tool!.inputSchema).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/tools/lazy-split.test.ts`
Expected: FAIL —— 未预热时 12 个懒加载工具不在 `getAllTools()` 里。

- [ ] **Step 3: TOOL_MANIFEST 全部转 eager**

`src/tools/registry.ts:47-76`：把每个条目的 `eager: false` 改为 `eager: true`（含注释行 `// DEFERRED — advanced tools, always lazy` 更新为 `// DEFERRED — advanced tools; entries are lightweight, heavy code lives in impl modules`）。

- [ ] **Step 4: tools.ts 静态导入全部工具**

`src/tools.ts` 顶部导入区追加：

```typescript
import { tool as SqlTool } from './tools/SqlTool/index.js';
import { tool as DockerTool } from './tools/DockerTool/index.js';
import { tool as MonitorTool } from './tools/MonitorTool/index.js';
import { tool as ConfigTool } from './tools/ConfigTool/index.js';
import { tool as TodoWriteTool } from './tools/TodoWriteTool/index.js';
import { tool as TaskCreateTool } from './tools/TaskCreateTool/index.js';
import { tool as TaskGetTool } from './tools/TaskGetTool/index.js';
import { tool as AskUserTool } from './tools/AskUserTool/index.js';
import { tool as AgentTool } from './tools/AgentTool/index.js';
import { tool as DeployTool } from './tools/DeployTool/index.js';
import { tool as TeamCreateTool } from './orchestrator/team-create-tool.js';
import { tool as LSPTool } from './lsp/tool.js';
```

（各文件的具名导出以实际为准：若某工具是 `default` 导出，用 `import XTool from '...'`。）

`registerBuiltInTools()` 的 `eagerTools` 数组追加这 12 个工具。函数顶部注释更新为「All built-in tools register eagerly; heavy runtimes are split into impl modules loaded on first call.」

- [ ] **Step 5: Bootstrap 移除预热与 join**

`Bootstrap.ts`：
- 删除 :269 的 `let toolsPreheat: Promise<void> | null = null;`
- :270-281 保留 `if (!bareMode) { await registerBuiltInTools(); }`，删除其后的 T22 注释块与 `toolsPreheat = toolRegistry.preloadAllTools()...`
- :558-560 删除 `// T22: join ...` 注释与 `if (toolsPreheat) await toolsPreheat;`

- [ ] **Step 6: 清理失效的预热调用**

- `src/main.ts:400`（`/tools` 命令）：删除 `await toolRegistry.preloadAllTools();` 及其上一行注释。
- `src/main.ts:547`（`listTools()`）：同上删除。
- `src/acp/handlers.ts:51`：同上删除。

- [ ] **Step 7: 运行测试与基准**

Run: `npx vitest run test/tools/lazy-split.test.ts && npm run typecheck && npm test`
Expected: 新测试通过；全量套件无新增失败。
Run: `npm run build && npm run bench:startup`
Expected: p50 较基线下降（记录数值；若下降 ≥10%，棘轮会在 ratchet 时提示收紧基线）。

- [ ] **Step 8: Commit**

```bash
git add src/tools/registry.ts src/tools.ts src/bootstrap/Bootstrap.ts src/main.ts src/acp/handlers.ts test/tools/lazy-split.test.ts
git commit -m "perf(startup): register all tools eagerly, drop preheat join from critical path"
```

---

### Task 1.9: NODE_COMPILE_CACHE 评估

**Files:**
- Modify: `agents.md`（Quick Commands 或新增 Perf 小节）

- [ ] **Step 1: 测量编译缓存收益**

Run（Git Bash）:
```bash
npm run build
npm run bench:startup            # 记录 p50
NODE_COMPILE_CACHE=.cache/node-compile-cache npm run bench:startup   # 记录 p50（第二次运行，缓存已热）
```
Expected: 两组 p50 数值。

- [ ] **Step 2: 记录结论**

若热缓存收益 ≥10%：在 `agents.md` Quick Commands 下新增一行说明（开发模式可用 `NODE_COMPILE_CACHE` 提速），并把 `.cache/` 加入 `.gitignore`。若 <10%：在本任务提交信息中记录「评估无显著收益，不启用」。

- [ ] **Step 3: Commit（仅当启用时）**

```bash
git add agents.md .gitignore
git commit -m "docs: enable NODE_COMPILE_CACHE hint after benchmark validation"
```

---

# 阶段 2：每轮热路径增量化

### Task 2.1: ConversationState 版本号

**Files:**
- Modify: `src/query/QueryEngineState.ts`
- Create: `test/query/conversation-version.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/query/conversation-version.test.ts
import { describe, it, expect } from 'vitest';
import { ConversationState } from '../../src/query/QueryEngineState';
import type { ChatMessage } from '../../src/query/protocol';

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `${role}-${Math.random()}`, role, content, timestamp: Date.now() } as ChatMessage;
}

describe('ConversationState version counter', () => {
  it('bumps on addMessage', () => {
    const cs = new ConversationState();
    const v0 = cs.version;
    cs.addMessage(msg('user', 'hi'));
    expect(cs.version).toBe(v0 + 1);
  });

  it('bumps on setMessages', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'hi'));
    const v0 = cs.version;
    cs.setMessages([msg('user', 'compacted')]);
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('bumps on trim when messages exceed max', () => {
    const cs = new ConversationState({ maxMessages: 2 });
    cs.addMessage(msg('user', 'a'));
    cs.addMessage(msg('assistant', 'b'));
    cs.addMessage(msg('user', 'c'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('does not bump when trim removes nothing', () => {
    const cs = new ConversationState({ maxMessages: 10 });
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBe(v0);
  });

  it('bumps on branch, checkout, clear', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    const nodeId = cs.branch();
    expect(cs.version).toBeGreaterThan(v0);
    cs.addMessage(msg('assistant', 'on branch'));
    const v1 = cs.version;
    cs.checkout(nodeId);
    expect(cs.version).toBeGreaterThan(v1);
    const v2 = cs.version;
    cs.clear();
    expect(cs.version).toBeGreaterThan(v2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/query/conversation-version.test.ts`
Expected: FAIL（`version` 不存在）。

- [ ] **Step 3: 实现版本号**

`src/query/QueryEngineState.ts` 类字段区新增：

```typescript
  /**
   * Monotonic version of the active transcript. Bumped on every mutation so
   * derived caches (e.g. the built API-messages array) can validate freshness
   * in O(1).
   */
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }
```

在以下方法体内追加 `this.versionCounter++;`：
- `addMessage`（push 之后）
- `setMessages`
- `trimIfNeeded`（**仅在 `excess > 0` 实际发生裁剪时**，return 之前）
- `clear`
- `branch`
- `checkout`

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/query/conversation-version.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/query/QueryEngineState.ts test/query/conversation-version.test.ts
git commit -m "feat(query): conversation version counter for O(1) cache invalidation"
```

---

### Task 2.2: buildApiMessages 版本缓存

**Files:**
- Modify: `src/query/QueryEngine.ts`（字段区 + :823）
- Test: `test/query/conversation-version.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `test/query/conversation-version.test.ts` 追加：

```typescript
import { QueryEngine } from '../../src/query/QueryEngine';
import { MockLLMClient } from '../../test/utils/mock-llm';
import type { BaseApiClient } from '../../src/api/BaseApiClient';
import { initializeState } from '../../src/bootstrap/state';

describe('api-messages version cache', () => {
  it('rebuilds only when the conversation version changes', async () => {
    initializeState();
    const mock = new MockLLMClient();
    mock.setResponses([{ content: 'one' }, { content: 'two' }]);
    const engine = new QueryEngine(
      { model: 'm', provider: 'anthropic', apiKey: 'k', maxTurns: 5, maxBudgetUsd: null },
      [],
      { apiClient: mock as unknown as BaseApiClient },
    );
    for await (const _e of engine.submitMessage('first')) { /* drain */ }
    const firstRequest = mock.getCallLog().at(-1)!;
    for await (const _e of engine.submitMessage('second')) { /* drain */ }
    const secondRequest = mock.getCallLog().at(-1)!;
    // Second request contains the first turn's messages — rebuilt after mutation.
    expect(secondRequest.messages.length).toBeGreaterThan(firstRequest.messages.length);
  });
});
```

（`getCallLog` 记录的是 `chat` 调用；若 MockLLMClient 的流式路径单独记录，则改为断言流式调用日志——以 `test/utils/mock-llm.ts` 的实际记录点为准。）

- [ ] **Step 2: 运行确认当前行为**

Run: `npx vitest run test/query/conversation-version.test.ts`
Expected: 该用例应直接 PASS（它验证的是行为不变，而非缓存命中）——保留为回归护栏。

- [ ] **Step 3: 实现缓存**

`src/query/QueryEngine.ts` 私有字段区新增：

```typescript
  /** Cached buildApiMessages output, keyed by conversation version. */
  private apiMessagesCache: { version: number; messages: ChatMessage[] } | null = null;
```

`streamingPhase` 内 :823 的：

```typescript
      const apiMessages = buildApiMessages(this.conversation.getMessagesCopy());
```

替换为：

```typescript
      // Version-cached: retries within a turn reuse the built array; any
      // conversation mutation (addMessage/setMessages/trim/branch/checkout)
      // bumps the version and forces a rebuild. The cached array is treated
      // as read-only downstream (API clients only serialize it).
      const conversationVersion = this.conversation.version;
      let apiMessages: ChatMessage[];
      if (this.apiMessagesCache !== null && this.apiMessagesCache.version === conversationVersion) {
        apiMessages = this.apiMessagesCache.messages;
      } else {
        apiMessages = buildApiMessages(this.conversation.getMessages());
        this.apiMessagesCache = { version: conversationVersion, messages: apiMessages };
      }
```

- [ ] **Step 4: 验证**

Run: `npx vitest run test/query && npm run typecheck && npm run bench:turn`
Expected: query 套件全绿；`bench:turn` 的 `buildApiMessages_ms` 仅作记录（该基准测纯函数，缓存收益体现在重试路径——以步骤 5 的复测为准）。

- [ ] **Step 5: 重试路径复测（对照基准）**

Run: `npm test`（全量，确认无新增失败）
记录：重试时不再重复构建（代码路径保证），数值证据来自 `bench:turn` 前后对比记录入任务日志。

- [ ] **Step 6: Commit**

```bash
git add src/query/QueryEngine.ts test/query/conversation-version.test.ts
git commit -m "perf(query): cache buildApiMessages by conversation version (retry path O(1))"
```

---

### Task 2.3: trimIfNeeded 增量 token 核算

**Files:**
- Modify: `src/query/QueryEngineState.ts:153-198`
- Test: `test/query/conversation-version.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
import { estimateMessageTokensArray } from '../../src/utils/tokenEstimation';

describe('incremental token accounting', () => {
  it('trim keeps the estimate equal to a full recount', () => {
    const cs = new ConversationState({ maxMessages: 6 });
    for (let i = 0; i < 10; i++) {
      cs.addMessage(msg(i % 2 === 0 ? 'user' : 'assistant', `m${i} `.repeat(20)));
    }
    cs.trimIfNeeded();
    expect(cs.getTokenEstimate()).toBe(estimateMessageTokensArray(cs.getMessages()));
  });
});
```

- [ ] **Step 2: 运行确认通过与否**

Run: `npx vitest run test/query/conversation-version.test.ts`
Expected: 当前实现（全量重算）本应通过——此测试是**等价性护栏**，确保增量化改写后数值不变。

- [ ] **Step 3: 增量化改写**

把 `trimIfNeeded` 中三处裁减路径都改为先算出被移除消息、再增量扣减。将 :167-187（自 `const excess` 起）替换为：

```typescript
    const excess = this.messages.length - this.maxMessages;
    let kept: ChatMessage[];

    if (firstSystemIdx === -1 && firstUserIdx === -1) {
      kept = this.messages.slice(excess);
    } else {
      const protectedIndices = new Set<number>();
      if (firstSystemIdx !== -1) protectedIndices.add(firstSystemIdx);
      if (firstUserIdx !== -1) protectedIndices.add(firstUserIdx);

      const removable: number[] = [];
      for (let i = 0; i < this.messages.length; i++) {
        if (!protectedIndices.has(i)) removable.push(i);
      }

      if (removable.length >= excess) {
        const toRemove = new Set(removable.slice(0, excess));
        kept = this.messages.filter((_, idx) => !toRemove.has(idx));
      } else {
        kept = this.messages.slice(excess);
      }
    }

    // Incremental accounting: subtract removed messages instead of a full
    // recount (equivalence guarded by conversation-version.test.ts).
    const keptIds = new Set(kept.map(m => m.id));
    for (const m of this.messages) {
      if (!keptIds.has(m.id)) this.runningTokenTotal -= estimateMessageTokens(m);
    }
    if (this.runningTokenTotal < 0) this.runningTokenTotal = 0;
    this.messages = kept;
```

并删除原 :195-196 的全量重算两行（`this.runningTokenTotal = estimateMessageTokensArray(...)` / `this.recomputed = true;` 中的重算行），保留树节点同步与 `recomputed` 标记、`return excess`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/query/conversation-version.test.ts && npx vitest run test/query`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/query/QueryEngineState.ts test/query/conversation-version.test.ts
git commit -m "perf(query): incremental token accounting in trimIfNeeded"
```

---

### Task 2.4: setMessages knownTotal + 压缩链路接线

**Files:**
- Modify: `src/query/QueryEngineState.ts`（setMessages）、`src/services/compaction/functional.ts`、`src/query/QueryEngineCompaction.ts`、`src/query/QueryEngine.ts:519-523,859-871`
- Test: `test/query/conversation-version.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('setMessages knownTotal', () => {
  it('uses the provided total instead of recounting', () => {
    const cs = new ConversationState();
    const msgs = [msg('user', 'hello world'), msg('assistant', 'hi there')];
    cs.setMessages(msgs, 12345);
    expect(cs.getTokenEstimate()).toBe(12345);
  });

  it('falls back to full estimation without knownTotal', () => {
    const cs = new ConversationState();
    const msgs = [msg('user', 'hello world'), msg('assistant', 'hi there')];
    cs.setMessages(msgs);
    expect(cs.getTokenEstimate()).toBe(estimateMessageTokensArray(msgs));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/query/conversation-version.test.ts`
Expected: FAIL（setMessages 忽略第二参数）。

- [ ] **Step 3: setMessages 接受 knownTotal**

```typescript
  /** Set all messages (e.g., after compaction). When the caller already knows
   * the post-set token total (compaction engines do), pass it to skip the
   * full recount. */
  setMessages(messages: ChatMessage[], knownTotal?: number): void {
    const activeNode = this.tree.getNode(this.tree.getActiveNodeId());
    if (activeNode) {
      activeNode.messages = messages;
    }
    this.messages = messages;
    this.runningTokenTotal = knownTotal ?? estimateMessageTokensArray(this.messages);
    this.recomputed = true;
  }
```

- [ ] **Step 4: 压缩结果附带 totalTokensAfter**

`src/services/compaction/functional.ts`：
- 结果类型（`CompactionResult` 或等价接口，:51 附近）增加可选字段 `totalTokensAfter?: number`。
- `microcompact`（:130-137 区域）：返回对象加 `totalTokensAfter: compactedTokens`。
- `fullCompact`（:211 附近）：`calculateTokensSaved` 已同时掌握前后总量——让它（或调用处）一并向结果写入 `totalTokensAfter`（压缩后消息的估算值）。若 `calculateTokensSaved` 只返回差值，则在 `fullCompact` 内补一次 `estimateMessageTokensArray(compactedMessages)` **并删除**其他重复的同量估算，保证总估算次数不增。
- `forceTruncate`（:246-255）：已增量累加移除量，返回对象加 `totalTokensAfter: originalTokens - removedTokens`。

`src/query/QueryEngineCompaction.ts`：透传该字段——所有把压缩结果交给上层的位置（含 `drainPendingCompactResult` 的返回）保留 `totalTokensAfter`。

- [ ] **Step 5: 消费点接线**

`src/query/QueryEngine.ts`：
- :519-523 的 drain 应用处：

```typescript
              this.conversation.setMessages(asyncCompactResult.messages, asyncCompactResult.totalTokensAfter);
```

- 溢出恢复（:859-871）：`forceTruncate` 分支改为

```typescript
            this.conversation.setMessages(truncated.messages, truncated.totalTokensAfter);
```

  「减半」分支（`messages.slice(...)`）无已知总量，保持不传（回退全量估算——该路径极少触发）。

- [ ] **Step 6: 验证**

Run: `npx vitest run test/query test/services && npm run typecheck`
Expected: 全绿（含现有 `test/services/compaction.test.ts`）。
Run: `npm test`
Expected: 无新增失败。

- [ ] **Step 7: Commit**

```bash
git add src/query/QueryEngineState.ts src/services/compaction/functional.ts src/query/QueryEngineCompaction.ts src/query/QueryEngine.ts test/query/conversation-version.test.ts
git commit -m "perf(query): skip token recounts — setMessages accepts knownTotal from compaction"
```

---

# 阶段 2 收尾

### Task 2.5: 复测基准并收紧棘轮

- [ ] **Step 1: 全量基准复测**

Run: `npm run build && npm run bench:startup && npm run bench:turn && npm run perf:ratchet`
Expected: 三项输出数值；棘轮 `OK` 或提示 `RATCHETED DOWN`。

- [ ] **Step 2: 记录收益并更新基线**

若棘轮提示收紧：`git add scripts/perf-baseline.json` 一并提交。把「优化前 → 优化后」的启动 p50、turn-overhead 数值写入提交说明。

- [ ] **Step 3: Commit**

```bash
git add scripts/perf-current.json scripts/perf-baseline.json
git commit -m "chore(bench): post-optimization measurements + baseline update"
```

---

# 阶段 3 / 4：数据门控任务

### Task 3.1: 长会话基准决策门

- [ ] **Step 1: 运行长会话基准**

Run: `npm run bench:long`
记录增长曲线：`heapUsedMb` 随 turn 的变化。

- [ ] **Step 2: 按判据决策**

判据（与 spec §6 一致）：
- **堆内存随轮数持续线性增长且无收敛**（例如 60 轮后仍在每 5 轮 >1MB 增长）→ 立项处理，优先排查 `frozenChains` Map 无上限增长（`src/ui/hooks/useStreamingEvents.ts:296`）与会话树节点累积；为该项单独写后续计划（新 brainstorm → spec → plan），不并入本计划。
- **曲线趋平**（后期每 5 轮增长 <0.5MB）→ 记录「长会话稳定，无需改动」，关闭该维度。

- [ ] **Step 3: 记录结论**

把曲线数据与决策写入任务日志/提交说明。此任务不改产品代码。

---

### Task 3.2: 构建层决策门（条件触发）

- [ ] **Step 1: 检查启动耗时构成**

Run: `KC_BENCH_STARTUP=1 node dist/main.js`，查看各 checkpoint 占比。

- [ ] **Step 2: 按判据决策**

- 若启动 p50 中模块加载（`state_init`→`tools_registered` 段）仍占 >50% 且绝对值仍不满足预期 → 评估 esbuild 单文件打包（better-sqlite3 external、懒工具保持动态 import），另立计划。
- 否则记录「打包不立项」，本计划收尾。

---

## 验收清单（全部任务完成后）

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 无新增失败（对照开跑前记录的本机基线）
- [ ] `npm run perf:ratchet` 通过
- [ ] 启动、单轮、长会话三项基准数值记录在案，收益写入最终提交说明
- [ ] 权限系统、沙箱、受保护路径相关代码零改动（`git log --stat` 抽查确认）
