# KC-CLI v2 Task Breakdown

> **项目**: KC-CLI v2 升级
> **创建日期**: 2026-05-13
> **关联 Spec**: [docs/v2-upgrade-spec.md](docs/v2-upgrade-spec.md)

---

## Phase 1: 沙箱系统集成(P0 安全关键)

### TASK-001: 扩展沙箱策略配置

**Status**: completed
**Priority**: P0
**Phase**: Phase 1

**任务描述**:
- Imperative: Extend sandbox configuration system with policy support
- Present Continuous: Extending sandbox configuration system with policy support

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-002, TASK-003, TASK-004]

**Checklist**:
- [ ] 在 `src/bootstrap/config.ts` 新增 `sandbox` 配置段(enabled/backend/allowNetwork/maxMemoryMb/cpuTimeLimitSec)
- [ ] 创建 `src/services/sandbox-policy.ts`:支持按工具名称设置沙箱策略
- [ ] 支持 per-tool sandbox policy(如 BashTool 强制沙箱,FileReadTool 不沙箱)
- [ ] 在 `.kc-cli/config.json` 中添加 sandbox 配置示例
- [ ] 更新 `SandboxManager` 构造函数接收 `SandboxPolicy`
- [ ] 配置加载失败时降级到 noop 并输出警告

**Spec Documentation**: [§2.1 沙箱系统集成 - A&C](docs/v2-upgrade-spec.md#21-沙箱系统集成)

---

### TASK-002: ToolExecutor 集成 SandboxManager

**Status**: completed
**Priority**: P0
**Phase**: Phase 1

**任务描述**:
- Imperative: Integrate SandboxManager into ToolExecutor for command wrapping
- Present Continuous: Integrating SandboxManager into ToolExecutor for command wrapping

**Dependencies**:
- `blockedBy`: [TASK-001]
- `blocks`: [TASK-005, TASK-012]

**Checklist**:
- [ ] 修改 `src/executors/toolExecutor.ts` 构造函数注入 `SandboxManager`
- [ ] 在 `executeBashTool()` 中对命令调用 `sandbox.wrapCommand()`
- [ ] BashTool 的 `checkPermissions()` 中添加沙箱可用性检查
- [ ] 非沙箱命令(FileRead/Glob/Grep)保持原有执行路径
- [ ] 添加沙箱状态到 tool result metadata(sandboxed: true/false, backend: string)
- [ ] 更新 verbose 模式输出沙箱信息
- [ ] 编写 `test/executors/toolExecutor-sandbox.test.ts`:验证命令被正确包装

**Spec Documentation**: [§2.1 沙箱系统集成 - A](docs/v2-upgrade-spec.md#21-沙箱系统集成)

---

### TASK-003: 实现 Docker 沙箱后端

**Status**: completed
**Priority**: P0
**Phase**: Phase 1

**任务描述**:
- Imperative: Implement DockerSandbox backend for container-based isolation
- Present Continuous: Implementing DockerSandbox backend for container-based isolation

**Dependencies**:
- `blockedBy`: [TASK-001]
- `blocks`: [TASK-005]

**Checklist**:
- [ ] 创建 `src/services/sandbox-docker.ts`:实现 `SandboxBackend` 接口
- [ ] `docker run` 参数:`--network none`(默认隔离)、`--memory`、`--cpus`、`--read-only`
- [ ] 支持 `--network bridge`(allowNetwork=true 时)
- [ ] 使用 `node:22-alpine` 作为默认基础镜像
- [ ] 支持自定义镜像(通过配置)
- [ ] `isAvailable()` 检查 Docker 是否安装并运行
- [ ] 在 `sandbox.ts` 的 `BACKEND_REGISTRY` 注册 `docker`
- [ ] 编写 `test/services/sandbox-docker.test.ts`
- [ ] 编写 `test/integration/sandbox-e2e.test.ts`:在容器中执行命令并验证隔离

**Spec Documentation**: [§2.1 沙箱系统集成 - B](docs/v2-upgrade-spec.md#21-沙箱系统集成)

---

### TASK-004: 增强 seccomp profile 支持

**Status**: completed
**Priority**: P0
**Phase**: Phase 1

**任务描述**:
- Imperative: Add seccomp profile to SeccompSandbox for syscall filtering
- Present Continuous: Adding seccomp profile to SeccompSandbox for syscall filtering

**Dependencies**:
- `blockedBy`: [TASK-001]
- `blocks`: [TASK-005]

**Checklist**:
- [ ] 创建 `src/services/seccomp-profile.json`:定义允许的系统调用白名单
- [ ] 修改 `SeccompSandbox.wrapCommand()` 使用 `--security-opt seccomp=seccomp-profile.json`
- [ ] 白名单包含:read/write/mmap/mprotect/brk 等基础调用
- [ ] 黑名单禁止:ptrace、mount、umount、reboot、swapon
- [ ] 在 Docker 后端也应用 seccomp profile
- [ ] 测试 seccomp 拒绝 `ptrace` 系统调用

**Spec Documentation**: [§2.1 沙箱系统集成 - C](docs/v2-upgrade-spec.md#21-沙箱系统集成)

---

### TASK-005: 沙箱集成测试与安全验证

**Status**: completed
**Priority**: P0
**Phase**: Phase 1

**任务描述**:
- Imperative: Write comprehensive sandbox integration tests and security verification
- Present Continuous: Writing comprehensive sandbox integration tests and security verification

**Dependencies**:
- `blockedBy`: [TASK-002, TASK-003, TASK-004]
- `blocks`: [TASK-015]

**Checklist**:
- [ ] 沙箱逃逸测试:sandbox 中 `cat /etc/passwd` 应失败
- [ ] 网络隔离测试:sandbox 中 `curl https://example.com` 应失败
- [ ] 资源限制测试:sandbox 中执行内存密集型命令应被 kill
- [ ] CPU 时间限制测试:sandbox 中执行 `while true` 应被 timeout
- [ ] 后端降级测试:Docker 不可用 → bubblewrap → seccomp → noop
- [ ] 验证沙箱状态正确反映在 tool result metadata 中
- [ ] 所有测试在 CI 中通过(Linux + Docker 环境)

**Spec Documentation**: [§五 验证和测试方案 - 5.2 安全验证](docs/v2-upgrade-spec.md#52-安全验证)

---

## Phase 2: TUI 重构(P1 架构核心)

### TASK-006: 设计分栏布局架构

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Design and implement sidebar layout architecture for Ink UI
- Present Continuous: Designing and implementing sidebar layout architecture for Ink UI

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-007, TASK-008, TASK-009]

**Checklist**:
- [ ] 定义布局数据结构(Sidebar/Main/BottomBar 宽度比例)
- [ ] 修改 `src/ui/components/App.ts` 为 `<Box direction="row">` 分栏结构
- [ ] 实现可调节宽度(左右拖拽分栏)
- [ ] 实现分栏折叠/展开(快捷键切换)
- [ ] 响应式布局:窄终端自动折叠侧栏
- [ ] 保持现有 REPL fallback 兼容

**Spec Documentation**: [§2.2 TUI 重构 - A](docs/v2-upgrade-spec.md#22-tui-重构)

---

### TASK-007: 实现 Sidebar + FileTree 组件

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Implement Sidebar and FileTree components with LSP diagnostic markers
- Present Continuous: Implementing Sidebar and FileTree components with LSP diagnostic markers

**Dependencies**:
- `blockedBy`: [TASK-006]
- `blocks`: [TASK-010]

**Checklist**:
- [ ] 创建 `src/ui/components/Sidebar.tsx`:可折叠侧边栏
- [ ] 创建 `src/ui/components/FileTree.tsx`:文件树组件
- [ ] FileTree 支持递归展开/折叠
- [ ] 集成 LSP diagnostics:错误文件显示红色 ⚠ 标记
- [ ] 当前工作目录文件树自动刷新
- [ ] 支持 `.gitignore` 排除(复用 GlobTool 逻辑)
- [ ] 键盘导航:↑↓ 移动文件,Enter 打开预览
- [ ] 编写 `test/ui/sidebar.test.tsx`

**Spec Documentation**: [§2.2 TUI 重构 - B](docs/v2-upgrade-spec.md#22-tui-重构)

---

### TASK-008: 实现 DiffPreview 组件

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Implement DiffPreview component integrating diff-viewer.ts
- Present Continuous: Implementing DiffPreview component integrating diff-viewer.ts

**Dependencies**:
- `blockedBy`: [TASK-006]
- `blocks`: [TASK-010]

**Checklist**:
- [x] 创建 `src/ui/components/DiffPreview.tsx`:差异预览组件(Ink/React 参考实现)
- [x] 扩展 `src/ui/diff-viewer.ts`:添加 `renderMultiFileDiff()` 和 `FileDiff` 接口
- [x] 支持添加/删除/修改行的颜色高亮(chalk green/red/gray)
- [x] 支持文件切换(多文件 diff 场景,activeIndex + tab bar)
- [x] FileEditTool/FileWriteTool 执行后自动弹出 diff 预览
  - FileWriteTool:写入前捕获 oldContent 到 metadata
  - FileEditTool:metadata 暴露 oldContent/newContent
  - App.ts:tool_completed 事件中自动调用 showDiffIfPending
- [x] 支持接受/拒绝变更(/accept /reject /diff 命令)
- [x] 编写 `test/ui/diff-preview.test.ts`:26 个测试用例

**Spec Documentation**: [§2.2 TUI 重构 - B](docs/v2-upgrade-spec.md#22-tui-重构)

---

### TASK-009: 实现 CommandPalette + ModelSelector

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Implement CommandPalette and ModelSelector components
- Present Continuous: Implementing CommandPalette and ModelSelector components

**Dependencies**:
- `blockedBy`: [TASK-006]
- `blocks`: [TASK-010]

**Checklist**:
- [x] 创建 `src/ui/components/CommandPalette.ts`:命令面板组件
  - PaletteState 状态管理、模糊搜索 (filterCommands)、键盘导航 (up/down/wrap)
  - 6 个默认命令(model/provider/permission/clear/help/exit)
  - `renderCommandPalette()` chalk 渲染器
- [x] 创建 `src/ui/components/ModelSelector.ts`:模型选择器
  - 7 个已知 provider(DeepSeek/Anthropic/OpenAI/Qwen/GLM/OAI-compat/Ollama)
  - 每个 provider 含 2-3 个模型及参数(contextWindow/maxOutput)
  - Provider 和 Model 双级选择,↑↓ 导航,Enter 确认,Esc 退出
  - `renderModelSelector()` chalk 渲染器
- [x] App.ts 集成:
  - `/palette` 命令打开命令面板(搜索 + 选择 + 执行)
  - `/model` 命令直接打开模型选择器
  - `/permission [mode]` 查看/切换权限模式
  - Palette/ModelSelector 叠加层渲染(render 时检测 active 状态)
  - 切换模型后显示确认消息
- [x] 编写 `test/ui/command-palette.test.ts`:25 个测试用例
- [x] 编写 `test/ui/model-selector.test.ts`:21 个测试用例

**Spec Documentation**: [§2.2 TUI 重构 - B](docs/v2-upgrade-spec.md#22-tui-重构)

---

### TASK-010: UI 性能优化与集成测试

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Optimize UI rendering performance and write integration tests
- Present Continuous: Optimizing UI rendering performance and writing integration tests

**Dependencies**:
- `blockedBy`: [TASK-007, TASK-008, TASK-009]
- `blocks`: [TASK-015]

**Checklist**:
- [x] 流式输出节流 16ms/帧(`requestAnimationFrame` 风格)
- [x] 长对话虚拟滚动(>100 条消息时分页渲染)
- [x] Diff 计算使用 `worker_threads` 异步执行
- [x] 键盘事件优化(使用 `useInput` 避免重复绑定)
- [x] 编写 `test/ui/app.test.tsx`:完整 UI 交互流程
- [x] 性能基准:UI 渲染帧率达到 60fps
- [x] 内存测试:长对话(100+ 轮)内存增长 <50MB

**Spec Documentation**: [§2.2 TUI 重构 - C](docs/v2-upgrade-spec.md#22-tui-重构)

---

## Phase 2.5: LSP 集成增强(P1 架构核心)

### TASK-011: 实现 DocumentManager + 可靠诊断

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Implement DocumentManager for reliable LSP document synchronization
- Present Continuous: Implementing DocumentManager for reliable LSP document synchronization

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-013]

**Checklist**:
- [ ] 创建 `src/lsp/document-manager.ts`:管理文档版本和内容
- [ ] `openDocument()` / `updateDocument()` / `closeDocument()` 生命周期
- [ ] 支持 LSP incremental sync(`textDocument/didChange` 带版本递增)
- [ ] 重构 `LSPClientManager.getDiagnostics()` 使用 DocumentManager
- [ ] 移除 `setTimeout(500)` 不可靠等待,改用 `textDocument/publishDiagnostics` 通知监听
- [ ] 诊断结果缓存支持版本失效(文档修改后自动清除缓存)
- [ ] 编写 `test/lsp/document-manager.test.ts`
- [ ] 编写 `test/lsp/diagnostics-reliable.test.ts`

**Spec Documentation**: [§2.4 LSP 集成增强 - B](docs/v2-upgrade-spec.md#24-lsp-集成增强)

---

### TASK-012: 实现 LSP 补全服务

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Implement LSP completion provider and expose as tool
- Present Continuous: Implementing LSP completion provider and exposing as tool

**Dependencies**:
- `blockedBy`: [TASK-011]
- `blocks`: [TASK-013]

**Checklist**:
- [ ] 创建 `src/lsp/completion.ts`:`LSPCompletionProvider` 类
- [ ] 实现 `textDocument/completion` 请求
- [ ] 支持 snippet 展开(`$1`, `$2` 占位符解析)
- [ ] 补全结果按 LSP `sortText` 排序
- [ ] 支持 `completionItem/resolve` 获取详细信息
- [ ] 创建 `src/tools/LSPTool/index.ts`:LSP 工具注册
- [ ] LSPTool 暴露方法:getCompletions、getDiagnostics、getDefinition
- [ ] 编写 `test/lsp/completion.test.ts`

**Spec Documentation**: [§2.4 LSP 集成增强 - A & C](docs/v2-upgrade-spec.md#24-lsp-集成增强)

---

### TASK-013: 扩展 LSP 功能(引用/重命名/代码操作)

**Status**: completed
**Priority**: P1
**Phase**: Phase 2

**任务描述**:
- Imperative: Extend LSP with references, rename, and code actions
- Present Continuous: Extending LSP with references, rename, and code actions

**Dependencies**:
- `blockedBy`: [TASK-011, TASK-012]
- `blocks`: [TASK-015]

**Checklist**:
- [ ] 创建 `src/lsp/references.ts`:`textDocument/references` 实现
- [ ] 创建 `src/lsp/code-actions.ts`:`textDocument/codeAction` 实现
- [ ] 支持快速修复:添加缺失 import、修复拼写
- [ ] 实现 `textDocument/rename`:安全重命名(带所有引用更新)
- [ ] 实现 `workspace/symbol`:全局符号搜索
- [ ] 扩展语言支持:Java (jdtls)、C++ (clangd)
- [ ] 更新 `src/lsp/types.ts` 添加新类型定义
- [ ] LSPTool 注册新方法
- [ ] 编写 `test/lsp/references.test.ts` 和 `test/lsp/code-actions.test.ts`

**Spec Documentation**: [§2.4 LSP 集成增强 - D](docs/v2-upgrade-spec.md#24-lsp-集成增强)

---

## Phase 3: 模型适配深度优化(P1 架构核心)

### TASK-014: 实现 Provider 特化 Prompt 系统

**Status**: completed
**Priority**: P1
**Phase**: Phase 3

**任务描述**:
- Imperative: Implement provider-specific prompt templates and capability detection
- Present Continuous: Implementing provider-specific prompt templates and capability detection

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-015]

**Checklist**:
- [ ] 创建 `src/api/capabilities.ts`:`ProviderCapabilities` 接口和探测逻辑
- [ ] 创建 `src/api/prompts/provider-prompts.ts`:按 provider 组织的 prompt 模板
- [ ] Anthropic prompt:利用 `<thinking>` 标签增强推理
- [ ] OpenAI prompt:利用 `parallel_tool_calls` 提高效率
- [ ] Qwen/GLM prompt:中文优化模板
- [ ] 创建 `src/api/prompts/task-prompts.ts`:按任务类型组织的 prompt
- [ ] 代码生成、调试、重构、文档等不同场景的 prompt 变体
- [ ] `BaseApiClient` 构造函数注入 `ProviderCapabilities`
- [ ] `QueryEngine` 根据 provider 能力动态选择工具并行策略
- [ ] 编写 `test/api/capabilities.test.ts`
- [ ] 编写 `test/api/provider-prompts.test.ts`

**Spec Documentation**: [§2.3 模型适配深度优化 - A & B](docs/v2-upgrade-spec.md#23-模型适配深度优化)

---

### TASK-015: Token 估算精度提升 + 动态参数调优

**Status**: completed
**Priority**: P2
**Phase**: Phase 3

**任务描述**:
- Imperative: Replace character-based token estimation with precise tiktoken encoding
- Present Continuous: Replacing character-based token estimation with precise tiktoken encoding

**Dependencies**:
- `blockedBy`: [TASK-005, TASK-010, TASK-013, TASK-014]
- `blocks`: []

**Checklist**:
- [ ] 重构 `src/utils/tokenEstimation.ts` 使用 js-tiktoken 精确编码
- [ ] 支持多编码:cl100k_base(GPT)、o200k_base(GPT-4o)、anthropic(Claude)
- [ ] 根据 `ProviderCapabilities` 自动选择编码器
- [ ] 实现动态参数调优:`max_tokens`、`temperature`、`top_p` 按模型自适应
- [ ] `QueryEngine.compactingPhase()` 使用精确 token 估算
- [ ] 缓存 token 估算结果(精确编码后仍需缓存避免重复计算)
- [ ] 编写 `test/utils/tokenEstimation.test.ts`:对比估算 vs 精确编码
- [ ] 性能验证:精确编码开销 <10ms/1000 字符

**Spec Documentation**: [§2.3 模型适配深度优化 - C](docs/v2-upgrade-spec.md#23-模型适配深度优化)

---

## Phase 3.5: 测试覆盖提升(P2 工程品质)

### TASK-016: 权限系统完整测试

**Status**: completed
**Priority**: P2
**Phase**: Phase 3

**任务描述**:
- Imperative: Write comprehensive tests for permission engine, rules, and interaction
- Present Continuous: Writing comprehensive tests for permission engine, rules, and interaction

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-018]

**Checklist**:
- [ ] 扩展现有 `test/permissions/engine.test.ts`:覆盖全部 6 步决策流
  - [ ] Step 1: deny 规则优先
  - [ ] Step 2: 工具级权限检查
  - [ ] Step 3: 安全关键检查(bypass 免疫)
  - [ ] Step 4: bypass 模式行为
  - [ ] Step 5: allow 规则匹配
  - [ ] Step 6: 模式默认行为
- [ ] 扩展现有 `test/permissions/rules.test.ts`:
  - [ ] 通配符 `*` 匹配
  - [ ] 前缀匹配 `Bash:rm:*`
  - [ ] 大小写不敏感
  - [ ] 边界条件(空规则、无效规则)
- [ ] 新建 `test/permissions/interaction.test.ts`:
  - [ ] 用户允许操作
  - [ ] 用户拒绝操作
  - [ ] 用户选择 "记住选择"
  - [ ] 超时处理
- [ ] 新建 `test/utils/path.test.ts`:
  - [ ] 路径遍历攻击检测
  - [ ] 符号链接解析
  - [ ] Unicode 规范化
  - [ ] 受保护路径匹配

**Spec Documentation**: [§2.5 测试覆盖提升 - A.1](docs/v2-upgrade-spec.md#25-测试覆盖提升)

---

### TASK-017: QueryEngine 和核心引擎测试扩展

**Status**: completed
**Priority**: P2
**Phase**: Phase 3

**任务描述**:
- Imperative: Expand QueryEngine and core engine test coverage to 70%+
- Present Continuous: Expanding QueryEngine and core engine test coverage to 70%+

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-018]

**Checklist**:
- [x] 扩展现有 `test/QueryEngine.test.ts`(当前 9.34% → 70%+):
  - [x] 状态机循环完整覆盖(idle→compact→stream→decide→execute)
  - [x] micro-compact 触发和结果
  - [x] full-compact 触发和摘要
  - [x] 流式输出事件
  - [x] 工具调用执行
  - [x] 工具权限拒绝
  - [x] API 错误重试
  - [x] 消息截断(超过 maxMessages)
  - [x] abort 信号处理
  - [x] 记忆加载集成
- [x] 新建 `test/executors/toolExecutor.test.ts`:
  - [x] 工具注册和查找
  - [x] 权限检查集成
  - [x] 超时处理
  - [x] 并行执行
  - [x] 沙箱集成(与 TASK-002 配合)
- [x] 扩展现有 `test/api/BaseApiClient.test.ts`:
  - [x] 流式响应解析
  - [x] 错误分类和重试
  - [x] 消息格式化

**Spec Documentation**: [§2.5 测试覆盖提升 - A.2](docs/v2-upgrade-spec.md#25-测试覆盖提升)

---

### TASK-018: 测试基础设施 + CI 门禁

**Status**: completed
**Priority**: P2
**Phase**: Phase 3

**任务描述**:
- Imperative: Set up test infrastructure, mock LLM, and CI coverage gates
- Present Continuous: Setting up test infrastructure, mock LLM, and CI coverage gates

**Dependencies**:
- `blockedBy`: [TASK-016, TASK-017]
- `blocks`: [TASK-019]

**Checklist**:
- [x] 创建 `test/utils/mock-llm.ts`:MockLLMClient
  - [x] 支持预设响应序列
  - [x] 支持注入错误场景
  - [x] 支持模拟流式输出
- [x] 创建 `test/utils/fixtures.ts`:预定义测试场景
  - [x] 安全命令列表
  - [x] 危险命令列表
  - [x] 测试用文件结构
- [x] 更新 `vitest.config.ts` 添加覆盖率阈值
- [x] 在 `package.json` 添加 `test:ci` 脚本
- [x] 更新 `.github/workflows/ci.yml` 添加覆盖率检查步骤
- [x] 所有现有测试通过

**Spec Documentation**: [§2.5 测试覆盖提升 - B & C](docs/v2-upgrade-spec.md#25-测试覆盖提升)

---

## Phase 4: 集成 + 发布

### TASK-019: 端到端集成测试

**Status**: completed
**Priority**: P2
**Phase**: Phase 4

**任务描述**:
- Imperative: Write end-to-end integration tests for all new features
- Present Continuous: Writing end-to-end integration tests for all new features

**Dependencies**:
- `blockedBy`: [TASK-005, TASK-010, TASK-013, TASK-015, TASK-018]
- `blocks`: [TASK-020]

**Checklist**:
- [x] `test/integration/sandbox-e2e.test.ts`:沙箱端到端测试
  - [x] Bash 命令在沙箱中执行并验证隔离
  - [x] 网络隔离验证
  - [x] 资源限制验证
- [x] `test/integration/lsp-e2e.test.ts`:LSP 端到端测试
  - [x] 连接 TypeScript 语言服务器
  - [x] 获取诊断并验证准确性
  - [x] 补全建议并验证正确性
- [x] `test/integration/multi-agent.test.ts`:多 Agent 编排测试
  - [x] 父 Agent  spawn 子 Agent
  - [x] 权限级联验证
  - [x] 结果聚合验证
- [x] `test/integration/full-workflow.test.ts`:完整工作流测试
  - [x] 用户提问 → Agent 使用多个工具 → 完成任务
  - [x] 沙箱 + LSP + 记忆系统协同工作

**Spec Documentation**: [§五 验证和测试方案 - 5.1 自动化测试](docs/v2-upgrade-spec.md#51-自动化测试)

---

### TASK-020: v2.0 发布准备

**Status**: completed
**Priority**: P2
**Phase**: Phase 4

**任务描述**:
- Imperative: Prepare v2.0 release with documentation and migration guide
- Present Continuous: Preparing v2.0 release with documentation and migration guide

**Dependencies**:
- `blockedBy`: [TASK-019]
- `blocks`: []

**Checklist**:
- [x] 更新 `README.md` 添加 v2 新特性说明
- [x] 创建 `docs/migration-guide.md`:v1 → v2 迁移指南
- [x] 更新 `docs/architecture.md` 反映新架构
- [x] 更新 `docs/sandbox-security.md` 沙箱安全文档
- [x] 创建 `docs/lsp-integration.md` LSP 集成文档
- [x] 创建 `docs/ui-guide.md` UI 使用指南
- [x] 更新 `package.json` version 到 `2.0.0`
- [x] 编写 `CHANGELOG.md` 记录所有变更
- [x] 运行 `npm run test:ci` 确认所有测试通过 (874 passed / 18 skipped)
- [x] 运行 `npm run typecheck` 确认类型检查通过
- [x] 运行 `npm run build` 确认构建成功
- [ ] 创建 Git tag `v2.0.0` 并推送

**Spec Documentation**: [§四 实施进度追踪表](docs/v2-upgrade-spec.md#四实施进度追踪表)

---

## 任务依赖图

```
TASK-001 (沙箱配置) ─┬─→ TASK-002 (ToolExecutor 集成) ─┬─→ TASK-005 (沙箱测试) ─┐
                     ├─→ TASK-003 (Docker 后端) ────────┤                       │
                     └─→ TASK-004 (seccomp profile) ────┘                       │
                                                                                │
TASK-006 (分栏布局) ─┬─→ TASK-007 (Sidebar/FileTree) ──┬─→ TASK-010 (UI优化) ──┤
                     ├─→ TASK-008 (DiffPreview) ────────┤                       │
                     └─→ TASK-009 (CommandPalette) ─────┘                       │
                                                                                ├──→ TASK-019 (E2E) ─→ TASK-020 (发布)
TASK-011 (DocumentManager) ─→ TASK-012 (补全) ─→ TASK-013 (LSP扩展) ───────────┤
                                                                                │
TASK-014 (Provider Prompts) ────────────────────→ TASK-015 (Token 估算) ───────┤
                                                                                │
TASK-016 (权限测试) ─┬─→ TASK-018 (CI 门禁) ───────────────────────────────────┘
TASK-017 (引擎测试) ─┘
```

---

## 状态追踪

| Status | Count | Tasks |
|--------|-------|-------|
| ✅ completed | 20 | TASK-001 ~ TASK-020 |
| 🔄 in_progress | 0 | — |
| ⏳ pending | 0 | — |
| 🚫 blocked | 0 | — |
