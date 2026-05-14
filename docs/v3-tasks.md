# KC-CLI v3 Task Breakdown

> **项目**: KC-CLI v3 改进
> **创建日期**: 2026-05-13
> **关联 Spec**: [docs/v3-improvement-spec.md](docs/v3-improvement-spec.md)
> **前置依赖**: v2-tasks.md Phase 1-2 已完成（TASK-001 ~ TASK-009）

---

## Phase 1: 沙箱深化 + LSP 基础（Week 1-2）

### TASK-021: 沙箱逃逸检测探针

**Status**: pending
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Implement sandbox isolation verification probes
- Present Continuous: Implementing sandbox isolation verification probes

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-024]

**Checklist**:
- [ ] 创建 `src/services/sandbox-probe.ts`：`SandboxProbe` 类
- [ ] 实现文件系统隔离测试（尝试读取 /etc/shadow）
- [ ] 实现网络隔离测试（尝试 curl 外部地址）
- [ ] 实现进程隔离测试（尝试 kill 宿主进程）
- [ ] 实现权限提升测试（尝试 sudo）
- [ ] 在 `SandboxManager` 启动时自动运行 probe（可配置关闭）
- [ ] Probe 结果输出到 verbose 日志
- [ ] 编写 `test/services/sandbox-probe.test.ts`

**Spec Documentation**: [§2.1.3 沙箱逃逸检测](docs/v3-improvement-spec.md#213-沙箱逃逸检测)

---

### TASK-022: 沙箱运行时资源监控

**Status**: pending
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Add runtime resource monitoring for sandboxed commands
- Present Continuous: Adding runtime resource monitoring for sandboxed commands

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-024]

**Checklist**:
- [ ] 创建 `src/services/sandbox-monitor.ts`：`SandboxMonitor` 类
- [ ] 实现 `SandboxMetrics` 接口（memoryUsageMb, cpuPercent, wallTimeMs, networkBytes）
- [ ] Docker 后端：通过 `docker stats --no-stream` 采集指标
- [ ] Bubblewrap 后端：通过 `/proc/[pid]/stat` 采集指标
- [ ] 超阈值自动终止（memory > maxMemoryMb * 1.1 或 cpu > 95%）
- [ ] 指标输出到 tool result metadata
- [ ] 编写 `test/services/sandbox-monitor.test.ts`

**Spec Documentation**: [§2.1.1 运行时资源监控](docs/v3-improvement-spec.md#211-运行时资源监控)

---

### TASK-023: Docker 镜像管理

**Status**: pending
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 1d

**任务描述**:
- Imperative: Implement Docker image management with caching and custom images
- Present Continuous: Implementing Docker image management with caching and custom images

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-024]

**Checklist**:
- [ ] 创建 `src/services/sandbox-images.ts`：`ImageManager` 类
- [ ] `ensureImage(image)` — 检查镜像是否存在，不存在则拉取（带进度）
- [ ] `listCachedImages()` — 列出已缓存的沙箱镜像
- [ ] `pruneUnused()` — 清理未使用的沙箱镜像
- [ ] 支持项目级自定义 Dockerfile（`.kc-cli/Dockerfile.sandbox`）
- [ ] `DockerSandbox` 使用 `ImageManager.ensureImage()` 替代硬编码镜像
- [ ] 创建 `.kc-cli/Dockerfile.sandbox` 示例文件
- [ ] 编写 `test/services/sandbox-images.test.ts`

**Spec Documentation**: [§2.1.2 Docker 镜像管理](docs/v3-improvement-spec.md#212-docker-镜像管理)

---

### TASK-024: 沙箱系统集成与测试

**Status**: pending
**Priority**: P0
**Phase**: Phase 1
**预估工时**: 1d

**任务描述**:
- Imperative: Integrate sandbox probe, monitor, and image manager into SandboxManager
- Present Continuous: Integrating sandbox probe, monitor, and image manager into SandboxManager

**Dependencies**:
- `blockedBy`: [TASK-021, TASK-022, TASK-023]
- `blocks`: []

**Checklist**:
- [ ] `SandboxManager` 构造函数注入 `SandboxProbe`、`SandboxMonitor`、`ImageManager`
- [ ] `wrapCommand()` 自动启动 monitor
- [ ] `execute()` 完成后自动停止 monitor 并收集指标
- [ ] Probe 结果缓存（同一 session 内不重复检测）
- [ ] 更新 `src/bootstrap/config.ts` 新增 sandbox.monitor/sandbox.probe 配置
- [ ] 更新 `src/executors/toolExecutor.ts` 传递 monitor 指标到 tool result
- [ ] 编写 `test/integration/sandbox-full.test.ts`：完整沙箱流程测试

**Spec Documentation**: [§2.1 沙箱系统深化](docs/v3-improvement-spec.md#21-沙箱系统深化p0)

---

### TASK-025: LSP DocumentManager 实现

**Status**: pending
**Priority**: P1
**Phase**: Phase 1
**预估工时**: 2d

**任务描述**:
- Imperative: Implement DocumentManager for reliable LSP document synchronization
- Present Continuous: Implementing DocumentManager for reliable LSP document synchronization

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-027, TASK-028, TASK-029, TASK-030]

**Checklist**:
- [ ] 创建 `src/lsp/document-manager.ts`：`DocumentManager` 类
- [ ] 实现 `ManagedDocument` 接口（uri, languageId, version, content, isOpen, lastSyncedAt）
- [ ] `open()` — 发送 `textDocument/didOpen` 通知
- [ ] `update()` — 增量同步（计算 diff，发送 `textDocument/didChange`）
- [ ] `close()` — 发送 `textDocument/didClose` 通知
- [ ] `get()` — 获取文档当前状态
- [ ] 实现增量变更计算（最小 diff → TextDocumentContentChangeEvent）
- [ ] 重构 `src/lsp/client.ts` 使用 DocumentManager 替代直接 didOpen
- [ ] 重构 `src/lsp/diagnostics.ts` 使用 DocumentManager
- [ ] 移除 `getDiagnostics()` 中的 `setTimeout(500)` 不可靠等待
- [ ] 改用 `textDocument/publishDiagnostics` 通知监听 + Promise 超时
- [ ] 编写 `test/lsp/document-manager.test.ts`
- [ ] 编写 `test/lsp/diagnostics-reliable.test.ts`

**Spec Documentation**: [§2.4.1 DocumentManager](docs/v3-improvement-spec.md#241-documentmanager文档同步)

---

### TASK-026: 精确 Token 估算

**Status**: pending
**Priority**: P1
**Phase**: Phase 1
**预估工时**: 1d

**任务描述**:
- Imperative: Replace character-based token estimation with precise tiktoken encoding
- Present Continuous: Replacing character-based token estimation with precise tiktoken encoding

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 重写 `src/utils/tokenEstimation.ts`：`TokenCounter` 类
- [ ] 使用 `js-tiktoken` 的 `encoding_for_model()` 获取编码器
- [ ] 支持按 provider/model 自动选择编码器（cl100k, o200k, custom）
- [ ] 实现 LRU 缓存（避免重复编码相同文本）
- [ ] 提供 `count(text)` 和 `countMessages(messages)` 方法
- [ ] `QueryEngine` 使用 `TokenCounter` 替代字符估算
- [ ] 编写 `test/utils/tokenEstimation.test.ts`：对比估算 vs 精确编码，验证误差 <5%
- [ ] 性能验证：编码延迟 <10ms/1000 字符

**Spec Documentation**: [§2.3.4 精确 Token 估算](docs/v3-improvement-spec.md#234-精确-token-估算)

---

## Phase 2: 模型适配 + LSP 增强（Week 3-4）

### TASK-027: Provider 能力探测系统

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Implement provider capability detection system
- Present Continuous: Implementing provider capability detection system

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-028, TASK-029]

**Checklist**:
- [ ] 创建 `src/api/capabilities.ts`：`ProviderCapabilities` 接口
- [ ] 定义能力维度：maxContextWindow, maxOutputTokens, supportsToolUse, supportsParallelToolCalls, supportsThinking, supportsStructuredOutput, tokenEncoding, recommendedTemperature, recommendedMaxTools
- [ ] 创建 `PROVIDER_CAPABILITIES` 常量表（6 个 provider）
- [ ] 实现 `getCapabilities(provider, model?)` 函数
- [ ] 支持 model 级别覆盖（如 claude-opus vs claude-haiku 能力不同）
- [ ] `BaseApiClient` 构造函数注入 `ProviderCapabilities`
- [ ] `createAPIClient()` 传递 capabilities
- [ ] 编写 `test/api/capabilities.test.ts`

**Spec Documentation**: [§2.3.1 Provider 能力探测](docs/v3-improvement-spec.md#231-provider-能力探测)

---

### TASK-028: Provider 特化 Prompt 系统

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Implement provider-specific prompt templates with layered composition
- Present Continuous: Implementing provider-specific prompt templates with layered composition

**Dependencies**:
- `blockedBy`: [TASK-027]
- `blocks`: [TASK-029]

**Checklist**:
- [ ] 创建 `src/api/prompts/types.ts`：`PromptTemplate` 接口
- [ ] 创建 `src/api/prompts/provider-prompts.ts`：6 个 provider 的 prompt 模板
  - [ ] Anthropic：利用 `<thinking>` 标签、强调类型安全
  - [ ] OpenAI：强调逐步推理、结构化输出
  - [ ] DeepSeek：中文优化、代码生成特化
  - [ ] Qwen：中文优化、工具使用指导
  - [ ] GLM：中文优化、安全约束
  - [ ] Ollama：简洁指令、资源感知
- [ ] 创建 `src/api/prompts/task-prompts.ts`：任务类型 prompt（code-gen, debugging, refactoring, documentation）
- [ ] 创建 `src/api/prompts/prompt-builder.ts`：`PromptBuilder` 类
  - [ ] `buildSystemPrompt(tools, context)` — 组合 base + provider + task prompt
  - [ ] 根据 `ProviderCapabilities` 注入能力相关指令
  - [ ] 根据工具列表格式化工具使用说明
- [ ] `QueryEngine` 使用 `PromptBuilder` 替代硬编码 system prompt
- [ ] 编写 `test/api/prompts/prompt-builder.test.ts`
- [ ] 编写 `test/api/prompts/provider-prompts.test.ts`

**Spec Documentation**: [§2.3.2 Provider 特化 Prompt 系统](docs/v3-improvement-spec.md#232-provider-特化-prompt-系统)

---

### TASK-029: 动态参数调优

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Implement dynamic parameter tuning based on provider capabilities and task type
- Present Continuous: Implementing dynamic parameter tuning based on provider capabilities and task type

**Dependencies**:
- `blockedBy`: [TASK-027, TASK-028]
- `blocks`: []

**Checklist**:
- [ ] 创建 `src/api/param-tuner.ts`：`ParamTuner` 类
- [ ] 实现 `TunedParams` 接口（max_tokens, temperature, top_p, tool_choice, parallel_tool_calls）
- [ ] `tune(capabilities, taskType, conversationLength, availableTokens)` 方法
- [ ] 代码生成任务：低温度（0.1-0.2）
- [ ] 创意任务：稍高温度（0.7-0.9）
- [ ] 根据 `supportsParallelToolCalls` 决定是否并行
- [ ] 根据 `maxOutputTokens` 和 availableTokens 计算最优 max_tokens
- [ ] `QueryEngine` 使用 `ParamTuner` 动态生成 API 参数
- [ ] 编写 `test/api/param-tuner.test.ts`

**Spec Documentation**: [§2.3.3 动态参数调优](docs/v3-improvement-spec.md#233-动态参数调优)

---

### TASK-030: LSP 补全服务

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Implement LSP completion provider and expose as tool action
- Present Continuous: Implementing LSP completion provider and exposing as tool action

**Dependencies**:
- `blockedBy`: [TASK-025]
- `blocks`: [TASK-033]

**Checklist**:
- [ ] 创建 `src/lsp/completion.ts`：`CompletionProvider` 类
- [ ] 实现 `textDocument/completion` 请求
- [ ] 支持 `CompletionItemKind` 分类（Function, Variable, Class, Module 等）
- [ ] 补全结果按 `sortText` 排序
- [ ] 支持 `completionItem/resolve` 获取详细信息（documentation, detail）
- [ ] 限制返回数量（前 20 个，可配置）
- [ ] 更新 `src/lsp/tool.ts` 新增 `completion` action
- [ ] 更新 `src/lsp/types.ts` 新增 CompletionItemKind 等类型
- [ ] 编写 `test/lsp/completion.test.ts`

**Spec Documentation**: [§2.4.2 LSP 补全服务](docs/v3-improvement-spec.md#242-lsp-补全服务)

---

### TASK-031: LSP 引用查找与重命名

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Implement LSP references, rename, and workspace symbol search
- Present Continuous: Implementing LSP references, rename, and workspace symbol search

**Dependencies**:
- `blockedBy`: [TASK-025]
- `blocks`: [TASK-033]

**Checklist**:
- [ ] 创建 `src/lsp/navigation.ts`：`NavigationProvider` 类
- [ ] 实现 `textDocument/references` — 查找所有引用位置
- [ ] 实现 `textDocument/rename` — 安全重命名（返回 WorkspaceEdit）
- [ ] 实现 `workspace/symbol` — 全局符号搜索
- [ ] `applyWorkspaceEdit()` — 应用编辑到文件系统
- [ ] 更新 `src/lsp/tool.ts` 新增 `references`/`rename`/`symbol` actions
- [ ] 更新 `src/lsp/types.ts` 新增 WorkspaceEdit、SymbolInformation、TextEdit
- [ ] 编写 `test/lsp/navigation.test.ts`

**Spec Documentation**: [§2.4.3 引用查找与重命名](docs/v3-improvement-spec.md#243-引用查找与重命名)

---

### TASK-032: LSP 代码操作

**Status**: pending
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Implement LSP code actions (quick fixes, organize imports)
- Present Continuous: Implementing LSP code actions (quick fixes, organize imports)

**Dependencies**:
- `blockedBy`: [TASK-025]
- `blocks`: [TASK-033]

**Checklist**:
- [ ] 创建 `src/lsp/code-actions.ts`：`CodeActionProvider` 类
- [ ] 实现 `textDocument/codeAction` 请求
- [ ] 支持 `CodeActionKind.QuickFix`（添加 import、修复拼写）
- [ ] 支持 `CodeActionKind.SourceOrganizeImports`（整理 import）
- [ ] `applyCodeAction()` — 应用 code action（处理 edit 和 command）
- [ ] 更新 `src/lsp/tool.ts` 新增 `codeAction` action
- [ ] 编写 `test/lsp/code-actions.test.ts`

**Spec Documentation**: [§2.4.4 代码操作](docs/v3-improvement-spec.md#244-代码操作code-actions)

---

### TASK-033: 扩展语言支持

**Status**: pending
**Priority**: P2
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Add Java, C/C++, Ruby language server support
- Present Continuous: Adding Java, C/C++, Ruby language server support

**Dependencies**:
- `blockedBy`: [TASK-030, TASK-031, TASK-032]
- `blocks`: []

**Checklist**:
- [ ] 创建 `src/lsp/language-registry.ts`：`LanguageServerConfig` 接口和注册表
- [ ] 添加 Java (jdtls) 配置
- [ ] 添加 C/C++ (clangd) 配置
- [ ] 添加 Ruby (solargraph) 配置
- [ ] 每种语言声明支持的能力（completion, hover, definition, references, rename, codeAction）
- [ ] `LSPClientManager` 使用 `language-registry` 替代硬编码语言表
- [ ] 语言服务器自动发现（检查命令是否在 PATH 中）
- [ ] 编写 `test/lsp/language-registry.test.ts`

**Spec Documentation**: [§2.4.5 扩展语言支持](docs/v3-improvement-spec.md#245-扩展语言支持)

---

## Phase 3: UI 提升（Week 5-6）

### TASK-034: 主题系统

**Status**: pending
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Implement configurable theme system for terminal UI
- Present Continuous: Implementing configurable theme system for terminal UI

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-037]

**Checklist**:
- [ ] 创建 `src/ui/theme.ts`：`Theme` 接口和内置主题
- [ ] 定义颜色维度：primary, secondary, success, warning, error, muted, border, highlight
- [ ] 定义语法高亮颜色：keyword, string, number, comment, function
- [ ] 定义 diff 颜色：added, removed, context
- [ ] 内置主题：dark, light, solarized-dark, monokai, dracula
- [ ] 实现 `getTheme(name)` 和 `resolveColor(theme, path)` 工具函数
- [ ] 迁移 `src/ui/components/App.ts` 使用主题颜色
- [ ] 迁移 `src/ui/components/Sidebar.ts` 使用主题颜色
- [ ] 迁移 `src/ui/components/CommandPalette.ts` 使用主题颜色
- [ ] 迁移 `src/ui/diff-viewer.ts` 使用主题颜色
- [ ] `src/bootstrap/config.ts` 新增 `ui.theme` 配置项
- [ ] 编写 `test/ui/theme.test.ts`

**Spec Documentation**: [§2.2.1 主题系统](docs/v3-improvement-spec.md#221-主题系统)

---

### TASK-035: 虚拟滚动

**Status**: pending
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Implement virtual scrolling for long conversations
- Present Continuous: Implementing virtual scrolling for long conversations

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-037]

**Checklist**:
- [ ] 创建 `src/ui/virtual-scroll.ts`：`VirtualScroller` 类
- [ ] 实现 `getVisibleRange()` — 根据滚动偏移计算可见区域
- [ ] 实现 `render()` — 仅渲染可见消息 + 顶部/底部占位符
- [ ] 支持 `scrollUp(lines)` / `scrollDown(lines)` / `scrollToBottom()`
- [ ] 缓存消息高度（避免重复计算）
- [ ] 支持动态高度（不同消息类型高度不同）
- [ ] `App.ts` 集成 VirtualScroller（>50 条消息时启用）
- [ ] 快捷键：PageUp/PageDown 滚动，Ctrl+End 跳到底部
- [ ] 编写 `test/ui/virtual-scroll.test.ts`

**Spec Documentation**: [§2.2.2 虚拟滚动](docs/v3-improvement-spec.md#222-虚拟滚动)

---

### TASK-036: 鼠标支持

**Status**: pending
**Priority**: P2
**Phase**: Phase 3
**预估工时**: 1d

**任务描述**:
- Imperative: Add mouse event support for terminal UI interactions
- Present Continuous: Adding mouse event support for terminal UI interactions

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-037]

**Checklist**:
- [ ] 创建 `src/ui/mouse.ts`：`MouseHandler` 类
- [ ] `enable()` — 输出 `\x1b[?1000h` / `\x1b[?1002h` / `\x1b[?1006h`
- [ ] `disable()` — 输出 `\x1b[?1000l`
- [ ] `parseEvent(data)` — 解析 SGR 鼠标事件序列
- [ ] 点击 Sidebar tab → 切换 section
- [ ] 点击消息 → 选中
- [ ] 点击输入框 → 聚焦
- [ ] 滚轮 → 虚拟滚动
- [ ] `App.ts` 集成 MouseHandler
- [ ] 编写 `test/ui/mouse.test.ts`

**Spec Documentation**: [§2.2.3 鼠标支持](docs/v3-improvement-spec.md#223-鼠标支持)

---

### TASK-037: UI 集成与性能测试

**Status**: pending
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Integrate theme, virtual scroll, and mouse support with performance testing
- Present Continuous: Integrating theme, virtual scroll, and mouse support with performance testing

**Dependencies**:
- `blockedBy`: [TASK-034, TASK-035, TASK-036]
- `blocks`: []

**Checklist**:
- [ ] `App.ts` 完整集成主题 + 虚拟滚动 + 鼠标
- [ ] 流式输出节流 16ms/帧（避免过度渲染）
- [ ] 响应式布局：窄终端（<80 列）自动折叠侧栏
- [ ] 性能基准：1000 消息渲染 <100ms
- [ ] 内存测试：100+ 轮对话内存增长 <50MB
- [ ] 编写 `test/ui/app-integration.test.ts`
- [ ] 编写 `test/benchmarks/ui-render.bench.ts`

**Spec Documentation**: [§2.2 UI 成熟度提升](docs/v3-improvement-spec.md#22-ui-成熟度提升p1)

---

### TASK-038: Windows 沙箱支持

**Status**: pending
**Priority**: P2
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Add Windows Sandbox (WSB) backend for Windows users
- Present Continuous: Adding Windows Sandbox (WSB) backend for Windows users

**Dependencies**:
- `blockedBy`: []
- `blocks`: []

**Checklist**:
- [ ] 创建 `src/services/sandbox-windows.ts`：`WindowsSandbox` 类
- [ ] `isAvailable()` — 检查 Windows Sandbox 功能是否启用
- [ ] `wrapCommand()` — 生成 `.wsb` 配置文件 + 启动命令
- [ ] 支持网络隔离（`<Networking>Disable</Networking>`）
- [ ] 支持文件夹映射（`<MappedFolders>`）
- [ ] 支持内存限制（`<MemoryInMB>`）
- [ ] `SandboxManager` 注册 windows-sandbox 后端
- [ ] 更新 fallback 链：bubblewrap → seccomp → docker → windows-sandbox → noop
- [ ] 编写 `test/services/sandbox-windows.test.ts`

**Spec Documentation**: [§2.1.4 Windows 沙箱支持](docs/v3-improvement-spec.md#214-windows-沙箱支持)

---

## Phase 4: 测试覆盖与质量（Week 7-8）

### TASK-039: Mock LLM 测试基础设施

**Status**: pending
**Priority**: P0
**Phase**: Phase 4
**预估工时**: 1d

**任务描述**:
- Imperative: Create MockLLMClient and test fixtures for reliable testing
- Present Continuous: Creating MockLLMClient and test fixtures for reliable testing

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-041, TASK-042]

**Checklist**:
- [ ] 创建 `test/utils/mock-llm.ts`：`MockLLMClient` 类
- [ ] 继承 `BaseApiClient`，实现 `chat()` 和 `streamChat()`
- [ ] `setResponses(responses)` — 预设响应序列
- [ ] `addErrorScenario(scenario, error)` — 错误注入
- [ ] 工厂方法：`withToolCallResponse()`, `withTextResponse()`, `withMultiTurnResponse()`, `withError()`
- [ ] 创建 `test/utils/fixtures.ts`：预定义测试场景
  - [ ] 安全命令列表（ls, cat, echo, pwd...）
  - [ ] 危险命令列表（rm -rf, curl, sudo, chmod 777...）
  - [ ] 测试用文件结构（临时目录 + 示例文件）
  - [ ] 常见 tool result 格式
- [ ] 创建 `test/utils/test-helpers.ts`：通用测试辅助函数
  - [ ] `createTempDir()` / `cleanTempDir()`
  - [ ] `createMockConfig()`
  - [ ] `waitForEvent(emitter, event, timeout)`

**Spec Documentation**: [§2.5.2 Mock LLM 测试基础设施](docs/v3-improvement-spec.md#252-mock-llm-测试基础设施)

---

### TASK-040: 权限系统完整测试

**Status**: pending
**Priority**: P0
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Write comprehensive tests for permission engine, rules, and interaction
- Present Continuous: Writing comprehensive tests for permission engine, rules, and interaction

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-043]

**Checklist**:
- [ ] 扩展 `test/permissions/engine.test.ts`：覆盖全部 6 步决策流
  - [ ] Step 1: deny 规则优先匹配
  - [ ] Step 2: 工具级权限检查
  - [ ] Step 3: 安全关键检查（bypass 免疫）
  - [ ] Step 4: bypass 模式行为
  - [ ] Step 5: allow 规则匹配
  - [ ] Step 6: 模式默认行为
- [ ] 扩展 `test/permissions/rules.test.ts`：
  - [ ] 通配符 `*` 匹配
  - [ ] 前缀匹配 `Bash:rm:*`
  - [ ] 大小写不敏感
  - [ ] 边界条件（空规则、无效规则、特殊字符）
- [ ] 新建 `test/permissions/interaction.test.ts`：
  - [ ] 用户允许操作
  - [ ] 用户拒绝操作
  - [ ] 用户选择 "记住选择"
  - [ ] 超时处理
  - [ ] 非交互模式行为
- [ ] 新建 `test/utils/path.test.ts`：
  - [ ] 路径遍历攻击检测（`../../etc/passwd`）
  - [ ] 符号链接解析
  - [ ] Unicode 规范化
  - [ ] 受保护路径匹配（`.ssh`, `.env`, `.git/config`）
  - [ ] `~` 展开

**Spec Documentation**: [§2.5.1 测试覆盖目标](docs/v3-improvement-spec.md#251-测试覆盖目标)

---

### TASK-041: QueryEngine 深度测试

**Status**: pending
**Priority**: P0
**Phase**: Phase 4
**预估工时**: 3d

**任务描述**:
- Imperative: Expand QueryEngine test coverage from 9.34% to 70%+
- Present Continuous: Expanding QueryEngine test coverage from 9.34% to 70%+

**Dependencies**:
- `blockedBy`: [TASK-039]
- `blocks`: [TASK-043]

**Checklist**:
- [ ] 重写 `test/QueryEngine.test.ts` 使用 MockLLMClient
- [ ] 状态机循环完整覆盖：
  - [ ] idle → compact（micro-compact 触发）
  - [ ] compact → stream（API 调用）
  - [ ] stream → decide（工具调用决策）
  - [ ] decide → execute（工具执行）
  - [ ] execute → compact（循环）
- [ ] 边界场景：
  - [ ] 超过 maxMessages → 消息截断
  - [ ] 超过 maxBudgetUsd → 预算耗尽停止
  - [ ] 工具权限拒绝 → 跳过执行
  - [ ] API 速率限制 → 指数退避重试
  - [ ] compaction 失败 → 降级处理
  - [ ] abort 信号 → 立即停止
  - [ ] 空工具列表 → 纯文本对话模式
- [ ] 流式输出事件验证
- [ ] 工具调用结果传递
- [ ] 记忆加载集成
- [ ] 新建 `test/query/streaming.test.ts`：流式输出专项测试
- [ ] 新建 `test/query/compaction.test.ts`：compaction 专项测试
- [ ] 新建 `test/query/error-recovery.test.ts`：错误恢复专项测试

**Spec Documentation**: [§2.5.3 QueryEngine 深度测试](docs/v3-improvement-spec.md#253-queryengine-深度测试)

---

### TASK-042: API Client 测试扩展

**Status**: pending
**Priority**: P1
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Expand API client test coverage for all providers
- Present Continuous: Expanding API client test coverage for all providers

**Dependencies**:
- `blockedBy`: [TASK-039]
- `blocks`: [TASK-043]

**Checklist**:
- [ ] 扩展 `test/api/BaseApiClient.test.ts`：
  - [ ] 流式响应解析（SSE 格式）
  - [ ] 错误分类和重试逻辑
  - [ ] 消息格式化（system/user/assistant/tool）
  - [ ] 工具定义格式化
- [ ] 新建 `test/api/AnthropicClient.test.ts`：
  - [ ] Anthropic 消息格式
  - [ ] thinking blocks 解析
  - [ ] tool_use 解析
  - [ ] prompt caching
- [ ] 新建 `test/api/OpenAICompatibleClient.test.ts`：
  - [ ] OpenAI 消息格式
  - [ ] 多 provider 适配（DeepSeek/Qwen/GLM）
  - [ ] 流式 tool_calls 解析
- [ ] 新建 `test/api/OllamaClient.test.ts`：
  - [ ] NDJSON 流式解析
  - [ ] 无 API key 模式

**Spec Documentation**: [§2.5.1 测试覆盖目标](docs/v3-improvement-spec.md#251-测试覆盖目标)

---

### TASK-043: CI 门禁与性能基准

**Status**: pending
**Priority**: P1
**Phase**: Phase 4
**预估工时**: 1d

**任务描述**:
- Imperative: Set up CI coverage gates and performance benchmarks
- Present Continuous: Setting up CI coverage gates and performance benchmarks

**Dependencies**:
- `blockedBy`: [TASK-040, TASK-041, TASK-042]
- `blocks`: [TASK-044]

**Checklist**:
- [ ] 更新 `vitest.config.ts` 覆盖率阈值：statements 55, branches 45, functions 60, lines 55
- [ ] 添加 `test:ci` 脚本到 `package.json`：`vitest run --coverage --reporter=junit`
- [ ] 更新 `.github/workflows/ci.yml`：
  - [ ] 添加覆盖率检查步骤
  - [ ] 覆盖率低于阈值时 PR 标记为 blocked
  - [ ] 覆盖率报告上传到 CI artifacts
- [ ] 创建 `test/benchmarks/` 目录：
  - [ ] `startup.bench.ts` — 冷启动性能
  - [ ] `token-counting.bench.ts` — Token 计算性能
  - [ ] `ui-render.bench.ts` — UI 渲染性能
- [ ] 添加 `test:bench` 脚本到 `package.json`

**Spec Documentation**: [§2.5.4 CI 门禁强化](docs/v3-improvement-spec.md#254-ci-门禁强化)

---

### TASK-044: v3.0 集成测试与发布准备

**Status**: pending
**Priority**: P2
**Phase**: Phase 4
**预估工时**: 2d

**任务描述**:
- Imperative: Write integration tests and prepare v3.0 release documentation
- Present Continuous: Writing integration tests and preparing v3.0 release documentation

**Dependencies**:
- `blockedBy`: [TASK-043]
- `blocks`: []

**Checklist**:
- [ ] `test/integration/sandbox-full.test.ts`：完整沙箱流程（probe + monitor + execute）
- [ ] `test/integration/lsp-full.test.ts`：完整 LSP 流程（open + completion + diagnostics + rename）
- [ ] `test/integration/model-adaptation.test.ts`：模型适配流程（capabilities + prompt + tune）
- [ ] 更新 `README.md` 添加 v3 新特性说明
- [ ] 创建 `docs/v3-changelog.md`：v3 变更日志
- [ ] 更新 `docs/architecture.md` 反映新架构
- [ ] 更新 `package.json` version 到 `3.0.0`
- [ ] 运行 `npm run test:ci` 确认所有测试通过
- [ ] 运行 `npm run typecheck` 确认类型检查通过
- [ ] 运行 `npm run build` 确认构建成功

**Spec Documentation**: [§三 实施路线图](docs/v3-improvement-spec.md#三实施路线图)

---

## 任务依赖图

```
TASK-021 (沙箱探针) ──┬──→ TASK-024 (沙箱集成) ──┐
TASK-022 (沙箱监控) ──┤                           │
TASK-023 (镜像管理) ──┘                           │
                                                   ├──→ TASK-044 (集成+发布)
TASK-025 (DocumentManager) ─┬→ TASK-030 (补全) ──┤
                            ├→ TASK-031 (引用) ──┤
                            └→ TASK-032 (代码操作)─┤
                                                   │
TASK-027 (能力探测) ──┬→ TASK-028 (Prompt) ──┐    │
                      └→ TASK-029 (参数调优) ─┤    │
                                              │    │
TASK-034 (主题) ──────┬→ TASK-037 (UI集成) ──┤    │
TASK-035 (虚拟滚动) ──┤                       │    │
TASK-036 (鼠标支持) ──┘                       │    │
                                              │    │
TASK-038 (Windows沙箱) ──────────────────────┤    │
                                              │    │
TASK-026 (Token估算) ────────────────────────┤    │
                                              │    │
TASK-033 (扩展语言) ─────────────────────────┤    │
                                              │    │
TASK-039 (MockLLM) ──┬→ TASK-041 (QE测试) ──┤    │
TASK-040 (权限测试) ─┼→ TASK-043 (CI门禁) ──┘    │
TASK-042 (API测试) ──┘                             │
                                                   │
TASK-044 (集成+发布) ←─────────────────────────────┘
```

---

## 状态追踪

| Status | Count | Tasks |
|--------|-------|-------|
| ✅ completed | 0 | — |
| 🔄 in_progress | 0 | — |
| ⏳ pending | 24 | TASK-021 ~ TASK-044 |
| 🚫 blocked | 0 | — |

---

## 工时估算汇总

| Phase | 任务数 | 预估工时 | 关键路径 |
|-------|--------|----------|----------|
| Phase 1: 沙箱+LSP基础 | 6 | 10d | TASK-021→024, TASK-025 |
| Phase 2: 模型+LSP增强 | 7 | 10d | TASK-027→028→029, TASK-025→030/031/032 |
| Phase 3: UI提升 | 5 | 9d | TASK-034/035/036→037 |
| Phase 4: 测试+质量 | 6 | 11d | TASK-039→041→043→044 |
| **总计** | **24** | **40d** | ~8 周（1 人） |
