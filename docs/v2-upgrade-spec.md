# KC-CLI v2 升级规格说明

> **版本**: 1.0  
> **创建日期**: 2026-05-13  
> **状态**: Draft  
> **作者**: 小腾 (基于竞品对比分析)

---

## 一、问题分类与优先级排序

### P0 — 安全关键（Phase 1: 4-6 周）

| # | 问题 | 影响 | 当前状态 |
|---|------|------|----------|
| 1 | 沙箱未与执行层集成 | 所有工具命令直接执行，无隔离 | `SandboxManager` 已实现但 `ToolExecutor` 未调用 |
| 2 | 无网络隔离验证 | 子 Agent 可访问外部网络 | SeccompSandbox 无 seccomp profile |
| 3 | 受保护路径检测不完整 | 绕过 bypass 模式访问敏感文件 | 仅覆盖基础路径 |

### P1 — 架构核心（Phase 2: 3-4 周）

| # | 问题 | 影响 | 当前状态 |
|---|------|------|----------|
| 4 | LSP Client 功能单薄 | 无法利用语言服务器提供智能补全和诊断 | 仅支持 5 种语言，无 completion 能力 |
| 5 | 模型适配通用化 | 各 LLM 特色能力未充分利用 | 统一 `BaseApiClient` 抽象层 |
| 6 | UI 体验基础 | Ink UI 组件简陋，无分栏、无边栏 | 仅 ChatView + StatusBar + InputBox |

### P2 — 工程品质（Phase 3: 2-3 周）

| # | 问题 | 影响 | 当前状态 |
|---|------|------|----------|
| 7 | 测试覆盖率低 | QueryEngine 9.34%，interaction.ts 0%，rules.ts 35% | 17,047 行代码，核心模块缺测试 |
| 8 | 路径工具无测试 | `utils/path.ts` 0% 覆盖 | 安全关键工具未测试 |

---

## 二、修复方案与技术实现细节

### 2.1 沙箱系统集成

#### 现状分析
- `SandboxManager` 已实现：支持 bubblewrap / seccomp / noop 三级回退
- `sandbox-profiles.ts` 有 BubblewrapSandbox、SeccompSandbox、NoopSandbox
- **问题**：`ToolExecutor` 从未调用 `SandboxManager.wrapCommand()`
- **问题**：SeccompSandbox 名字误导，实际仅用 `ulimit + timeout`，无 seccomp profile

#### 修复方案

**A. ToolExecutor 集成沙箱**
```typescript
// src/executors/toolExecutor.ts
import { SandboxManager } from '../services/sandbox';

export class ToolExecutor {
  private sandbox: SandboxManager;

  constructor(tools: ToolDefinition[], cwd: string, config: ToolExecutorConfig) {
    this.sandbox = new SandboxManager({
      workDir: cwd,
      enabled: config.sandbox?.enabled ?? true,
      backend: config.sandbox?.backend ?? 'bubblewrap',
      allowNetwork: config.sandbox?.allowNetwork ?? false,
      maxMemoryMb: config.sandbox?.maxMemoryMb ?? 512,
      cpuTimeLimitSec: config.sandbox?.cpuTimeLimitSec ?? 60,
    });
  }

  private async executeBashTool(input: BashInput): Promise<ToolResult> {
    const wrappedCommand = this.sandbox.wrapCommand(input.command);
    // use wrappedCommand instead of raw input.command
    return execWithTimeout(wrappedCommand, input.timeout);
  }
}
```

**B. Docker 沙箱后端（新增）**
```typescript
// src/services/sandbox-docker.ts
export class DockerSandbox implements SandboxBackend {
  readonly name = 'docker';

  wrapCommand(command: string, options: SandboxOptions): string {
    const args = [
      'docker', 'run', '--rm',
      '--network', options.allowNetwork ? 'bridge' : 'none',
      '--memory', `${options.maxMemoryMb}m`,
      '--cpus', '1',
      '--read-only',
      '--tmpfs', '/tmp',
      '--tmpfs', '/var/tmp',
      '--mount', `type=bind,source=${options.workDir},target=/work`,
      '-w', '/work',
      '--hostname', 'sandbox',
      'node:22-alpine',
      'sh', '-c', command,
    ];
    return args.join(' ');
  }
}
```

**C. 安全加固措施**
- 新增 seccomp profile JSON，限制系统调用（`execve`, `ptrace`, `mount` 等）
- Docker 后端默认 `--security-opt=no-new-privileges`
- 网络隔离支持 `--network=none` 或自定义 bridge
- 新增 `SandboxPolicy` 配置文件，支持按工具级别设置沙箱策略

**涉及文件**：
- `src/executors/toolExecutor.ts` — 集成 SandboxManager
- `src/services/sandbox-profiles.ts` — 增加 seccomp profile 支持
- `src/services/sandbox-docker.ts` — **新建** Docker 后端
- `src/services/sandbox.ts` — 注册新后端
- `src/bootstrap/config.ts` — 新增 sandbox 配置段
- `test/executors/toolExecutor-sandbox.test.ts` — **新建**

### 2.2 TUI 重构

#### 现状分析
- UI 基于 ink（React for CLI），组件：App、ChatView、InputBox、StatusBar、ToolCallCard
- 无分栏布局、无文件树浏览、无 diff 预览面板
- `diff-viewer.ts` 存在但未集成到主 UI

#### 修复方案

**A. 分栏布局（Sidebar + Main + Bottom Bar）**
```
┌─────────────────────────────────────────────────────┐
│ Header: kc CLI v2.0 · Model: xxx · Session: #123    │
├────────────┬────────────────────────────────────────┤
│ Sidebar    │ Main Chat Area                         │
│ ├─ Files   │ User: Create a web server              │
│ ├─ Tools   │ Assistant: I'll create... [streaming]  │
│ ├─ Tasks   │ ┌─ ToolCall: FileWriteTool ─────────┐  │
│ └─ Memory  │ │ src/server.ts  +120 -0             │  │
│            │ └─────────────────────────────────────┘  │
├────────────┴────────────────────────────────────────┤
│ Input: > Create a REST API                          │
│ Status: ✓ Ready · 3 tools used · $0.05 spent        │
└─────────────────────────────────────────────────────┘
```

**B. 新增组件**
- `FileTree` — 可折叠的文件树，支持 LSP 诊断标记（红色波浪）
- `DiffPreview` — 集成 `diff-viewer.ts`，编辑前预览变更
- `ToolHistory` — 工具调用时间线，支持展开/折叠
- `CommandPalette` — Ctrl+K 命令面板，快速访问工具/命令
- `ModelSelector` — 运行时切换模型

**C. 性能改进策略**
- 使用 `ink` 的 `useApp` + `useInput` 优化键盘事件
- 虚拟滚动长对话（`ink-text-input` + 自定义分页）
- 流式输出节流（16ms/帧，避免过度渲染）
- 异步 diff 计算（Web Worker 风格的 `worker_threads`）

**涉及文件**：
- `src/ui/components/App.ts` — 重构为分栏布局
- `src/ui/components/Sidebar.tsx` — **新建**
- `src/ui/components/FileTree.tsx` — **新建**
- `src/ui/components/DiffPreview.tsx` — **新建**（集成 diff-viewer.ts）
- `src/ui/components/ToolHistory.tsx` — **新建**
- `src/ui/components/CommandPalette.tsx` — **新建**
- `src/ui/components/ModelSelector.tsx` — **新建**
- `src/ui/components/InputBox.ts` — 增强自动补全
- `src/ui/diff-viewer.ts` — 增强为 React 组件
- `src/ui/renderer.ts` — 更新渲染入口

### 2.3 模型适配深度优化

#### 现状分析
- `BaseApiClient` 抽象层：所有 provider 统一接口
- 各 Client（AnthropicClient、OpenAICompatibleClient、OllamaClient）仅实现协议差异
- System Prompt 在所有 Client 中完全一致
- 未利用各 LLM 的特色能力

#### 修复方案

**A. Provider 特化 Prompt 模板**
```typescript
// src/api/prompts/provider-prompts.ts
export const providerSystemTemplates: Record<string, {
  base: string;
  toolUse: string;
  codeGen: string;
  reasoning: string;
}> = {
  anthropic: {
    base: `You are a meticulous software engineer. Use <thinking> tags to reason step-by-step before taking action.`,
    toolUse: `Use one tool at a time. After each tool call, analyze the output before deciding the next step.`,
    codeGen: `When writing code, always include type annotations. Prefer TypeScript over JavaScript.`,
    reasoning: `Break complex problems into smaller sub-problems. Explain your reasoning process.`,
  },
  openai: {
    base: `You are an expert software developer. Think through each problem carefully before responding.`,
    toolUse: `Execute tools sequentially and verify results before proceeding.`,
    codeGen: `Write clean, well-documented code with proper error handling.`,
  },
  qwen: {
    base: `你是一个专业的软件开发助手。请用中文思考和回答问题。`,
    toolUse: `使用工具时请仔细检查结果是否符合预期。`,
    codeGen: `编写代码时注意类型安全和错误处理。`,
  },
  // ...
};
```

**B. 能力特性化注入**
```typescript
// src/api/ProviderCapabilities.ts
export interface ProviderCapabilities {
  maxOutputTokens: number;
  supportsParallelToolCalls: boolean;
  supportsThinking: boolean;  // Claude's thinking blocks
  supportsExtendedThinking: boolean;
  supportsStructuredOutput: boolean;
  supportsSystemFingerprint: boolean;
  tokenEncoding: 'cl100k' | 'o200k' | 'tiktoken' | 'custom';
  recommendedMaxTools: number;
}
```

**C. 动态参数调优**
- 根据 provider 自动调整 `max_tokens`、`temperature`、`top_p`
- 根据模型能力决定是否使用并行工具调用
- Token 估算替换为 js-tiktoken 的精确编码（当前为 `chars/4 * 4/3` 估算）

**涉及文件**：
- `src/api/BaseApiClient.ts` — 增加 ProviderCapabilities
- `src/api/prompts/provider-prompts.ts` — **新建** Provider 特化 prompt
- `src/api/prompts/task-prompts.ts` — **新建** 任务特化 prompt
- `src/api/capabilities.ts` — **新建** 能力探测
- `src/utils/tokenEstimation.ts` — 接入精确 tiktoken
- `src/query/QueryEngine.ts` — 动态选择 tool 并行策略
- `src/config/defaults.ts` — 新增 provider-specific 默认参数

### 2.4 LSP 集成增强

#### 现状分析
- `LSPClientManager` 支持 5 种语言（TS/JS/Go/Python/Rust）
- 已实现：diagnostics、hover、definition
- **缺失**：completion、rename、references、code actions、workspace symbols
- `getDiagnostics` 使用 `setTimeout(500)` 等待，不可靠
- 每次操作都 `didOpen`，不维护文档版本

#### 修复方案

**A. 补全能力**
```typescript
// src/lsp/completion.ts
export class LSPCompletionProvider {
  async getCompletions(
    filePath: string, 
    content: string, 
    line: number, 
    character: number
  ): Promise<LSPCompletionItem[]> {
    // textDocument/completion
    // 支持 snippet 展开
    // 返回带排序的补全列表
  }
}
```

**B. 文档同步管理**
```typescript
// src/lsp/document-manager.ts
export class DocumentManager {
  private documents = new Map<string, {
    version: number;
    content: string;
    uri: string;
    languageId: LanguageId;
  }>();

  openDocument(filePath: string, content: string): void;
  updateDocument(filePath: string, changes: TextDocumentContentChangeEvent[]): void;
  closeDocument(filePath: string): void;
}
```

**C. 集成到工具**
- `FileEditTool` 在写入前调用 LSP 检查语法错误
- `BashTool` 在编译/运行命令前调用 LSP diagnostics
- 新增 `LSPTool`：暴露 LSP 能力给 Agent（补全、诊断、跳转）

**D. 新增功能**
- `textDocument/references` — 查找引用（代码重构场景）
- `textDocument/rename` — 安全重命名
- `textDocument/codeAction` — 快速修复（如添加 import）
- `workspace/symbol` — 全局符号搜索
- 增加更多语言支持：Java (jdtls)、C++ (clangd)、Ruby (solargraph)

**涉及文件**：
- `src/lsp/client.ts` — 重构为 DocumentManager + 可靠诊断
- `src/lsp/completion.ts` — **新建** 补全服务
- `src/lsp/document-manager.ts` — **新建** 文档同步管理
- `src/lsp/code-actions.ts` — **新建** 代码操作
- `src/lsp/references.ts` — **新建** 引用查找
- `src/lsp/tool.ts` — 新增 LSPTool 注册
- `src/lsp/types.ts` — 扩展类型定义
- `src/tools/LSPTool/index.ts` — **新建** LSP 工具
- `test/lsp/*.test.ts` — **新建** LSP 测试

### 2.5 测试覆盖提升

#### 现状分析

| 模块 | 当前覆盖 | 目标覆盖 |
|------|----------|----------|
| QueryEngine | 9.34% | 70%+ |
| permissions/interaction | 0% | 80%+ |
| permissions/rules | 35% | 80%+ |
| permissions/engine | 49% | 80%+ |
| utils/path | 0% | 90%+ |
| LSP 全部 | 0% | 60%+ |
| UI 全部 | 0% | 50%+ |
| sandbox-docker (新建) | — | 80%+ |

#### 修复方案

**A. 优先级排序的测试策略**

1. **安全关键**（最高优先）
   - `permissions/engine.test.ts` — 完整覆盖 6 步决策流
   - `permissions/rules.test.ts` — 通配符匹配、边界情况
   - `permissions/interaction.test.ts` — 用户交互流程
   - `utils/path.test.ts` — 路径遍历攻击防御

2. **核心引擎**（高优先）
   - `query/QueryEngine.test.ts` — 状态机循环、compaction、错误恢复
   - `executors/toolExecutor.test.ts` — 权限检查、超时、并行执行
   - `api/*.test.ts` — 各 provider 的 stream/非 stream 模式

3. **新功能**（中优先）
   - `sandbox-docker.test.ts` — Docker 后端
   - `lsp/*.test.ts` — LSP 增强功能
   - `ui/*.test.tsx` — UI 组件

4. **集成测试**（低优先）
   - `integration/sandbox-e2e.test.ts` — 端到端沙箱
   - `integration/lsp-e2e.test.ts` — 端到端 LSP
   - `integration/multi-agent.test.ts` — 多 Agent 编排

**B. 测试基础设施改进**
```typescript
// test/utils/mock-llm.ts — 新建
export class MockLLMClient extends BaseApiClient {
  // 模拟流式/非流式响应
  // 支持预设响应序列
  // 支持注入错误场景
}

// test/utils/fixtures.ts — 新建
// 预定义测试场景：安全命令、危险命令、文件操作等
```

**C. CI 门禁**
- `package.json` 添加 `test:ci` 脚本：运行测试 + 覆盖率检查
- 新增 `vitest.config.ts` 覆盖率阈值：
  ```typescript
  coverage: {
    thresholds: {
      lines: 60,
      branches: 50,
      functions: 60,
      statements: 60,
    }
  }
  ```
- `.github/workflows/ci.yml` 增加测试步骤

**涉及文件**：
- `test/permissions/engine.test.ts` — **扩展** 6 步决策流
- `test/permissions/rules.test.ts` — **扩展** 通配符测试
- `test/permissions/interaction.test.ts` — **新建**
- `test/utils/path.test.ts` — **新建**
- `test/query/QueryEngine.test.ts` — **大幅扩展**
- `test/executors/toolExecutor-sandbox.test.ts` — **新建**
- `test/utils/mock-llm.ts` — **新建**
- `test/utils/fixtures.ts` — **新建**
- `test/lsp/completion.test.ts` — **新建**
- `test/lsp/document-manager.test.ts` — **新建**
- `test/services/sandbox-docker.test.ts` — **新建**
- `test/integration/*.test.ts` — **新建** 集成测试
- `.github/workflows/ci.yml` — 更新 CI 门禁
- `vitest.config.ts` — 增加覆盖率阈值
- `package.json` — 添加 `test:ci` 脚本

---

## 三、涉及文件总览

| 类别 | 新建 | 修改 | 删除 |
|------|------|------|------|
| 沙箱 | 3 | 3 | 0 |
| UI | 6 | 4 | 0 |
| 模型适配 | 4 | 4 | 0 |
| LSP | 6 | 3 | 0 |
| 测试 | 12 | 3 | 0 |
| 配置/CI | 1 | 3 | 0 |
| **合计** | **32** | **20** | **0** |

---

## 四、实施进度追踪表

| Phase | 周期 | 里程碑 | 状态 |
|-------|------|--------|------|
| Phase 1: 沙箱 | 4-6 周 | ToolExecutor 集成 + Docker 后端 + 测试 | ✅ Completed |
| Phase 2: LSP + UI | 3-4 周 | 补全 + 分栏布局 + 命令面板 | ✅ Completed |
| Phase 3: 模型 + 测试 | 2-3 周 | Provider 特化 + 覆盖率达标 | ✅ Completed |
| Phase 4: 集成 + 发布 | 1-2 周 | 端到端测试 + v2.0 发布 | Pending |

---

## 五、验证和测试方案

### 5.1 自动化测试

| 层级 | 工具 | 覆盖目标 |
|------|------|----------|
| 单元测试 | Vitest + MockLLM | 行覆盖率 70%+ |
| 组件测试 | ink-testing-library | UI 组件 50%+ |
| 集成测试 | Vitest + Docker test container | 核心流程端到端 |
| E2E 测试 | Playwright + kc --print | CLI 交互场景 |

### 5.2 安全验证

| 测试项 | 验证方法 |
|--------|----------|
| 沙箱逃逸 | 在 sandbox 中尝试 `cat /etc/passwd`，应失败 |
| 网络隔离 | 在 sandbox 中尝试 `curl https://example.com`，应失败 |
| 路径遍历 | `FileReadTool` 尝试读取 `../../etc/passwd`，应拒绝 |
| 命令注入 | BashTool 输入含 `; rm -rf /` 的命令，应检测并拒绝 |
| 权限绕过 | bypass 模式下尝试访问 `.ssh`，应仍要求确认 |

### 5.3 性能基准

| 指标 | 当前 | 目标 |
|------|------|------|
| 冷启动时间 | ~1.5s | <1s |
| 单轮 Agent 延迟 | ~2s | <1.5s |
| 内存占用 | ~150MB | <200MB (增加沙箱后) |
| LSP 诊断延迟 | 500ms (不可靠) | <200ms (稳定) |
| UI 渲染帧率 | ~30fps | 60fps |

---

## 六、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Docker 沙箱在非 Linux 平台不可用 | 跨平台兼容性 | 降级到 bubblewrap → seccomp → noop |
| LSP 增加资源占用 | 内存压力增大 | 懒加载语言服务器，空闲自动关闭 |
| Provider 特化 prompt 增加维护成本 | 代码膨胀 | 配置文件驱动，与代码解耦 |
| UI 重构破坏现有 REPL | 用户体验回退 | 保留 readline REPL 作为 fallback |
| 测试覆盖率目标过高 | 开发进度受阻 | 分阶段达标，先核心后边缘 |
