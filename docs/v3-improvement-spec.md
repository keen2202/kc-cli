# KC-CLI v3 改进规格说明

> **版本**: 2.0
> **创建日期**: 2026-05-13
> **更新日期**: 2026-05-14
> **状态**: Draft
> **前置依赖**: v2.0.0（已发布，所有 Phase 1-4 已完成）
> **目标**: 在 v2 基础上深化沙箱、提升 UI 成熟度、扩展语言支持

---

## 一、现状评估与差距分析

### 已完成（v2.0.0）

| 领域 | 已实现 | 覆盖度 |
|------|--------|--------|
| 沙箱系统 | SandboxManager + Docker/Bubblewrap/Seccomp/Noop 后端 + 策略系统 + ToolExecutor 集成 + seccomp profile | **85%** — 缺运行时监控、镜像缓存、逃逸检测 |
| TUI 组件 | Sidebar + DiffPreview + CommandPalette + ModelSelector（chalk 渲染）+ 虚拟滚动 | **70%** — 缺主题系统、鼠标支持、多面板布局 |
| LSP 集成 | DocumentManager + CompletionProvider + NavigationProvider + CodeActionProvider + LSPTool | **85%** — 缺扩展语言注册表 |
| 模型适配 | ProviderCapabilities + Provider-specific prompts + ParamTuner + tiktoken TokenCounter | **90%** — 可细化 |
| 测试覆盖 | 874 tests / 54 files / MockLLMClient | **70%** — 核心模块仍需扩展 |
| 文档 | README + CHANGELOG + 迁移指南 + 沙箱/LSP/UI/架构文档 | **90%** |

### v3 待改进领域

| # | 领域 | 当前状态 | 差距 | 优先级 |
|---|------|----------|------|--------|
| 1 | 沙箱深度 | 4 后端 + 策略系统 | 缺运行时监控、镜像管理、逃逸检测、Windows 支持 | P0 |
| 2 | UI 成熟度 | chalk 渲染 + 基础组件 | 缺主题系统、鼠标支持、多面板布局 | P1 |
| 3 | 语言支持 | TS/JS/Go/Python/Rust | 缺 Java/C++/Ruby 语言服务器注册表 | P2 |
| 4 | 测试覆盖 | 874 tests | API Client 测试不足、无性能基准测试 | P1 |

---

## 二、改进方案详述

### 2.1 沙箱系统深化（P0）

#### 2.1.1 沙箱逃逸检测

**问题**: 没有机制验证沙箱是否真正隔离。配置错误或内核漏洞可能导致沙箱失效。

**方案**: 添加 `SandboxProbe` 类，在沙箱启动时运行完整性验证。

```typescript
// src/services/sandbox-probe.ts
export interface ProbeResult {
  passed: number;
  total: number;
  failures: Array<{ test: string; detail: string }>;
  duration: number;
}

export class SandboxProbe {
  async verifyIsolation(backend: SandboxBackend): Promise<ProbeResult> {
    const tests = [
      this.testFilesystemIsolation(backend),  // 尝试读取 /etc/shadow → 应失败
      this.testNetworkIsolation(backend),      // 尝试 curl 外部地址 → 应失败
      this.testProcessIsolation(backend),      // 尝试 kill 宿主进程 → 应失败
      this.testPrivilegeEscalation(backend),   // 尝试 sudo → 应失败
    ];
    const results = await Promise.all(tests);
    return {
      passed: results.filter(t => t.passed).length,
      total: results.length,
      failures: results.filter(t => !t.passed),
      duration: ...,
    };
  }
}
```

**涉及文件**: `sandbox-probe.ts`（新建）、`sandbox.ts`（集成）、`test/services/sandbox-probe.test.ts`（新建）

#### 2.1.2 运行时资源监控

**问题**: 沙箱仅在启动时设置资源限制，不监控运行时消耗。长时间命令可能耗尽系统资源。

**方案**: 添加 `SandboxMonitor` 类，持续监控沙箱资源使用。

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
  start(containerId: string, intervalMs = 1000): void {
    // Docker: docker stats --no-stream
    // Bubblewrap: /proc/[pid]/stat
  }
  stop(): SandboxMetrics[] { /* 返回采集到的指标 */ }
  checkThresholds(limits: ResourceLimits): 'ok' | 'warn' | 'kill' { ... }
}
```

**涉及文件**: `sandbox-monitor.ts`（新建）、`sandbox-docker.ts`（集成）、`test/services/sandbox-monitor.test.ts`（新建）

#### 2.1.3 Docker 镜像管理

**问题**: Docker 后端硬编码 `node:22-alpine`，首次运行需拉取，无缓存策略。

**方案**: 添加 `ImageManager`，支持预拉取、缓存检查、自定义镜像。

```typescript
// src/services/sandbox-images.ts
export class ImageManager {
  async ensureImage(image: string): Promise<void> { /* 检查+拉取 */ }
  async listCachedImages(): Promise<ImageInfo[]> { /* 列出缓存镜像 */ }
  async pruneUnused(): Promise<number> { /* 清理未使用镜像 */ }
  async buildCustomImage(dockerfile: string, tag: string): Promise<void> { /* 项目级自定义 */ }
}
```

**涉及文件**: `sandbox-images.ts`（新建）、`sandbox-docker.ts`（集成）、`.kc-cli/Dockerfile.sandbox`（示例）

#### 2.1.4 Windows 沙箱支持

**问题**: 所有后端均为 Linux/macOS 专用，Windows 用户无沙箱保护。

**方案**: 添加 Windows Sandbox (WSB) 后端。

```typescript
// src/services/sandbox-windows.ts
export class WindowsSandbox implements SandboxBackend {
  readonly name = 'windows-sandbox';
  isAvailable(): boolean {
    return process.platform === 'win32' && this.checkWSBEnabled();
  }
  wrapCommand(command: string, options: SandboxOptions): string {
    // 生成 .wsb 配置 + 启动命令
  }
}
```

**涉及文件**: `sandbox-windows.ts`（新建）、`sandbox.ts`（注册）、`test/services/sandbox-windows.test.ts`（新建）

---

### 2.2 UI 成熟度提升（P1）

#### 2.2.1 主题系统

**问题**: UI 使用硬编码 chalk 颜色，无法自定义外观，不同终端背景下可读性差。

**方案**: 可配置主题系统。

```typescript
// src/ui/theme.ts
export interface Theme {
  name: string;
  colors: { primary, secondary, success, warning, error, muted, border, highlight };
  syntax: { keyword, string, number, comment, function };
  diff: { added, removed, context };
}
export const THEMES: Record<string, Theme> = {
  'dark': { ... },
  'light': { ... },
  'solarized-dark': { ... },
  'monokai': { ... },
  'dracula': { ... },
};
```

**涉及文件**: `theme.ts`（重写）、所有 `components/*.ts`（迁移颜色）、`config.ts`（`ui.theme` 配置项）、`test/ui/theme.test.ts`（新建）

#### 2.2.2 鼠标支持

**问题**: UI 仅支持键盘操作，无法通过鼠标点击切换面板、滚动。

**方案**: 终端鼠标事件追踪。

```typescript
// src/ui/mouse.ts
export class MouseHandler {
  enable(): void  { /* \x1b[?1000h / \x1b[?1002h / \x1b[?1006h */ }
  disable(): void { /* \x1b[?1000l */ }
  parseEvent(data: Buffer): MouseEvent | null { /* SGR 解析 */ }
  on(event: MouseEvent, layout: LayoutState): Action | null { ... }
}
```

**涉及文件**: `mouse.ts`（新建）、`App.ts`（集成）、`test/ui/mouse.test.ts`（新建）

#### 2.2.3 多面板布局增强

**问题**: 固定 Sidebar + Main 两栏，无法调整大小或切换布局模式。

**方案**: 可配置面板系统。

```typescript
// src/ui/layout.ts
export type LayoutMode = 'sidebar-main' | 'main-only' | 'main-bottom' | 'three-column';
export class LayoutManager {
  setMode(mode: LayoutMode): void { ... }
  resizePanel(id: string, delta: number): void { ... }
  togglePanel(id: string): void { ... }
  calculateDimensions(terminalWidth: number, terminalHeight: number): LayoutDimensions { ... }
}
```

**涉及文件**: `layout.ts`（新建）、`App.ts`（使用）、`Panel.ts`（新建通用容器）

---

### 2.3 扩展语言支持（P2）

**问题**: 仅 TS/JS/Go/Python/Rust 五种语言，缺少 Java/C++/Ruby。

**方案**: 语言服务器注册表，支持自动发现。

```typescript
// src/lsp/language-registry.ts
export interface LanguageServerConfig {
  languageId: string;
  extensions: string[];
  command: string;
  args: string[];
  capabilities: ('completion' | 'hover' | 'definition' | 'references' | 'rename' | 'codeAction')[];
}

export const LANGUAGE_REGISTRY: LanguageServerConfig[] = [
  { languageId: 'typescript', extensions: ['.ts', '.tsx'], command: 'typescript-language-server', args: ['--stdio'], capabilities: [...] },
  { languageId: 'java', extensions: ['.java'], command: 'jdtls', args: [], capabilities: [...] },
  { languageId: 'cpp', extensions: ['.c', '.cpp', '.h'], command: 'clangd', args: [], capabilities: [...] },
  { languageId: 'ruby', extensions: ['.rb'], command: 'solargraph', args: ['stdio'], capabilities: [...] },
];
```

**涉及文件**: `language-registry.ts`（新建）、`client.ts`（使用注册表替代硬编码）、`test/lsp/language-registry.test.ts`（新建）

---

### 2.4 测试覆盖扩展（P1）

#### 2.4.1 API Client 测试

**问题**: AnthropicClient、OpenAICompatibleClient、OllamaClient 缺乏测试。

**方案**: 使用 MockHTTP 扩展测试覆盖。

**涉及文件**: `test/api/AnthropicClient.test.ts`、`test/api/OpenAICompatibleClient.test.ts`、`test/api/OllamaClient.test.ts`

#### 2.4.2 CI 门禁强化

**问题**: 覆盖率阈值偏低（40/30/50/40），无性能基准测试。

**方案**:
- 提升阈值到 60/50/70/60
- 添加性能基准测试（UI 渲染、token 估算、diff 计算）
- CI 中运行基准测试并记录结果

**涉及文件**: `vitest.config.ts`、`.github/workflows/ci.yml`、`test/benchmarks/*.bench.ts`（新建）

---

## 三、v3 任务汇总

| Phase | 任务数 | 预估工时 | 重点 |
|-------|--------|----------|------|
| Phase 1: 沙箱深化 | 4 | 6d | 逃逸检测 + 运行时监控 + 镜像管理 + 集成 |
| Phase 2: UI + 语言 | 4 | 7d | 主题 + 鼠标 + 多面板 + 语言注册表 |
| Phase 3: 测试 + 发布 | 5 | 8d | API 测试 + CI 强化 + UI 集成 + 集成测试 + 发布 |
| **合计** | **13** | **~21d** | |

## 四、文件清单

### 新建文件（预计 12 个）

| 文件 | 说明 |
|------|------|
| `src/services/sandbox-probe.ts` | 沙箱逃逸检测 |
| `src/services/sandbox-monitor.ts` | 运行时资源监控 |
| `src/services/sandbox-images.ts` | Docker 镜像管理 |
| `src/services/sandbox-windows.ts` | Windows 沙箱后端 |
| `src/lsp/language-registry.ts` | 语言服务器注册表 |
| `src/ui/theme.ts` | 主题系统（重写） |
| `src/ui/mouse.ts` | 鼠标事件处理 |
| `src/ui/layout.ts` | 多面板布局管理 |
| `src/ui/components/Panel.ts` | 通用面板容器 |
| `test/services/sandbox-probe.test.ts` | 逃逸检测测试 |
| `test/services/sandbox-monitor.test.ts` | 资源监控测试 |
| `test/lsp/language-registry.test.ts` | 语言注册表测试 |

### 修改文件（预计 8 个）

| 文件 | 修改内容 |
|------|----------|
| `src/services/sandbox.ts` | 注入 probe/monitor/images，注册 windows 后端 |
| `src/services/sandbox-docker.ts` | 使用 ImageManager，集成 Monitor |
| `src/lsp/client.ts` | 使用 language-registry 替代硬编码 |
| `src/ui/components/App.ts` | 集成主题/鼠标/布局管理器 |
| `src/bootstrap/config.ts` | 新增 ui.theme / sandbox.monitor 配置 |
| `vitest.config.ts` | 提升覆盖率阈值 |
| `.github/workflows/ci.yml` | 添加性能基准步骤 |
| `package.json` | version → 3.0.0 |
