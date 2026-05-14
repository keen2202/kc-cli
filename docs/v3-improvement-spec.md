# KC-CLI v3 改进规格说明

> **版本**: 1.0
> **创建日期**: 2026-05-13
> **状态**: Draft
> **前置依赖**: v2-upgrade-spec.md（Phase 1-2 已完成）
> **目标**: 针对五大短板制定系统性改进方案

---

## 一、现状评估与差距分析

### 已完成（v2 Phase 1-2）

| 领域 | 已实现 | 覆盖度 |
|------|--------|--------|
| 沙箱系统 | SandboxManager + Docker/Bubblewrap/Seccomp/Noop 后端 + 策略系统 + ToolExecutor 集成 | **90%** — 缺少容器镜像缓存、资源监控、逃逸检测 |
| TUI 组件 | Sidebar + DiffPreview + CommandPalette + ModelSelector（chalk 渲染） | **60%** — 缺少虚拟滚动、主题系统、键盘绑定自定义 |
| 测试框架 | Vitest + 覆盖率阈值（40/30/50/40）+ 集成测试 | **41%** — 核心模块覆盖不足 |

### 五大待改进领域

| # | 领域 | 当前状态 | 差距 | 竞品对标 |
|---|------|----------|------|----------|
| 1 | 沙箱深度 | 4 后端 + 策略系统已就绪 | 缺运行时监控、镜像管理、逃逸检测、Windows 支持 | Codex CLI: Docker 网络隔离 + 自动镜像构建 |
| 2 | UI 成熟度 | chalk 渲染 + 基础组件 | 缺主题、虚拟滚动、多面板、鼠标支持、动画 | Claude Code: Ink TUI + 丰富交互；OpenCode: BubbleTea |
| 3 | 模型适配 | 统一 BaseApiClient，相同 system prompt | 无 provider 特化 prompt、无能力探测、token 估算粗糙 | Claude Code: 深度 Claude 优化、extended thinking |
| 4 | LSP 集成 | 5 语言 + diagnostics/hover/definition | 无 completion/references/rename/code-actions、文档同步不可靠 | Cursor: 深度 LSP 集成 + 补全引擎 |
| 5 | 测试覆盖 | 41% 整体，QueryEngine 9.34% | 核心模块覆盖低、无性能基准测试、CI 门禁宽松 | 行业标准: 70%+ |

---

## 二、改进方案详述

### 2.1 沙箱系统深化（P0）

#### 2.1.1 运行时资源监控

**问题**: 当前沙箱仅在启动时设置资源限制（`--memory`、`--cpus`），但不监控运行时消耗。长时间运行的命令可能耗尽系统资源。

**方案**: 添加 `SandboxMonitor` 类，在沙箱命令执行期间持续监控资源使用。

```typescript
// src/services/sandbox-monitor.ts
export interface SandboxMetrics {
  memoryUsageMb: number;
  cpuPercent: number;
  wallTimeMs: number;
  networkBytesIn: number;
  networkBytesOut: number;
}

export class SandboxMonitor {
  private interval: NodeJS.Timeout | null = null;
  private metrics: SandboxMetrics[] = [];

  start(containerId: string, intervalMs = 1000): void {
    // 定期调用 docker stats --no-stream 获取指标
    // 超过阈值时发出警告或强制终止
  }

  stop(): SandboxMetrics[] { /* 返回采集到的指标 */ }

  checkThresholds(limits: ResourceLimits): 'ok' | 'warn' | 'kill' {
    // 检查是否超过 memory/cpu/time 限制
  }
}
```

**涉及文件**:
- `src/services/sandbox-monitor.ts` — **新建**
- `src/services/sandbox-docker.ts` — 集成 monitor
- `src/services/sandbox.ts` — 暴露 monitor 接口
- `test/services/sandbox-monitor.test.ts` — **新建**

#### 2.1.2 Docker 镜像管理

**问题**: 当前 Docker 后端硬编码使用 `node:22-alpine`，首次运行需要拉取镜像，无缓存策略。

**方案**: 添加镜像管理器，支持预拉取、缓存检查、自定义镜像。

```typescript
// src/services/sandbox-images.ts
export class ImageManager {
  async ensureImage(image: string): Promise<void> {
    // 检查镜像是否存在，不存在则拉取
    // 支持进度回调
  }

  async buildCustomImage(dockerfile: string, tag: string): Promise<void> {
    // 支持项目级自定义 Dockerfile
  }

  async listCachedImages(): Promise<ImageInfo[]> {
    // 列出已缓存的沙箱镜像
  }

  async pruneUnused(): Promise<number> {
    // 清理未使用的沙箱镜像
  }
}
```

**涉及文件**:
- `src/services/sandbox-images.ts` — **新建**
- `src/services/sandbox-docker.ts` — 使用 ImageManager
- `.kc-cli/Dockerfile.sandbox` — 项目级自定义镜像模板

#### 2.1.3 沙箱逃逸检测

**问题**: 没有机制验证沙箱是否真正隔离。配置错误或内核漏洞可能导致沙箱失效。

**方案**: 添加沙箱完整性验证，在启动时运行逃逸检测探针。

```typescript
// src/services/sandbox-probe.ts
export class SandboxProbe {
  async verifyIsolation(backend: SandboxBackend): Promise<ProbeResult> {
    const tests = [
      this.testFilesystemIsolation(backend),
      this.testNetworkIsolation(backend),
      this.testProcessIsolation(backend),
      this.testPrivilegeEscalation(backend),
    ];
    return { passed: tests.filter(t => t.passed).length, total: tests.length, failures: ... };
  }

  private async testFilesystemIsolation(backend: SandboxBackend): Promise<TestResult> {
    // 尝试读取 /etc/shadow，应失败
  }

  private async testNetworkIsolation(backend: SandboxBackend): Promise<TestResult> {
    // 尝试 curl 外部地址，应失败（当 allowNetwork=false）
  }
}
```

**涉及文件**:
- `src/services/sandbox-probe.ts` — **新建**
- `src/services/sandbox.ts` — 启动时运行 probe
- `test/services/sandbox-probe.test.ts` — **新建**

#### 2.1.4 Windows 沙箱支持

**问题**: 当前所有后端（bubblewrap、seccomp、Docker）均为 Linux/macOS 专用。Windows 用户无沙箱保护。

**方案**: 添加 Windows Sandbox (WSB) 后端。

```typescript
// src/services/sandbox-windows.ts
export class WindowsSandbox implements SandboxBackend {
  readonly name = 'windows-sandbox';

  isAvailable(): boolean {
    // 检查 Windows Sandbox 功能是否启用
    return process.platform === 'win32' && this.checkWSBEnabled();
  }

  wrapCommand(command: string, options: SandboxOptions): string {
    // 生成 .wsb 配置文件
    // <Configuration><MappedFolders>...</MappedFolders><Networking>...</Networking></Configuration>
    // 通过 WindowsSandbox.exe 启动
  }
}
```

**涉及文件**:
- `src/services/sandbox-windows.ts` — **新建**
- `src/services/sandbox.ts` — 注册 windows-sandbox 后端
- `test/services/sandbox-windows.test.ts` — **新建**

---

### 2.2 UI 成熟度提升（P1）

#### 2.2.1 主题系统

**问题**: 当前 UI 使用硬编码的 chalk 颜色，无法自定义外观。不同终端背景下可读性差。

**方案**: 实现可配置的主题系统。

```typescript
// src/ui/theme.ts
export interface Theme {
  name: string;
  colors: {
    primary: string;      // 主色调
    secondary: string;    // 次要色调
    success: string;      // 成功状态
    warning: string;      // 警告状态
    error: string;        // 错误状态
    muted: string;        // 次要文本
    border: string;       // 边框
    background: string;   // 背景（256色或真彩色）
    highlight: string;    // 高亮
  };
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
  };
  diff: {
    added: string;
    removed: string;
    context: string;
  };
}

export const THEMES: Record<string, Theme> = {
  'dark': { /* 深色主题 */ },
  'light': { /* 浅色主题 */ },
  'solarized-dark': { /* Solarized 深色 */ },
  'monokai': { /* Monokai */ },
  'dracula': { /* Dracula */ },
};

export function getTheme(name: string): Theme;
export function resolveColor(theme: Theme, path: string): Chalk;
```

**涉及文件**:
- `src/ui/theme.ts` — **新建**
- `src/ui/components/*.ts` — 替换硬编码颜色为 theme 引用
- `src/bootstrap/config.ts` — 新增 `ui.theme` 配置项
- `.kc-cli/settings.json` — 主题配置示例

#### 2.2.2 虚拟滚动

**问题**: 长对话（100+ 消息）时，全量渲染导致卡顿和内存增长。

**方案**: 实现基于可见区域的虚拟滚动。

```typescript
// src/ui/virtual-scroll.ts
export class VirtualScroller {
  private totalItems: number;
  private viewportHeight: number;
  private scrollOffset: number;
  private itemHeights: Map<number, number>; // 缓存每项高度

  constructor(config: { viewportHeight: number }) { ... }

  getVisibleRange(): { start: number; end: number } {
    // 计算可见区域的起止索引
  }

  render(items: RenderableMessage[], width: number): string[] {
    const { start, end } = this.getVisibleRange();
    const visible = items.slice(start, end + 1);
    // 渲染可见项 + 顶部/底部占位符
    return [
      start > 0 ? chalk.dim(`  ↑ ${start} more messages above`) : '',
      ...visible.map(item => this.renderItem(item, width)),
      end < items.length - 1 ? chalk.dim(`  ↓ ${items.length - end - 1} more messages below`) : '',
    ];
  }

  scrollUp(lines: number): void { ... }
  scrollDown(lines: number): void { ... }
  scrollToBottom(): void { ... }
}
```

**涉及文件**:
- `src/ui/virtual-scroll.ts` — **新建**
- `src/ui/components/App.ts` — 集成 VirtualScroller
- `test/ui/virtual-scroll.test.ts` — **新建**

#### 2.2.3 鼠标支持

**问题**: 当前 UI 仅支持键盘操作。用户无法通过鼠标点击切换面板、选择文本、滚动。

**方案**: 启用终端鼠标事件追踪。

```typescript
// src/ui/mouse.ts
export class MouseHandler {
  enable(): void {
    // 输出 \x1b[?1000h 启用鼠标点击事件
    // 输出 \x1b[?1002h 启用鼠标按钮事件
    // 输出 \x1b[?1006h 启用 SGR 扩展模式
  }

  disable(): void { /* 输出 \x1b[?1000l */ }

  parseEvent(data: Buffer): MouseEvent | null {
    // 解析 SGR 鼠标事件序列
    // 返回 { x, y, button, action }
  }

  on(event: MouseEvent, layout: LayoutState): Action | null {
    // 根据点击位置判断交互区域
    // 点击 Sidebar tab -> 切换 section
    // 点击消息 -> 选中
    // 点击输入框 -> 聚焦
    // 滚轮 -> 虚拟滚动
  }
}
```

**涉及文件**:
- `src/ui/mouse.ts` — **新建**
- `src/ui/components/App.ts` — 集成 MouseHandler
- `src/ui/input-handler.ts` — 统一键盘/鼠标事件处理

#### 2.2.4 多面板布局增强

**问题**: 当前布局为 Sidebar + Main 固定两栏，无法调整大小或切换布局模式。

**方案**: 实现可配置的面板系统。

```typescript
// src/ui/layout.ts
export type LayoutMode = 'sidebar-main' | 'main-only' | 'main-bottom' | 'three-column';

export interface PanelConfig {
  id: string;
  width: number | 'auto';  // 固定宽度或自动
  minWidth: number;
  maxWidth: number;
  visible: boolean;
  position: 'left' | 'right' | 'center' | 'bottom';
}

export class LayoutManager {
  private mode: LayoutMode = 'sidebar-main';
  private panels: Map<string, PanelConfig> = new Map();

  setMode(mode: LayoutMode): void { ... }
  resizePanel(id: string, delta: number): void { ... }
  togglePanel(id: string): void { ... }
  calculateDimensions(terminalWidth: number, terminalHeight: number): LayoutDimensions { ... }
}
```

**涉及文件**:
- `src/ui/layout.ts` — **新建**
- `src/ui/components/App.ts` — 使用 LayoutManager
- `src/ui/components/Panel.ts` — **新建** 通用面板容器

---

### 2.3 模型适配深度优化（P1）

#### 2.3.1 Provider 能力探测

**问题**: 所有 provider 使用相同的 system prompt 和参数，未利用各模型特色能力。

**方案**: 定义 `ProviderCapabilities` 接口，运行时探测模型能力。

```typescript
// src/api/capabilities.ts
export interface ProviderCapabilities {
  // 基础能力
  maxContextWindow: number;
  maxOutputTokens: number;

  // 工具使用
  supportsToolUse: boolean;
  supportsParallelToolCalls: boolean;
  supportsForcedToolUse: boolean;  // tool_choice=required

  // 推理能力
  supportsThinking: boolean;       // Claude thinking blocks
  supportsExtendedThinking: boolean;
  supportsChainOfThought: boolean;

  // 输出控制
  supportsStructuredOutput: boolean;
  supportsJsonMode: boolean;
  supportsFunctionCalling: boolean;

  // 流式传输
  supportsStreaming: boolean;
  supportsStreamingToolCalls: boolean;

  // Token 编码
  tokenEncoding: 'cl100k_base' | 'o200k_base' | 'tiktoken' | 'custom';

  // 推荐参数
  recommendedTemperature: number;
  recommendedMaxTools: number;  // 单次请求最大工具数
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  'anthropic': {
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsToolUse: true,
    supportsParallelToolCalls: true,
    supportsForcedToolUse: true,
    supportsThinking: true,
    supportsExtendedThinking: true,
    supportsChainOfThought: false,
    supportsStructuredOutput: false,
    supportsJsonMode: false,
    supportsFunctionCalling: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'custom',
    recommendedTemperature: 0,
    recommendedMaxTools: 20,
  },
  'openai': { /* ... */ },
  'deepseek': { /* ... */ },
  'qwen': { /* ... */ },
  'glm': { /* ... */ },
  'ollama': { /* ... */ },
};

export function getCapabilities(provider: string, model?: string): ProviderCapabilities;
```

**涉及文件**:
- `src/api/capabilities.ts` — **新建**
- `src/api/BaseApiClient.ts` — 注入 capabilities
- `src/api/index.ts` — 传递 capabilities 到 client
- `test/api/capabilities.test.ts` — **新建**

#### 2.3.2 Provider 特化 Prompt 系统

**问题**: 当前所有 provider 使用相同的 system prompt，未针对各模型优化。

**方案**: 创建分层 prompt 系统：base prompt + provider overlay + task overlay。

```typescript
// src/api/prompts/types.ts
export interface PromptTemplate {
  system: string;
  toolUse: string;
  codeGen: string;
  debugging: string;
  refactoring: string;
  reasoning: string;
}

// src/api/prompts/provider-prompts.ts
export const PROVIDER_PROMPTS: Record<string, PromptTemplate> = {
  anthropic: {
    system: `You are a meticulous software engineer. Use <thinking> tags to reason step-by-step before taking action. Always verify your work.`,
    toolUse: `Use one tool at a time. After each tool call, analyze the output before deciding the next step.`,
    codeGen: `When writing code, always include type annotations. Prefer TypeScript over JavaScript. Write tests alongside implementation.`,
    debugging: `Use the systematic debugging approach: reproduce, isolate, diagnose, fix, verify.`,
    // ...
  },
  openai: {
    system: `You are an expert software developer. Think through each problem carefully before responding.`,
    toolUse: `Execute tools sequentially and verify results before proceeding.`,
    codeGen: `Write clean, well-documented code with proper error handling.`,
    // ...
  },
  qwen: {
    system: `你是一个专业的软件开发助手。请用中文思考和回答问题。`,
    // ...
  },
};

// src/api/prompts/prompt-builder.ts
export class PromptBuilder {
  constructor(
    private provider: string,
    private capabilities: ProviderCapabilities,
    private config: UserConfig,
  ) {}

  buildSystemPrompt(tools: ToolDefinition[], context: ConversationContext): string {
    const base = PROVIDER_PROMPTS[this.provider] ?? PROVIDER_PROMPTS['default'];
    const parts = [base.system];

    // 根据能力注入特定指令
    if (this.capabilities.supportsThinking) {
      parts.push('Use <thinking> tags for internal reasoning.');
    }

    // 注入工具列表格式化指令
    parts.push(this.formatToolInstructions(tools));

    // 注入任务上下文
    if (context.taskType) {
      parts.push(base[context.taskType] ?? '');
    }

    return parts.join('\n\n');
  }
}
```

**涉及文件**:
- `src/api/prompts/types.ts` — **新建**
- `src/api/prompts/provider-prompts.ts` — **新建**
- `src/api/prompts/task-prompts.ts` — **新建**
- `src/api/prompts/prompt-builder.ts` — **新建**
- `src/query/QueryEngine.ts` — 使用 PromptBuilder
- `test/api/prompts/` — **新建** 测试目录

#### 2.3.3 动态参数调优

**问题**: `max_tokens`、`temperature` 等参数使用固定值，未根据模型和任务自适应。

**方案**: 实现参数调优器，根据 provider 能力和任务类型动态调整。

```typescript
// src/api/param-tuner.ts
export interface TunedParams {
  max_tokens: number;
  temperature: number;
  top_p?: number;
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
}

export class ParamTuner {
  tune(
    capabilities: ProviderCapabilities,
    taskType: TaskType,
    conversationLength: number,
    availableTokens: number,
  ): TunedParams {
    const params: TunedParams = {
      max_tokens: Math.min(capabilities.maxOutputTokens, availableTokens),
      temperature: capabilities.recommendedTemperature,
    };

    // 代码生成任务：低温度
    if (taskType === 'code-gen') {
      params.temperature = Math.min(params.temperature, 0.2);
    }

    // 创意任务：稍高温度
    if (taskType === 'creative') {
      params.temperature = Math.max(params.temperature, 0.7);
    }

    // 根据能力决定是否并行工具调用
    if (!capabilities.supportsParallelToolCalls) {
      params.parallel_tool_calls = false;
      params.tool_choice = 'auto';
    }

    return params;
  }
}
```

**涉及文件**:
- `src/api/param-tuner.ts` — **新建**
- `src/query/QueryEngine.ts` — 使用 ParamTuner
- `test/api/param-tuner.test.ts` — **新建**

#### 2.3.4 精确 Token 估算

**问题**: 当前使用 `chars/4 * 4/3` 粗略估算 token 数，误差高达 30-50%。

**方案**: 使用 `js-tiktoken`（已在依赖中）进行精确编码。

```typescript
// src/utils/tokenEstimation.ts
import { encoding_for_model } from 'js-tiktoken';

export class TokenCounter {
  private encoder: Tiktoken | null = null;
  private cache = new Map<string, number>();

  constructor(private provider: string, private model: string) {}

  count(text: string): number {
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;

    if (!this.encoder) {
      this.encoder = this.getEncoder();
    }

    const count = this.encoder.encode(text).length;
    this.cache.set(text, count);
    return count;
  }

  private getEncoder(): Tiktoken {
    // 根据 provider/model 选择编码器
    try {
      return encoding_for_model(this.model as any);
    } catch {
      return encoding_for_model('gpt-4'); // fallback
    }
  }
}
```

**涉及文件**:
- `src/utils/tokenEstimation.ts` — **重写**
- `src/query/QueryEngine.ts` — 使用 TokenCounter
- `test/utils/tokenEstimation.test.ts` — **新建**

---

### 2.4 LSP 集成增强（P1）

#### 2.4.1 DocumentManager（文档同步）

**问题**: 当前每次 LSP 操作都调用 `didOpen`，不维护文档版本，导致语言服务器状态不一致。

**方案**: 实现文档生命周期管理器。

```typescript
// src/lsp/document-manager.ts
export interface ManagedDocument {
  uri: string;
  languageId: LanguageId;
  version: number;
  content: string;
  isOpen: boolean;
  lastSyncedAt: number;
}

export class DocumentManager {
  private documents = new Map<string, ManagedDocument>();

  open(filePath: string, content: string, languageId: LanguageId): ManagedDocument {
    const uri = `file://${filePath}`;
    const doc: ManagedDocument = {
      uri,
      languageId,
      version: 1,
      content,
      isOpen: true,
      lastSyncedAt: Date.now(),
    };
    this.documents.set(filePath, doc);
    // 发送 textDocument/didOpen 通知
    return doc;
  }

  update(filePath: string, newContent: string): ManagedDocument {
    const doc = this.documents.get(filePath);
    if (!doc) throw new Error(`Document not opened: ${filePath}`);

    const changes = this.computeIncrementalChanges(doc.content, newContent);
    doc.version++;
    doc.content = newContent;
    doc.lastSyncedAt = Date.now();

    // 发送 textDocument/didChange 通知（incremental sync）
    return doc;
  }

  close(filePath: string): void {
    const doc = this.documents.get(filePath);
    if (doc) {
      doc.isOpen = false;
      // 发送 textDocument/didClose 通知
    }
  }

  private computeIncrementalChanges(
    oldContent: string,
    newContent: string,
  ): TextDocumentContentChangeEvent[] {
    // 计算最小变更集（diff）
    // 返回 LSP TextDocumentContentChangeEvent 数组
  }
}
```

**涉及文件**:
- `src/lsp/document-manager.ts` — **新建**
- `src/lsp/client.ts` — 使用 DocumentManager 替代直接 didOpen
- `src/lsp/diagnostics.ts` — 使用 DocumentManager
- `test/lsp/document-manager.test.ts` — **新建**

#### 2.4.2 LSP 补全服务

**问题**: 当前无补全能力，Agent 无法利用语言服务器的智能提示。

**方案**: 实现 `textDocument/completion` 请求，暴露为 LSPTool 方法。

```typescript
// src/lsp/completion.ts
export interface LSPCompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  additionalTextEdits?: TextEdit[];
}

export class CompletionProvider {
  async getCompletions(
    client: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
  ): Promise<LSPCompletionItem[]> {
    const doc = docManager.get(filePath);
    if (!doc) return [];

    const result = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: doc.uri },
      position,
      context: { triggerKind: CompletionTriggerKind.Invoked },
    });

    return this.sortAndFilter(result.items);
  }

  private sortAndFilter(items: CompletionItem[]): LSPCompletionItem[] {
    // 按 sortText 排序
    // 过滤掉 snippet 类型（Agent 通常不需要）
    // 限制返回数量（前 20 个）
  }
}
```

**涉及文件**:
- `src/lsp/completion.ts` — **新建**
- `src/lsp/tool.ts` — 新增 completion action
- `src/lsp/types.ts` — 新增 CompletionItemKind 等类型
- `test/lsp/completion.test.ts` — **新建**

#### 2.4.3 引用查找与重命名

**问题**: 缺少代码导航能力（查找引用、安全重命名），影响重构场景。

**方案**: 实现 `textDocument/references` 和 `textDocument/rename`。

```typescript
// src/lsp/navigation.ts
export class NavigationProvider {
  async findReferences(
    client: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
    includeDeclaration = true,
  ): Promise<LSPLocation[]> {
    const doc = docManager.get(filePath);
    return client.sendRequest('textDocument/references', {
      textDocument: { uri: doc.uri },
      position,
      context: { includeDeclaration },
    });
  }

  async rename(
    client: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const doc = docManager.get(filePath);
    return client.sendRequest('textDocument/rename', {
      textDocument: { uri: doc.uri },
      position,
      newName,
    });
  }

  async findWorkspaceSymbols(
    client: LSPClientManager,
    query: string,
  ): Promise<SymbolInformation[]> {
    return client.sendRequest('workspace/symbol', { query });
  }
}
```

**涉及文件**:
- `src/lsp/navigation.ts` — **新建**
- `src/lsp/tool.ts` — 新增 references/rename/symbol actions
- `src/lsp/types.ts` — 新增 WorkspaceEdit、SymbolInformation
- `test/lsp/navigation.test.ts` — **新建**

#### 2.4.4 代码操作（Code Actions）

**问题**: 无法利用语言服务器的快速修复能力（添加 import、修复拼写等）。

**方案**: 实现 `textDocument/codeAction`。

```typescript
// src/lsp/code-actions.ts
export class CodeActionProvider {
  async getCodeActions(
    client: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    range: LSPRange,
    diagnostics: LSPDiagnostic[],
  ): Promise<CodeAction[]> {
    const doc = docManager.get(filePath);
    const result = await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: doc.uri },
      range,
      context: {
        diagnostics: this.formatDiagnostics(diagnostics),
        only: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports],
      },
    });
    return result ?? [];
  }

  async applyCodeAction(
    client: LSPClientManager,
    action: CodeAction,
  ): Promise<void> {
    if (action.edit) {
      // 应用 workspace edit
      await this.applyWorkspaceEdit(action.edit);
    }
    if (action.command) {
      // 执行命令
      await client.sendRequest('workspace/executeCommand', action.command);
    }
  }
}
```

**涉及文件**:
- `src/lsp/code-actions.ts` — **新建**
- `src/lsp/tool.ts` — 新增 codeAction action
- `test/lsp/code-actions.test.ts` — **新建**

#### 2.4.5 扩展语言支持

**问题**: 仅支持 5 种语言（TypeScript、JavaScript、Go、Python、Rust）。

**方案**: 添加 Java、C/C++、Ruby、PHP 支持，实现语言服务器自动发现。

```typescript
// src/lsp/language-registry.ts
export interface LanguageServerConfig {
  languageId: LanguageId;
  extensions: string[];
  command: string;
  args: string[];
  initializationOptions?: Record<string, any>;
  capabilities?: {
    completion: boolean;
    hover: boolean;
    definition: boolean;
    references: boolean;
    rename: boolean;
    codeAction: boolean;
  };
}

export const LANGUAGE_SERVERS: Record<string, LanguageServerConfig> = {
  // 已有
  typescript: { /* ... */ },
  go: { /* ... */ },
  python: { /* ... */ },
  rust: { /* ... */ },
  // 新增
  java: {
    languageId: 'java',
    extensions: ['.java'],
    command: 'jdtls',
    args: [],
    capabilities: { completion: true, hover: true, definition: true, references: true, rename: true, codeAction: true },
  },
  cpp: {
    languageId: 'cpp',
    extensions: ['.c', '.cpp', '.cc', '.h', '.hpp'],
    command: 'clangd',
    args: ['--background-index'],
    capabilities: { completion: true, hover: true, definition: true, references: true, rename: true, codeAction: true },
  },
  ruby: {
    languageId: 'ruby',
    extensions: ['.rb'],
    command: 'solargraph',
    args: ['stdio'],
    capabilities: { completion: true, hover: true, definition: true, references: false, rename: false, codeAction: false },
  },
};
```

**涉及文件**:
- `src/lsp/language-registry.ts` — **新建**
- `src/lsp/client.ts` — 使用 language-registry
- `test/lsp/language-registry.test.ts` — **新建**

---

### 2.5 测试覆盖提升（P2）

#### 2.5.1 测试覆盖目标

| 模块 | 当前覆盖 | 目标覆盖 | 优先级 | 难度 |
|------|----------|----------|--------|------|
| `query/QueryEngine` | 9.34% | 70%+ | P0 | 高 |
| `permissions/interaction` | 0% | 80%+ | P0 | 中 |
| `permissions/rules` | 35% | 80%+ | P0 | 低 |
| `permissions/engine` | 49% | 80%+ | P0 | 中 |
| `tools/BashTool` | ~30% | 70%+ | P1 | 中 |
| `tools/FileEditTool` | ~20% | 70%+ | P1 | 中 |
| `api/AnthropicClient` | ~15% | 60%+ | P1 | 高 |
| `api/OpenAICompatibleClient` | ~10% | 60%+ | P1 | 高 |
| `lsp/*` | 0% | 60%+ | P1 | 中 |
| `ui/*` | ~20% | 50%+ | P2 | 低 |
| `utils/*` | 0% | 80%+ | P1 | 低 |

#### 2.5.2 Mock LLM 测试基础设施

**问题**: 当前测试无法模拟 LLM 响应，导致 QueryEngine 测试依赖外部 API。

**方案**: 创建 MockLLMClient，支持预设响应序列和错误注入。

```typescript
// test/utils/mock-llm.ts
export class MockLLMClient extends BaseApiClient {
  private responses: LLMResponse[] = [];
  private currentIndex = 0;
  private errorScenarios: Map<string, Error> = new Map();

  setResponses(responses: LLMResponse[]): void {
    this.responses = responses;
    this.currentIndex = 0;
  }

  addErrorScenario(scenario: string, error: Error): void {
    this.errorScenarios.set(scenario, error);
  }

  async *streamChat(config: ChatConfig): AsyncGenerator<LLMStreamEvent> {
    const response = this.responses[this.currentIndex++];

    if (this.errorScenarios.has('stream')) {
      throw this.errorScenarios.get('stream');
    }

    for (const event of response.events) {
      yield event;
    }
  }

  // 预设场景工厂方法
  static withToolCallResponse(toolName: string, toolInput: any, toolResult: string): MockLLMClient { ... }
  static withTextResponse(text: string): MockLLMClient { ... }
  static withMultiTurnResponse(turns: LLMResponse[]): MockLLMClient { ... }
  static withError(error: Error): MockLLMClient { ... }
}
```

**涉及文件**:
- `test/utils/mock-llm.ts` — **新建**
- `test/utils/fixtures.ts` — **新建** 预定义测试场景
- `test/utils/test-helpers.ts` — **新建** 通用测试辅助函数

#### 2.5.3 QueryEngine 深度测试

**问题**: QueryEngine 仅 9.34% 覆盖，核心 agent 循环未充分测试。

**方案**: 逐状态机状态编写测试。

```
测试矩阵:
┌─────────────────────────────────────────────────────────┐
│ 状态转换                    │ 测试用例                  │
├─────────────────────────────┼───────────────────────────┤
│ idle → compact              │ 触发 micro-compact        │
│ compact → stream            │ 流式 API 调用             │
│ stream → decide             │ 工具调用决策              │
│ decide → execute            │ 工具执行                  │
│ execute → compact           │ 循环回到 compact          │
│ any → error                 │ 错误恢复                  │
│ any → aborted               │ abort 信号                │
├─────────────────────────────┼───────────────────────────┤
│ 边界场景                    │                           │
├─────────────────────────────┼───────────────────────────┤
│ 超过 maxMessages            │ 消息截断                  │
│ 超过 maxBudgetUsd           │ 预算耗尽                  │
│ 工具权限拒绝                │ 跳过工具执行              │
│ API 速率限制                │ 指数退避重试              │
│ compaction 失败             │ 降级处理                  │
│ 空工具列表                  │ 纯文本对话                │
└─────────────────────────────┴───────────────────────────┘
```

**涉及文件**:
- `test/QueryEngine.test.ts` — **大幅扩展**
- `test/query/streaming.test.ts` — **新建**
- `test/query/compaction.test.ts` — **新建**
- `test/query/error-recovery.test.ts` — **新建**

#### 2.5.4 CI 门禁强化

**问题**: 当前覆盖率阈值较低（40/30/50/40），CI 未强制检查。

**方案**: 分阶段提升阈值，添加 CI 门禁。

```typescript
// vitest.config.ts — 分阶段提升
// Phase 1 (当前): 40/30/50/40
// Phase 2 (v3):   55/45/60/55
// Phase 3 (目标): 70/60/70/70
```

**涉及文件**:
- `vitest.config.ts` — 提升阈值
- `package.json` — 添加 `test:ci` 脚本
- `.github/workflows/ci.yml` — 添加覆盖率检查 + PR 门禁

#### 2.5.5 性能基准测试

**问题**: 无性能基准，无法量化改进效果。

**方案**: 添加性能基准测试套件。

```typescript
// test/benchmarks/startup.bench.ts
import { bench, describe } from 'vitest';

describe('startup performance', () => {
  bench('config loading', async () => {
    await loadConfig();
  });

  bench('tool registration', () => {
    registerAllTools();
  });
});

// test/benchmarks/token-counting.bench.ts
describe('token counting', () => {
  const counter = new TokenCounter('anthropic', 'claude-sonnet-4-20250514');
  const shortText = 'Hello world';
  const longText = 'x'.repeat(10000);

  bench('short text (12 chars)', () => { counter.count(shortText); });
  bench('long text (10000 chars)', () => { counter.count(longText); });
});
```

**涉及文件**:
- `test/benchmarks/` — **新建** 基准测试目录
- `package.json` — 添加 `test:bench` 脚本

---

## 三、实施路线图

### Phase 1: 安全与基础（Week 1-2）

| 任务 | 优先级 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 沙箱逃逸检测 (sandbox-probe) | P0 | 2d | — |
| 沙箱运行时监控 (sandbox-monitor) | P0 | 2d | — |
| Docker 镜像管理 (sandbox-images) | P0 | 1d | — |
| DocumentManager (LSP) | P1 | 2d | — |
| 精确 Token 估算 | P1 | 1d | — |

### Phase 2: 模型与 LSP（Week 3-4）

| 任务 | 优先级 | 预估工时 | 依赖 |
|------|--------|----------|------|
| Provider 能力探测 | P1 | 1d | — |
| Provider 特化 Prompt | P1 | 2d | 能力探测 |
| 动态参数调优 | P1 | 1d | 能力探测 |
| LSP 补全服务 | P1 | 2d | DocumentManager |
| LSP 引用/重命名 | P1 | 2d | DocumentManager |
| LSP 代码操作 | P1 | 1d | DocumentManager |
| 扩展语言支持 | P2 | 1d | — |

### Phase 3: UI 提升（Week 5-6）

| 任务 | 优先级 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 主题系统 | P1 | 2d | — |
| 虚拟滚动 | P1 | 2d | — |
| 鼠标支持 | P2 | 1d | — |
| 多面板布局 | P2 | 2d | — |
| Windows 沙箱 | P2 | 2d | — |

### Phase 4: 测试与质量（Week 7-8）

| 任务 | 优先级 | 预估工时 | 依赖 |
|------|--------|----------|------|
| MockLLMClient | P0 | 1d | — |
| QueryEngine 深度测试 | P0 | 3d | MockLLM |
| 权限系统测试 | P0 | 2d | — |
| LSP 测试 | P1 | 2d | LSP 实现 |
| CI 门禁强化 | P1 | 1d | 测试完成 |
| 性能基准测试 | P2 | 1d | — |

---

## 四、风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| LSP 语言服务器启动慢 | 用户体验 | 中 | 懒加载 + 超时控制 + 预启动选项 |
| 主题系统增加 UI 复杂度 | 维护成本 | 低 | 接口简单，渐进式迁移 |
| Mock LLM 无法覆盖真实场景 | 测试质量 | 中 | 结合集成测试（真实 API） |
| Provider prompt 维护成本 | 代码膨胀 | 中 | 配置文件驱动 + 版本化 |
| Windows 沙箱兼容性 | 跨平台 | 高 | 优先 Docker + bubblewrap，WSB 作为可选 |

---

## 五、验收标准

### 功能验收

| 领域 | 验收条件 |
|------|----------|
| 沙箱 | 逃逸检测通过率 100%；运行时超限自动终止；镜像缓存命中率 >80% |
| UI | 主题切换即时生效；1000 消息渲染 <100ms；鼠标点击响应 <50ms |
| 模型 | Provider prompt 验证通过；token 估算误差 <5%；参数调优生效 |
| LSP | 5+ 语言补全可用；references/rename 准确率 >90%；诊断延迟 <200ms |
| 测试 | 整体覆盖率 >60%；核心模块 >70%；CI 门禁阻断低于阈值的 PR |

### 性能验收

| 指标 | 当前 | 目标 |
|------|------|------|
| 冷启动时间 | ~1.5s | <1s |
| Token 计算延迟 | N/A (估算) | <10ms/1000 字符 |
| LSP 诊断延迟 | 500ms (不可靠) | <200ms (可靠) |
| UI 渲染（1000 消息） | ~500ms | <100ms |
| 测试套件运行 | ~30s | <60s（含新增测试） |
