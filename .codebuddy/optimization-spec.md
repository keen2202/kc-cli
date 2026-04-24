# CC-CLI 优化规划 (Optimization Spec)

> 基于 Code Review 的全面分析，按优先级和模块分组，供审查后逐步实施。

---

## 实施进度

| 编号 | 状态 | 说明 |
|------|------|------|
| C3 | ✅ 已完成 | 创建 `src/tools/TaskStore.ts` 统一任务存储 |
| D1 | ✅ 已完成 | 创建 `src/types/orchestrator.ts`，两方从此 re-export |
| D2 | ✅ 已完成 | 创建 `src/utils/format.ts`，两方 import 共享函数 |
| D3 | ✅ 已完成 | 创建 `src/permissions/readonlyCommands.ts`，BashTool/GitTool/classifier 统一引用 |
| D4 | ✅ 已完成 | 创建 `src/permissions/protectedPaths.ts`，engine/path.ts 统一引用 |
| D5 | ✅ 已完成 | TaskRecord 提取到 `src/tools/TaskStore.ts` |
| D6 | ✅ 已完成 | QueryEngine 改用 `uuid` 包；state.ts 的 generateSessionId 保留（轻量场景适用） |
| I1 | ✅ 已完成 | shebang 改为 `#!/usr/bin/env node` |
| I2 | ✅ 已完成 | 移除 tsconfig 中的 `"jsx": "react-jsx"` |
| I3 | ✅ 已完成 | 提取 `handleStreamEvent()` 函数，executePrompt 和 runREPL 共用 |
| I4 | ✅ 已完成 | WebSearchTool 返回 `updatedInput: input` |
| E1 | ✅ 已完成 | FileReadTool/FileWriteTool 改用 `fs.promises` 异步 API |
| E2 | ✅ 已完成 | GrepTool 添加 regex try/catch 校验 |
| E3 | ✅ 已完成 | GlobTool globToRegex 先转义特殊字符再替换通配符 |
| E4 | ✅ 已完成 | WebFetchTool 正确实现 RFC 1918 172.16.0.0/12 范围检查 |
| E5 | ✅ 已完成 | fullCompact 添加 fallback summary + try/catch |
| E6 | ✅ 已完成 | memoryExtraction 改用 `.catch()` 错误边界 |
| X2 | ✅ 已完成 | DeployTool 移除硬编码 SSH 默认值 |
| X3 | ✅ 已完成 | ConfigTool 添加条目数量(100)和单值大小(10KB)限制 |
| A2 | ✅ 已完成 | REPL 注册 SIGINT/SIGTERM 处理器实现优雅退出 |
| A3 | ✅ 已完成 | EventBus 添加 MAX_BUFFER_SIZE=1000 限制，超出丢弃最旧 |
| A4 | ✅ 已完成 | microcompact 改为基于输出长度判断是否压缩 |
| A5 | ✅ 已完成 | state.ts 添加 `resetState()` 函数 |
| P2 | ✅ 已完成 | package.json 添加 `build` 脚本 |
| P3 | ✅ 已完成 | package.json 添加 `test` 脚本 |
| S3 | ✅ 已完成 | 6 个空目录添加 .gitkeep，README 说明规划 |
| S1 | ⏳ 待实施 | 权限规则传入引擎需要 C1 LLM 客户端支持 |
| C1 | ⏳ 待实施 | 需要实现 LLM API 客户端 |
| C2 | ⏳ 待实施 | 需要修复 ESM 路径问题 |
| S2 | ⏳ 待实施 | 需要引入测试框架 |
| I5 | ⏳ 待实施 | TeamCreate 注册恢复后同步 |
| X1 | ⏳ 待实施 | BashTool 改用 spawn |
| A1 | ⏳ 待实施 | main.ts 拆分 |

---

## 一、关键问题 (Critical)

### C1. LLM 集成缺失 — 核心功能不可用
- **现状**: `QueryEngine.streamingPhase()` 生成硬编码占位字符串，无真实 LLM API 调用
- **影响**: 整个应用的核心功能无法使用
- **方案**: 实现 `api/` 目录下的 LLM 客户端，支持 Anthropic/OpenAI/Ollama 三种 provider，在 `QueryEngine` 中对接真实流式 API
- **涉及文件**: `src/api/` (新建), `src/query/QueryEngine.ts`, `src/bootstrap/config.ts`

### C2. 多智能体框架已禁用 — 死代码
- **现状**: `AgentTool` 返回模拟响应；`TeamCreateTool` 被注释掉（"TODO: fix Windows ESM path issue"）
- **影响**: orchestrator 整个子系统为死代码
- **方案**: 修复 ESM 路径问题，恢复 `TeamCreateTool` 注册，让 `AgentTool` 通过 orchestrator 生成真实子代理
- **涉及文件**: `src/tools/AgentTool/index.ts`, `src/tools.ts`, `src/orchestrator/`

### C3. TaskCreate/TaskGet 数据存储断连
- **现状**: `TaskCreateTool` 用本地 `Map` 存储，`TaskGetTool` 读 `global.taskRegistry`
- **影响**: 通过 TaskCreate 创建的任务永远不会被 TaskGet 找到
- **方案**: 统一为共享的 `TaskStore` 单例（或通过 state store），两个工具都引用同一存储
- **涉及文件**: `src/tools/TaskCreateTool/index.ts`, `src/tools/TaskGetTool/index.ts`

---

## 二、重要问题 (Significant)

### S1. 权限规则未加载到引擎 — 权限系统形同虚设
- **现状**: `hasPermissionsToUseTool()` 创建的 `PermissionContext` 中规则数组始终为空
- **影响**: deny/allow 规则配置从文件加载后从未传入权限引擎
- **方案**: 在 `runAgent()` 中将 `config.permissions` 传入权限引擎；`buildPermissionContext()` 应接收配置中的规则
- **涉及文件**: `src/permissions/engine.ts`, `src/main.ts`

### S2. 测试框架不可用
- **现状**: 测试引用 `./test-utils` 但该文件不存在；无 `npm test` 脚本
- **影响**: 测试无法运行
- **方案**: 引入 `vitest` 或 `node:test`，补全 test-utils，添加 `test` 脚本到 `package.json`
- **涉及文件**: `package.json`, `test/` 目录

### S3. 空占位目录造成项目噪声
- **现状**: `src/api/`, `src/commands/`, `src/server/`, `src/terminal/`, `src/services/skills/`, `src/services/tools/` 均为空
- **方案**: 删除空目录，待需要时再创建；或在每个目录添加 `.gitkeep` 并在 README 中说明规划
- **涉及文件**: 上述 6 个空目录

---

## 三、代码重复 (Duplication)

### D1. 重复类型定义 — SubAgentResult & MultiAgentEvent
- **现状**: `orchestrator/types.ts` 和 `state/types.ts` 定义了相同的 `SubAgentResult` 和 `MultiAgentEvent`
- **原因注释**: "to avoid circular imports"
- **方案**: 将共享类型提取到 `src/types/orchestrator.ts`，两方从此处导入；如确实存在循环依赖，考虑用 `import type` 解决
- **涉及文件**: `src/orchestrator/types.ts`, `src/state/types.ts`, 新建 `src/types/orchestrator.ts`

### D2. 重复的 `getAgeText()` 工具函数
- **现状**: `memory/scanner.ts` 和 `memory/relevanceSearch.ts` 各自实现几乎相同的年龄格式化函数
- **方案**: 提取到 `src/utils/format.ts`
- **涉及文件**: `src/memory/scanner.ts`, `src/memory/relevanceSearch.ts`, 新建 `src/utils/format.ts`

### D3. 只读命令模式列表分散
- **现状**: `BashTool`、`GitTool`、`permissions/classifier.ts` 各自维护只读/低风险命令模式列表
- **方案**: 统一到 `src/permissions/readonlyCommands.ts` 作为单一数据源
- **涉及文件**: `src/tools/BashTool/index.ts`, `src/tools/GitTool/index.ts`, `src/permissions/classifier.ts`

### D4. 受保护路径列表分散
- **现状**: `permissions/engine.ts`, `permissions/classifier.ts`, `utils/path.ts` 各自维护不同的受保护路径列表
- **方案**: 统一到 `src/utils/path.ts` 或 `src/permissions/protectedPaths.ts`
- **涉及文件**: `src/permissions/engine.ts`, `src/permissions/classifier.ts`, `src/utils/path.ts`

### D5. 重复的 TaskRecord 接口
- **现状**: `TaskCreateTool` 和 `TaskGetTool` 定义了相同的 `TaskRecord`
- **方案**: 提取到共享位置（与 C3 的 TaskStore 统一处理）
- **涉及文件**: `src/tools/TaskCreateTool/index.ts`, `src/tools/TaskGetTool/index.ts`

### D6. UUID 生成方式不统一
- **现状**: `QueryEngine.ts` 自实现 `uuidv4()`，`state.ts` 有 `generateSessionId()`，`uuid` 包已安装但未使用
- **方案**: 统一使用 `uuid` 包，删除自实现版本
- **涉及文件**: `src/query/QueryEngine.ts`, `src/state/store.ts`

---

## 四、不一致性 (Inconsistencies)

### I1. shebang 指向 bun 但项目用 Node.js
- **现状**: `#!/usr/bin/env bun`，但 README 说 "no Bun required"，`package.json` 用 `npx tsx`
- **方案**: 改为 `#!/usr/bin/env node` 或 `#!/usr/bin/env tsx`
- **涉及文件**: `src/main.ts`

### I2. tsconfig 包含不必要的 JSX 配置
- **现状**: `"jsx": "react-jsx"`，纯 CLI 项目无需 JSX
- **方案**: 移除 `jsx` 字段
- **涉及文件**: `tsconfig.json`

### I3. main.ts 事件处理不一致
- **现状**: `executePrompt()` 处理 `agent:*` + 旧版事件，`runREPL()` 只处理旧版事件
- **方案**: 统一事件处理，提取公共 `handleStreamEvent()` 函数供两处复用
- **涉及文件**: `src/main.ts`

### I4. `WebSearchTool.checkPermissions` 返回空对象
- **现状**: `updatedInput: {}` 导致后续可能丢失输入参数
- **方案**: 返回 `updatedInput: input`
- **涉及文件**: `src/tools/WebSearchTool/index.ts`

### I5. `ToolName` 类型与实际工具名不匹配
- **现状**: `ToolName` 包含 `TeamCreate` 但该工具被注释掉
- **方案**: 保持 `ToolName` 与实际注册工具同步，或改用从注册表动态推导类型
- **涉及文件**: `src/types/tools.ts`, `src/tools.ts`

---

## 五、错误处理缺失 (Missing Error Handling)

### E1. 文件操作使用同步 API
- **现状**: `FileReadTool` 用 `fs.existsSync`/`fs.statSync`，`FileWriteTool` 用 `fs.mkdirSync`
- **方案**: 替换为 `fs.promises.access()`/`fs.promises.stat()`/`fs.promises.mkdir()`
- **涉及文件**: `src/tools/FileReadTool/index.ts`, `src/tools/FileWriteTool/index.ts`

### E2. GrepTool 正则未校验
- **现状**: 用户输入的 regex 直接使用，畸形正则会抛未捕获异常
- **方案**: 在 `try/catch` 中执行 `new RegExp(input.pattern)` 或用 safe-regexp 限制
- **涉及文件**: `src/tools/GrepTool/index.ts`

### E3. GlobTool glob-to-regex 未转义特殊字符
- **现状**: `.` 在 glob 中应匹配字面点，但当前转为正则后匹配任意字符
- **方案**: 对 glob 模式中的 `.` 先转义为 `\.`，再替换 `*` 和 `?`
- **涉及文件**: `src/tools/GlobTool/index.ts`

### E4. WebFetchTool 私有 IP 检查不完整
- **现状**: 仅检查 `172.16.*`，漏掉了 `172.17-172.31`
- **方案**: 正确实现 RFC 1918 `172.16.0.0/12` 范围检查
- **涉及文件**: `src/tools/WebFetchTool/index.ts`

### E5. `fullCompact()` 引用不存在的 API
- **现状**: `apiClient.generateSummary()` 在任何类型上都未定义，运行时会报错
- **方案**: 等待 LLM 客户端实现后对接真实 API，当前先标记为 TODO 并返回降级结果
- **涉及文件**: `src/services/compaction.ts`

### E6. `memoryExtraction.ts` 火后即忘无错误边界
- **现状**: `void executeMemoryExtraction(trailingContext)` 无 try/catch
- **方案**: 添加错误边界，至少记录日志
- **涉及文件**: `src/services/memoryExtraction.ts`

---

## 六、安全隐患 (Security)

### X1. BashTool 命令转义脆弱
- **现状**: 用单引号包裹 + 简单替换 `'`，可被精心构造的输入绕过
- **方案**: 使用 `child_process.spawn` 的 args 数组而非 `exec`，避免 shell 注入
- **涉及文件**: `src/tools/BashTool/index.ts`

### X2. DeployTool 硬编码 SSH 默认值
- **现状**: 默认 `user@server` 是信息泄露风险
- **方案**: 移除默认值，要求用户显式配置
- **涉及文件**: `src/tools/DeployTool/index.ts`

### X3. ConfigTool 会话配置无大小限制
- **现状**: LLM 可创建无限 session config 条目
- **方案**: 添加条目数量和单条大小上限
- **涉及文件**: `src/tools/ConfigTool/index.ts`

---

## 七、架构优化 (Architecture)

### A1. 拆分 main.ts
- **现状**: 448 行，包含 CLI 解析、REPL 循环、事件处理、系统提示词构建、子命令
- **方案**: 拆分为：
  - `src/cli/program.ts` — Commander 程序定义
  - `src/cli/repl.ts` — REPL 循环
  - `src/cli/events.ts` — 统一事件处理器
  - `src/cli/systemPrompt.ts` — 系统提示词构建
  - `src/main.ts` — 仅保留入口调用
- **涉及文件**: `src/main.ts` 及新建文件

### A2. 优雅退出
- **现状**: 进程直接退出，`executePostTurnHooksSync()` 未被调用
- **方案**: 注册 `SIGINT`/`SIGTERM` 处理器，执行清理逻辑后退出
- **涉及文件**: `src/main.ts`

### A3. EventBus 缓冲区无限增长
- **现状**: 事件按 agent 缓冲但从不自动清理
- **方案**: 添加最大缓冲区大小，超出时丢弃最旧事件或拒绝新事件
- **涉及文件**: `src/orchestrator/event-bus.ts`

### A4. compaction microcompact bug
- **现状**: `hasCompactableTool` 检查始终返回 `true`（注释 "For now, clear all old tool results"），导致清除所有工具结果而非仅可压缩的
- **方案**: 正确实现 `hasCompactableTool` 检查，只清除 `COMPACTABLE_TOOLS` 列表中的工具结果
- **涉及文件**: `src/services/compaction.ts`

### A5. 全局可变状态
- **现状**: `bootstrap/state.ts` 用模块级 `let state`，测试环境中可能产生陈旧引用
- **方案**: 考虑依赖注入模式，或至少提供 `resetState()` 用于测试隔离
- **涉及文件**: `src/bootstrap/state.ts`

---

## 八、配置/工程化 (Project Config)

### P1. 移除未使用的 `uuid` 依赖或统一使用
- **涉及文件**: `package.json`, `src/query/QueryEngine.ts`, `src/state/store.ts`

### P2. 添加 build 脚本
- **现状**: 无 `build`/`dist` 脚本，`"main": "src/main.ts"` 指向 TS 源码
- **方案**: 添加 `tsc` build 命令，`"main"` 指向编译输出
- **涉及文件**: `package.json`, `tsconfig.json`

### P3. 添加 `npm test` 脚本
- **涉及文件**: `package.json`

---

## 建议实施顺序

| 阶段 | 项目 | 预期收益 |
|------|------|---------|
| **Phase 1 — 基础修复** | C3, D1-D6, I1-I4, E2-E4, P1-P3 | 消除 bug 和代码重复，项目可构建可测试 |
| **Phase 2 — 核心功能** | C1, C2, S1, E1, E5-E6 | 让应用真正可用 |
| **Phase 3 — 架构优化** | A1-A5, S2-S3, I5 | 提升代码质量和可维护性 |
| **Phase 4 — 安全加固** | X1-X3, E4 | 生产环境安全准备 |

---

*请审查此规划，确认后我将按阶段逐步实施修改。*
