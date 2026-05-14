# KC-CLI v3 Task Breakdown

> **项目**: KC-CLI v3 改进
> **版本**: 2.0
> **创建日期**: 2026-05-13
> **更新日期**: 2026-05-14
> **关联 Spec**: [docs/v3-improvement-spec.md](docs/v3-improvement-spec.md)
> **前置依赖**: v2.0.0（已发布，TASK-001 ~ TASK-020 全部完成）

---

## 已在 v2 中完成的任务（不再重复）

以下任务在 v2 Phase 2.5 和 Phase 3 中已实现，v3 不再包含：

| 原任务 | v2 实现 | 文件 |
|--------|---------|------|
| DocumentManager | v2 TASK-011 | `src/lsp/document-manager.ts` |
| LSP 补全 | v2 TASK-012 | `src/lsp/completion.ts` |
| 引用/重命名/代码操作 | v2 TASK-013 | `src/lsp/navigation.ts`, `code-actions.ts` |
| Provider 能力探测 | v2 TASK-014 | `src/api/capabilities.ts` |
| Provider 特化 Prompt | v2 TASK-014 | `src/api/prompts/provider-prompts.ts`, `task-prompts.ts`, `prompt-builder.ts` |
| 动态参数调优 | v2 TASK-014 | `src/api/param-tuner.ts` |
| 精确 Token 估算 | v2 TASK-015 | `src/utils/tokenEstimation.ts` |
| 权限系统测试 | v2 TASK-016 | `test/permissions/`, `test/utils/path.test.ts` |
| QueryEngine 测试 | v2 TASK-017 | `test/QueryEngine.test.ts` |
| 测试基础设施 + CI | v2 TASK-018 | `test/utils/mock-llm.ts`, `vitest.config.ts`, `.github/workflows/ci.yml` |

---

## Phase 1: 沙箱深化（Week 1-2）

### TASK-021: 沙箱逃逸检测探针

**Status**: completed
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
- [x] 创建 `src/services/sandbox-probe.ts`：`SandboxProbe` 类
- [x] 实现 `ProbeResult` 接口（passed, total, failures, duration）
- [x] 实现文件系统隔离测试（尝试读取 /etc/shadow，应失败）
- [x] 实现网络隔离测试（尝试 curl 外部地址，应失败）
- [x] 实现进程隔离测试（尝试 kill 宿主进程，应失败）
- [x] 实现权限提升测试（尝试 sudo，应失败）
- [x] 在 `SandboxManager` 启动时自动运行 probe（可配置关闭）
- [x] Probe 结果输出到 verbose 日志
- [x] Probe 结果缓存（同一 session 内不重复检测）
- [x] 编写 `test/services/sandbox-probe.test.ts`

**Spec Documentation**: [§2.1.1 沙箱逃逸检测](docs/v3-improvement-spec.md#211-沙箱逃逸检测)

---

### TASK-022: 沙箱运行时资源监控

**Status**: completed
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
- [x] 创建 `src/services/sandbox-monitor.ts`：`SandboxMonitor` 类
- [x] 实现 `SandboxMetrics` 接口（memoryUsageMb, cpuPercent, wallTimeMs, networkBytes）
- [x] Docker 后端：通过 `docker stats --no-stream` 采集指标
- [x] Bubblewrap 后端：通过 `/proc/[pid]/stat` 采集指标
- [x] 超阈值自动终止（memory > maxMemoryMb * 1.1 或 cpu > 95%）
- [x] 指标输出到 tool result metadata
- [x] 编写 `test/services/sandbox-monitor.test.ts`

**Spec Documentation**: [§2.1.2 运行时资源监控](docs/v3-improvement-spec.md#212-运行时资源监控)

---

### TASK-023: Docker 镜像管理

**Status**: completed
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
- [x] 创建 `src/services/sandbox-images.ts`：`ImageManager` 类
- [x] `ensureImage(image)` — 检查镜像是否存在，不存在则拉取（带进度回调）
- [x] `listCachedImages()` — 列出已缓存的沙箱镜像
- [x] `pruneUnused()` — 清理未使用的沙箱镜像
- [x] 支持项目级自定义 Dockerfile（`.kc-cli/Dockerfile.sandbox`）
- [x] `DockerSandbox` 使用 `ImageManager.ensureImage()` 替代硬编码镜像
- [x] 创建 `.kc-cli/Dockerfile.sandbox` 示例文件
- [x] 编写 `test/services/sandbox-images.test.ts`

**Spec Documentation**: [§2.1.3 Docker 镜像管理](docs/v3-improvement-spec.md#213-docker-镜像管理)

---

### TASK-024: 沙箱系统集成与测试

**Status**: completed
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
- [x] `SandboxManager` 构造函数注入 `SandboxProbe`、`SandboxMonitor`、`ImageManager`
- [x] `wrapCommand()` 自动启动 monitor
- [x] `execute()` 完成后自动停止 monitor 并收集指标
- [x] 更新 `src/bootstrap/config.ts` 新增 sandbox.monitor/sandbox.probe 配置
- [x] 更新 `src/executors/toolExecutor.ts` 传递 monitor 指标到 tool result
- [x] 编写 `test/integration/sandbox-full.test.ts`：完整沙箱流程测试

**Spec Documentation**: [§2.1 沙箱系统深化](docs/v3-improvement-spec.md#21-沙箱系统深化p0)

---

## Phase 2: UI 提升 + 语言扩展（Week 3-4）

### TASK-025: 主题系统

**Status**: completed
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Implement configurable theme system for terminal UI
- Present Continuous: Implementing configurable theme system for terminal UI

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-028]

**Checklist**:
- [x] 重写 `src/ui/theme.ts`：`Theme` 接口和内置主题（当前文件仅 chalk namespace 声明）
- [x] 定义颜色维度：primary, secondary, success, warning, error, muted, border, highlight
- [x] 定义语法高亮颜色：keyword, string, number, comment, function
- [x] 定义 diff 颜色：added, removed, context
- [x] 内置主题：dark, light, solarized-dark, monokai, dracula
- [x] 实现 `getTheme(name)` 和 `resolveColor(theme, path)` 工具函数
- [x] 迁移 `App.ts`、`Sidebar.ts`、`CommandPalette.ts`、`diff-viewer.ts` 使用主题颜色
- [x] `config.ts` 新增 `ui.theme` 配置项
- [x] 编写 `test/ui/theme.test.ts`

**Spec Documentation**: [§2.2.1 主题系统](docs/v3-improvement-spec.md#221-主题系统)

---

### TASK-026: 鼠标支持

**Status**: completed
**Priority**: P2
**Phase**: Phase 2
**预估工时**: 1d

**任务描述**:
- Imperative: Add mouse event support for terminal UI interactions
- Present Continuous: Adding mouse event support for terminal UI interactions

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-028]

**Checklist**:
- [x] 创建 `src/ui/mouse.ts`：`MouseHandler` 类
- [x] `enable()` — 输出 `\x1b[?1000h` / `\x1b[?1002h` / `\x1b[?1006h`
- [x] `disable()` — 输出 `\x1b[?1000l`
- [x] `parseEvent(data)` — 解析 SGR 鼠标事件序列
- [x] 点击 Sidebar tab → 切换 section
- [x] 点击消息 → 选中
- [x] 点击输入框 → 聚焦
- [x] 滚轮 → 虚拟滚动
- [x] `App.ts` 集成 MouseHandler
- [x] 编写 `test/ui/mouse.test.ts`

**Spec Documentation**: [§2.2.2 鼠标支持](docs/v3-improvement-spec.md#222-鼠标支持)

---

### TASK-027: 多面板布局增强

**Status**: completed
**Priority**: P1
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Implement configurable panel layout system with resize and mode switching
- Present Continuous: Implementing configurable panel layout system with resize and mode switching

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-028]

**Checklist**:
- [x] 创建 `src/ui/layout.ts`：`LayoutManager` 类
- [x] 实现 `LayoutMode` 类型（sidebar-main / main-only / main-bottom / three-column）
- [x] 实现 `PanelConfig` 接口（id, width, minWidth, maxWidth, visible, position）
- [x] `setMode(mode)` — 切换布局模式
- [x] `resizePanel(id, delta)` — 调整面板大小
- [x] `togglePanel(id)` — 显示/隐藏面板
- [x] `calculateDimensions(terminalWidth, terminalHeight)` — 响应式计算
- [x] 窄终端（<80 列）自动折叠侧栏
- [x] 创建 `src/ui/components/Panel.ts`：通用面板容器
- [x] `App.ts` 使用 `LayoutManager` 替代硬编码布局
- [x] 编写 `test/ui/layout.test.ts`

**Spec Documentation**: [§2.2.3 多面板布局增强](docs/v3-improvement-spec.md#223-多面板布局增强)

---

### TASK-028: 扩展语言支持

**Status**: completed
**Priority**: P2
**Phase**: Phase 2
**预估工时**: 2d

**任务描述**:
- Imperative: Add Java, C/C++, Ruby language server support via registry
- Present Continuous: Adding Java, C/C++, Ruby language server support via registry

**Dependencies**:
- `blockedBy`: [TASK-025, TASK-026, TASK-027]
- `blocks`: []

**Checklist**:
- [x] 创建 `src/lsp/language-registry.ts`：`LanguageServerConfig` 接口和注册表
- [x] 添加 Java (jdtls) 配置
- [x] 添加 C/C++ (clangd) 配置
- [x] 添加 Ruby (solargraph) 配置
- [x] 每种语言声明支持的能力（completion, hover, definition, references, rename, codeAction）
- [x] `LSPClientManager` 使用 `language-registry` 替代硬编码语言表
- [x] 语言服务器自动发现（检查命令是否在 PATH 中）
- [x] 编写 `test/lsp/language-registry.test.ts`

**Spec Documentation**: [§2.3 扩展语言支持](docs/v3-improvement-spec.md#23-扩展语言支持p2)

---

## Phase 3: 测试强化 + 发布（Week 5-6）

### TASK-029: API Client 测试扩展

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Add comprehensive tests for Anthropic, OpenAI, and Ollama API clients
- Present Continuous: Adding comprehensive tests for Anthropic, OpenAI, and Ollama API clients

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-032]

**Checklist**:
- [x] 新建 `test/api/AnthropicClient.test.ts`：流式解析、错误分类、消息格式化
- [x] 新建 `test/api/OpenAICompatibleClient.test.ts`：多 provider 复用、tool_calls 解析
- [x] 新建 `test/api/OllamaClient.test.ts`：本地模型通信、超时处理
- [x] 使用 MockHTTP（vi.fn() mock fetch）避免真实 API 调用
- [x] 覆盖错误场景：rate limit、auth error、network timeout、malformed response
- [x] 覆盖流式场景：partial chunks、SSE 解析、tool call delta

**Spec Documentation**: [§2.4.1 API Client 测试](docs/v3-improvement-spec.md#241-api-client-测试)

---

### TASK-030: UI 集成与性能测试

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Integrate theme, mouse, and layout systems with performance testing
- Present Continuous: Integrating theme, mouse, and layout systems with performance testing

**Dependencies**:
- `blockedBy`: [TASK-025, TASK-026, TASK-027]
- `blocks`: [TASK-032]

**Checklist**:
- [x] `App.ts` 完整集成主题 + 鼠标 + 布局管理器
- [x] 流式输出节流 16ms/帧（避免过度渲染）
- [x] 性能基准：1000 消息渲染 <100ms
- [x] 内存测试：100+ 轮对话内存增长 <50MB
- [x] 编写 `test/ui/app-integration.test.ts`
- [x] 编写 `test/benchmarks/ui-render.bench.ts`

**Spec Documentation**: [§2.2 UI 成熟度提升](docs/v3-improvement-spec.md#22-ui-成熟度提升p1)

---

### TASK-031: Windows 沙箱支持

**Status**: completed
**Priority**: P2
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Add Windows Sandbox (WSB) backend for Windows users
- Present Continuous: Adding Windows Sandbox (WSB) backend for Windows users

**Dependencies**:
- `blockedBy`: []
- `blocks`: [TASK-032]

**Checklist**:
- [x] 创建 `src/services/sandbox-windows.ts`：`WindowsSandbox` 类
- [x] `isAvailable()` — 检查 Windows Sandbox 功能是否启用
- [x] `wrapCommand()` — 生成 `.wsb` 配置文件 + 启动命令
- [x] 支持网络隔离（`<Networking>Disable</Networking>`）
- [x] 支持文件夹映射（`<MappedFolders>`）
- [x] 支持内存限制（`<MemoryInMB>`）
- [x] `SandboxManager` 注册 windows-sandbox 后端
- [x] 编写 `test/services/sandbox-windows.test.ts`

**Spec Documentation**: [§2.1.4 Windows 沙箱支持](docs/v3-improvement-spec.md#214-windows-沙箱支持)

---

### TASK-032: CI 门禁强化 + v3 集成测试

**Status**: completed
**Priority**: P1
**Phase**: Phase 3
**预估工时**: 2d

**任务描述**:
- Imperative: Strengthen CI gates and write v3 integration tests
- Present Continuous: Strengthening CI gates and writing v3 integration tests

**Dependencies**:
- `blockedBy`: [TASK-029, TASK-030, TASK-031]
- `blocks`: []

**Checklist**:
- [x] 提升覆盖率阈值：40/30/50/40 → 60/50/70/60
- [x] CI 中添加性能基准步骤（记录 UI 渲染、token 估算、diff 计算耗时）
- [x] 编写 `test/integration/sandbox-full.test.ts`：probe + monitor + images 完整流程
- [x] 编写 `test/integration/ui-full.test.ts`：主题 + 鼠标 + 布局完整流程
- [x] 更新 `docs/architecture.md` 反映 v3 新增模块
- [x] 更新 `package.json` version → 3.0.0
- [x] 编写 CHANGELOG v3.0.0 条目
- [x] 运行 typecheck + build + test:ci 全部通过
- [x] 创建 Git tag `v3.0.0`

**Spec Documentation**: [§四 实施进度追踪表](docs/v3-improvement-spec.md)

---

## 任务依赖图

```
TASK-021 (逃逸检测) ──┐
TASK-022 (资源监控) ──┼─→ TASK-024 (沙箱集成) ──┐
TASK-023 (镜像管理) ──┘                          │
                                                 │
TASK-025 (主题) ──────┐                          │
TASK-026 (鼠标) ──────┼─→ TASK-028 (语言扩展) ──┤
TASK-027 (多面板) ────┘                          ├─→ TASK-032 (CI + 发布)
                                                 │
TASK-029 (API 测试) ─────────────────────────────┤
TASK-030 (UI 集成测试) ──────────────────────────┤
TASK-031 (Windows 沙箱) ─────────────────────────┘
```

---

## 状态追踪

| Status | Count | Tasks |
|--------|-------|-------|
| ✅ completed | 12 | — |
| 🔄 in_progress | 0 | — |
| ✅ completed | 12 | TASK-021 ~ TASK-032 |
| 🚫 blocked | 0 | — |

**总预估工时**: ~21 天（4 周）
