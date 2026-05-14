# KC-CLI v3.0.0 系统审查报告

---

## 一、代码审计

### 1.1 架构审查

**目录结构与模块划分**

项目共 23,303 行 TypeScript 源码，分为 120+ 文件，模块划分清晰：
- `bootstrap/` — 初始化（config, state, profiler）
- `state/` — 状态机（machine, store, types）
- `query/` — 核心引擎（QueryEngine）
- `api/` — LLM 客户端抽象（Anthropic, OpenAI, Ollama）
- `permissions/` — 权限系统（engine, rules, classifier, protectedPaths）
- `tools/` — 21 个内置工具
- `services/` — 系统服务（sandbox, compaction, memory, session）
- `orchestrator/` — 多 Agent 协调
- `mcp/` — MCP 集成
- `lsp/` — LSP 集成
- `ui/` — 终端 UI（Ink）
- `memory/` — 文件记忆系统

**模块依赖**

- 🟢 **无循环依赖**：依赖方向清晰，`types/` → `bootstrap/` → `permissions/` → `tools/` → `executors/` → `query/` → `main.ts`
- 🟢 **接口设计一致**：所有工具统一实现 `ToolDefinition` 接口（`call()`, `checkPermissions()`, `isReadOnly()`, `isConcurrencySafe()`, `isDestructive()`）
- 🟢 **架构文档完善**：`docs/architecture.md` 详细描述了所有组件和数据流

**`as any` 使用统计：53 处**

- 🔴 **严重**：53 处 `as any` 类型断言，破坏了 TypeScript 类型安全
- 主要集中在：
  - `src/main.ts`（13 处）— `(globalThis as any).__currentSpinner` 等全局状态访问
  - `src/orchestrator/backends/in-process.ts`（7 处）— 事件类型转换
  - `src/acp/handlers.ts`（7 处）— AgentEvent 类型转换
  - `src/executors/toolExecutor.ts`（4 处）— 工具结果类型转换
  - `src/api/AnthropicClient.ts`（3 处）— content 数组操作

**建议**：使用判别联合类型（discriminated union）替代 `as any`，为全局状态定义专门的类型接口。

---

### 1.2 代码质量

**文件长度（超过 500 行的文件）**

| 文件 | 行数 | 评估 |
|------|------|------|
| `src/ui/components/App.ts` | 999 | 🔴 过长，应拆分 |
| `src/query/QueryEngine.ts` | 654 | 🟡 偏长，可接受 |
| `src/main.ts` | 545 | 🟡 偏长，可接受 |

**函数长度**

- 🟢 大部分函数控制在 30-60 行以内
- 🟡 `QueryEngine.streamingPhase()` 和 `QueryEngine.executingPhase()` 各约 80 行，接近 100 行阈值
- 🟡 `ToolExecutor.executeSingle()` 约 90 行，可考虑拆分权限检查逻辑

**TODO/FIXME/HACK 注释：4 处**

```
src/memory/integration.ts:103:  // TODO: Implement LLM-based memory extraction
src/query/QueryEngine.ts:98:   alwaysDenyRules: [], // TODO: Load from config
src/query/QueryEngine.ts:99:   alwaysAskRules: [],  // TODO: Load from config
src/query/QueryEngine.ts:100:  alwaysAllowRules: [], // TODO: Load from config
```

- 🔴 **QueryEngine 中的权限规则未从配置加载**：3 个 TODO 表示 `ToolExecutor` 的 `alwaysDenyRules`/`alwaysAskRules`/`alwaysAllowRules` 始终为空数组，意味着用户配置的权限规则在工具执行层被忽略。

**重复代码**

- 🟡 BashTool 和 RunTool 中的沙箱包装逻辑高度相似（`SANDBOX_WRAPPED_MARKER` 检查 + `wrapCommand` 调用）。已在 `ToolExecutor` 中统一处理，工具中的代码是 fallback，但逻辑重复。
- 🟡 `shellEscape` 函数在 `sandbox-profiles.ts` 和 `sandbox-docker.ts` 中各定义了一份，逻辑略有差异（Docker 版本多了 null byte 过滤）。

**未使用的导入**

- 🟢 未发现明显的未使用导入（TypeScript 的 `--noEmit` 编译通过，无错误）

---

### 1.3 错误处理

**try/catch 分析**

项目共有约 70+ 处 try/catch 块。

**空 catch 块（吞掉错误）：约 20 处**

主要集中在 `sandbox-*.ts` 文件中：

| 文件 | 行数 | 评估 |
|------|------|------|
| `sandbox-images.ts` | 4 处 | 🟡 可接受（清理/检测逻辑） |
| `sandbox-profiles.ts` | 4 处 | 🟡 可接受（特性检测） |
| `sandbox-probe.ts` | 4 处 | 🟢 正确（探测命令失败=沙箱生效） |
| `sandbox.ts` | 2 处 | 🟡 probe 失败应记录更详细信息 |
| `consolidationScheduler.ts` | 1 处 | 🟡 锁文件不存在是正常情况 |
| `compaction.ts` | 1 处 | 🟡 API 失败时有 fallback |

- 🟡 大部分空 catch 块有合理的上下文（特性检测、清理），但建议至少添加 `// intentional` 注释
- 🟢 `hooks/postTurnHooks.ts` 中的 `.catch()` 正确地记录了错误而非静默吞掉

**Promise 处理**

- 🟢 `main().catch()` 在入口点正确捕获顶层错误
- 🟢 `runProbe().catch()` 在沙箱初始化中正确处理
- 🟡 `executeMemoryExtraction(trailingContext).catch()` 中错误仅 `console.warn`，可能丢失重要上下文

**错误消息质量**

- 🟢 工具错误消息大多包含具体信息（文件路径、命令内容、错误详情）
- 🟢 `SqlTool.sanitizeError()` 正确移除了文件路径等敏感信息
- 🟡 部分错误消息使用了通用模板如 `"Tool execution failed: ${message}"`

---

## 二、安全检测

### 2.1 输入验证

**文件路径验证**

- 🟢 `FileReadTool` 使用 `path.resolve(context.cwd, input.path)` 解析路径
- 🟢 `FileWriteTool` 同样使用 `path.resolve`
- 🟢 `FileEditTool` 同样使用 `path.resolve`
- 🔴 **但三个工具都没有做路径遍历防护**：`path.resolve` 会解析 `../`，攻击者可以构造 `../../etc/passwd` 访问工作目录外的文件
- 🟢 `memory/paths.ts` 中的 `validateMemoryPath()` 有完整的遍历防护（检查 `..`、符号链接解析、相对路径验证）
- 🟢 `memory/paths.ts` 的 `sanitizeFileName()` 正确过滤了特殊字符

**Shell 命令注入防护**

- 🟢 BashTool 的 `checkPermissions` 使用正则检测危险命令模式
- 🟢 `DANGEROUS_BASH_PATTERNS` 包含 `rm -rf /`、`mkfs`、`dd` 等模式
- 🔴 **RunTool 的危险命令检测使用 `command.includes()` 而非正则**：仅检查 6 个硬编码字符串，比 BashTool 的正则系统弱得多
- 🟡 `shellEscape()` 使用单引号包裹 + 转义内部单引号的方式，是标准安全做法
- 🔴 **sandbox-profiles.ts 的 `shellEscape` 未过滤 null bytes**：Docker 版本有过滤，但 bubblewrap/seccomp 版本没有

**URL 验证**

- 🟢 `WebFetchTool` 使用 `z.string().url()` 进行 URL 格式验证
- 🟢 `checkPermissions` 阻止了 localhost、127.0.0.1、RFC 1918 私有地址范围
- 🟡 未阻止 `0.0.0.0`、`[::1]`（IPv6 localhost）、`169.254.x.x`（链路本地地址）

---

### 2.2 权限系统

**6 步决策流分析** (`permissions/engine.ts`)

```
1. 检查全局 deny 规则 → 匹配则拒绝
2. 工具自定义权限检查 → deny/allow/passthrough
3. 安全关键路径检查（bypass 免疫）→ 受保护路径
4. bypassPermissions 模式 → 全部允许（除安全关键）
5. 全局 allow 规则 → 匹配则允许
6. 默认行为（基于模式）
```

- 🟢 **受保护路径在 bypass 模式下仍然生效**：`checkSecurityCritical()` 在 Step 3 执行，在 Step 4 bypass 之前
- 🟢 `PROTECTED_PATH_PATTERNS` 覆盖了 `/etc/passwd`、`/etc/shadow`、`.ssh`、`.gnupg`、shell profiles 等关键路径

**权限绕过风险**

- 🟡 **Step 2 和 Step 3 的交互有微妙问题**：如果工具的 `checkPermissions` 返回 `allow`（Step 2），会直接返回，跳过 Step 3 的安全关键路径检查。这意味着如果某个工具错误地返回 `allow`，可以绕过受保护路径检查。
- 🔴 **QueryEngine 中权限规则为空**：如上所述，`alwaysDenyRules`/`alwaysAllowRules` 始终为空，用户配置的权限规则不生效

**受保护路径覆盖度**

- 🟢 覆盖了常见的系统敏感路径
- 🟡 缺少对以下路径的保护：
  - `/etc/ssl/` — SSL 证书
  - `/etc/kubernetes/` — Kubernetes 配置
  - `~/.aws/`、`~/.config/gcloud/` — 云服务凭证
  - `~/.kube/config` — Kubernetes 配置
  - `~/.docker/config.json` — Docker 凭证

---

### 2.3 沙箱安全

**shellEscape 安全性**

- 🟢 Docker 版本：过滤 null bytes + 单引号包裹 + 转义内部单引号
- 🔴 Bubblewrap/Seccomp 版本：仅单引号包裹 + 转义，**未过滤 null bytes**
- 🟡 两个版本的 `shellEscape` 应该统一为一个共享函数

**seccomp profile 分析**

- 🟢 默认动作 `SCMP_ACT_ERRNO`（拒绝未明确允许的系统调用）
- 🟢 阻止了 `ptrace`、`mount`、`umount2`、`reboot`、`kexec_load` 等危险系统调用
- 🟢 允许了 `execve`、`fork`、`clone` 等基本执行所需调用
- 🟡 **允许了 `socket` 和 `connect`**：这意味着沙箱内的进程可以建立网络连接（除非 Docker 的 `--network none` 单独限制）
- 🟡 **允许了 `kill`**：沙箱内进程可以发送信号

**沙箱降级链信息泄露**

- 🟢 降级时输出 `console.warn` 警告消息
- 🟡 降级消息包含后端名称，不包含敏感信息
- 🟢 `NoopSandbox` 会在 `wrapCommand` 中输出警告

**Docker 沙箱加固**

- 🟢 `--read-only` 只读根文件系统
- 🟢 `--security-opt no-new-privileges=true`
- 🟢 `--pids-limit 256` 进程数限制
- 🟢 `--memory` 内存限制
- 🟢 `--network none` 默认网络隔离
- 🟢 绑定挂载工作目录为唯一可写目录
- 🟡 未设置 `--cap-drop ALL`（应考虑丢弃所有 Linux capabilities）

---

### 2.4 敏感信息

**API Key 处理**

- 🟢 API Key 从配置文件或环境变量 `KC_API_KEY` 加载，未硬编码
- 🟢 `validateApiKeyFormat()` 检查 key 格式
- 🟡 `showConfig()` 显示 `API Key: ✓ Set` 而非实际值，这是正确的

**日志安全**

- 🟢 `SqlTool.sanitizeError()` 移除了文件路径
- 🟡 部分错误日志可能包含命令内容（`BashTool` 的 `input.command` 被记录在错误消息中）
- 🟢 `main.ts` 的 verbose 模式不显示 API Key 值

**配置文件 gitignore**

- 🟢 `.gitignore` 包含 `.env`、`.env.local`、`.env.*.local`
- 🟢 `.gitignore` 包含 `memory/`、`sessions/` 目录
- 🔴 **但 gitignore 路径格式有误**：`~/.kc-cli/memory/` 和 `~/.kc-cli/sessions/` 使用了 `~`，gitignore 不支持 `~` 展开，应为 `memory/` 和 `sessions/`（已在上方正确配置，`~` 开头的规则是冗余但无害的）

---

## 三、性能测试

### 3.1 测试套件性能

```
Test Files:  60 passed (60)
Tests:       974 passed | 18 skipped (992)
Duration:    33.92s (transform 1.34s, setup 0ms, import 2.49s, tests 22.37s)
```

- 🟢 **974 个测试全部通过**，18 个跳过（LSP E2E 测试，需要实际语言服务器）
- 🟢 平均每个测试约 23ms，性能良好
- 🟢 60 个测试文件覆盖了主要模块

### 3.2 关键路径性能

**Token 估算**

- 🟢 `TokenCounter` 使用 LRU 缓存（默认 1000 条），避免重复编码
- 🟢 支持 tiktoken（精确）和字符启发式（fallback）两种模式
- 🟢 `heuristicCount()` 算法：`Math.ceil(((text.length + 3) / 4) * (4 / 3))`，O(1) 复杂度
- 🟡 缓存使用 FIFO 淘汰策略，对重复访问模式不是最优（LRU 更好）

**正则编译缓存**

- 🟢 `sandbox-policy.ts` 的 `patternCache` 缓存了编译后的正则表达式
- 🟡 缓存无大小限制，但实际模式数量有限（工具数量级），不会造成问题
- 🟢 `permissions/engine.ts` 的 `matchPattern()` 未缓存正则，每次调用重新编译

**虚拟滚动**

- 🟢 `VirtualScroller` 仅渲染可见区域 + overscan（默认 5 条）
- 🟢 `getVisibleRange()` 为 O(n) 遍历，对 1000 条消息约需 1000 次迭代
- 🟡 可优化为二分查找（O(log n)），但对终端 UI 场景影响不大

**布局计算**

- 🟢 `LayoutManager.recalculate()` 为 O(n) 遍历面板，n 通常为 4，性能无问题
- 🟢 响应式折叠逻辑在 `calculateDimensions()` 中

**鼠标事件处理**

- 🟢 `MouseHandler.processEvent()` 为 O(n) 遍历 regions，n 通常很小
- 🟢 事件解析使用正则匹配，单次调用性能良好

### 3.3 内存使用

**潜在内存泄漏模式**

| 模式 | 文件 | 风险 |
|------|------|------|
| `dbCache` 无上限 | `SqlTool/index.ts` | 🟡 数据库连接缓存无大小限制 |
| `patternCache` 无上限 | `sandbox-policy.ts` | 🟢 实际数量有限 |
| `checkedImages` Set | `sandbox-images.ts` | 🟢 有清理逻辑 |
| `connections` Map | `mcp/client-manager.ts` | 🟢 有 `disconnect` 删除 |
| `plugins` Map | `plugin-manager.ts` | 🟢 有 `unloadAll` |
| `diffCallbacks` Map | `ui/App.ts` | 🟢 有 `delete` 清理 |
| `TokenCounter.cache` | `tokenEstimation.ts` | 🟢 有 FIFO 淘汰（maxCacheSize=1000） |
| `idleDetectionInterval` | `idleDetection.ts` | 🟢 有 `stopIdleDetection` 清理 |

**事件监听器清理**

- 🟢 `idleDetection.ts` 正确注册了 `process.on('exit/SIGINT/SIGTERM')` 清理
- 🟢 `MouseHandler.destroy()` 清理了回调和 regions
- 🟢 `ObservableStateStore.destroy()` 清理了 listeners
- 🟡 `App.ts` 注册了 `process.on('SIGINT/SIGTERM')` 但未看到对应的 `removeListener`
- 🟡 `main.ts` REPL 的 `cleanup` 函数调用 `process.exit(0)` 而非优雅关闭

**Message 历史限制**

- 🟢 `QueryEngine` 有 `DEFAULT_MAX_MESSAGES = 1000` 硬限制
- 🟢 超限时自动 `trimMessages()` 移除最旧消息
- 🟢 `cachedTokenEstimate` 在 trim 后正确失效

---

## 四、测试覆盖

```
覆盖率摘要：
  行覆盖率：   52.95% (阈值 60%) ❌
  语句覆盖率： 52.92% (阈值 60%) ❌
  分支覆盖率： 44.41% (阈值 50%) ❌
  函数覆盖率：53.05% (阈值 50%) ✅
```

**高覆盖率模块（>80%）**

| 模块 | 行覆盖率 | 评估 |
|------|----------|------|
| `permissions/` | 82-100% | 🟢 优秀 |
| `services/error-classifier.ts` | 100% | 🟢 优秀 |
| `services/sessionManager.ts` | 100% | 🟢 优秀 |
| `services/idleDetection.ts` | 89% | 🟢 良好 |
| `services/sandbox.ts` | 86% | 🟢 良好 |
| `state/machine.ts` | 90% | 🟢 良好 |
| `utils/format.ts` | 100% | 🟢 优秀 |
| `utils/path.ts` | 94% | 🟢 良好 |
| `tools/TaskStore.ts` | 100% | 🟢 优秀 |

**低覆盖率模块（<50%）**

| 模块 | 行覆盖率 | 评估 |
|------|----------|------|
| `query/QueryEngine.ts` | 11.35% | 🔴 严重不足 |
| `services/memoryConsolidation.ts` | 5.42% | 🔴 严重不足 |
| `services/compaction.ts` | 44.44% | 🔴 不足 |
| `state/store.ts` | 48% | 🟡 偏低 |
| `services/sandbox-windows.ts` | 0% | 🔴 无覆盖 |
| `utils/tokenEstimation.ts` | 64% | 🟡 偏低 |

**关键发现**

- 🔴 **QueryEngine 作为核心模块，覆盖率仅 11.35%**：这是最需要补充测试的模块
- 🔴 **memoryConsolidation 覆盖率 5.42%**：内存合并逻辑几乎无测试
- 🟢 权限系统测试覆盖良好，是安全关键路径的正确优先级

---

## 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **代码质量** | **7/10** | 架构清晰、接口一致、文档完善，但 53 处 `as any` 和 4 个 TODO 降低分数 |
| **安全性** | **7/10** | 权限系统设计优秀、沙箱加固到位，但文件工具缺少路径遍历防护、RunTool 检测弱 |
| **性能** | **8/10** | Token 缓存、正则缓存、虚拟滚动、消息限制等优化到位，无明显瓶颈 |
| **测试覆盖** | **5/10** | 974 个测试通过，但核心模块（QueryEngine 11%、memoryConsolidation 5%）覆盖率严重不足 |
| **综合评分** | **6.75/10** | |

---

## 优先修复建议

### P0 — 立即修复（安全关键）

1. **文件工具路径遍历防护**：`FileReadTool`、`FileWriteTool`、`FileEditTool` 缺少路径遍历检查，攻击者可读写工作目录外的任意文件。应添加 `isWithinWorkspace()` 检查，参考 `memory/paths.ts` 的 `validateMemoryPath()` 实现。

2. **RunTool 危险命令检测加固**：当前仅检查 6 个硬编码字符串，应复用 `BashTool` 的 `DANGEROUS_BASH_PATTERNS` 正则系统。

3. **QueryEngine 权限规则加载**：3 个 TODO 表示 `alwaysDenyRules`/`alwaysAskRules`/`alwaysAllowRules` 始终为空，用户配置的权限规则在工具执行层被完全忽略。

### P1 — 尽快修复

4. **统一 `shellEscape` 函数**：`sandbox-profiles.ts` 和 `sandbox-docker.ts` 各有一份，且 Bubblewrap 版本缺少 null byte 过滤。应提取为共享工具函数。

5. **WebFetchTool SSRF 防护补全**：添加 `0.0.0.0`、`[::1]`（IPv6 localhost）、`169.254.x.x`（链路本地）到阻止列表。

6. **权限引擎 Step 2/Step 3 交互修复**：工具 `checkPermissions` 返回 `allow` 时应仍然检查受保护路径。

7. **补充 QueryEngine 测试**：核心模块覆盖率仅 11.35%，应优先补充 `compactingPhase`、`streamingPhase`、`executingPhase` 的单元测试。

### P2 — 计划修复

8. **减少 `as any` 使用**：优先处理 `main.ts`（13 处）和 `in-process.ts`（7 处），定义专门的类型接口。

9. **App.ts 拆分**：999 行过长，应拆分为更小的组件。

10. **Docker 沙箱添加 `--cap-drop ALL`**：进一步限制容器权限。

11. **补充受保护路径**：添加 `~/.aws/`、`~/.kube/`、`~/.docker/config.json` 等云服务凭证路径。

12. **memoryConsolidation 测试补充**：当前覆盖率 5.42%，需要至少覆盖主要合并流程。
