# KC-CLI 竞品对比分析报告 (2026)

> **日期**: 2026-05-14
> **范围**: 市场上主要 CLI 编码 Agent 产品

---

## 一、市场格局

2026 年 CLI 编码 Agent 市场已超过 30 个工具在竞争。42% 的新代码由 AI 辅助生成（Sonar, 2026）。

**三大阵营：**

| 阵营 | 代表 | 特点 |
|------|------|------|
| 大厂原生 | Claude Code, Codex CLI, Gemini CLI, Copilot CLI | 深度集成自家模型，通常锁定供应商 |
| 独立/创业 | Aider, Amp, Warp, Augment, Cursor, Windsurf | 专注开发者体验，功能差异化强 |
| 开源社区 | OpenCode, Goose, Cline, Kilo, Crush | 模型无关，社区驱动，BYOK |

---

## 二、核心产品对比

### Claude Code（Anthropic）🏆 标杆
- **SWE-bench Verified**: 80.8% (Opus 4.6, 最高)
- **核心优势**: Agent Teams (多子 Agent)、深度代码理解、Git 工作流集成
- **劣势**: 模型锁定、Token 消耗大 (4x Codex)

### Codex CLI（OpenAI）
- **SWE-bench**: 77.3% Terminal-Bench
- **核心优势**: Token 效率极高、沙箱默认启用、轻量级
- **劣势**: 模型锁定、复杂重构能力不如 Claude Code

### Gemini CLI（Google）
- **上下文窗口**: 1M tokens (最大)
- **核心优势**: 免费 1000 请求/天、Google Search 接地、会话检查点
- **劣势**: 代码质量略逊

### OpenCode（SST）⭐ 95K Stars
- **核心优势**: 完全开源、模型无关、零成本
- **劣势**: 无官方基准数据、无 Agent Teams

### Aider
- **核心优势**: Git 深度集成、500+ 模型支持
- **劣势**: CLI-only、自主性较低、无沙箱

---

## 三、关键维度对比

| 维度 | Claude Code | Codex CLI | Gemini CLI | OpenCode | Aider | KC-CLI |
|------|------------|-----------|------------|----------|-------|--------|
| SWE-bench | 80.8% 🏆 | 77.3% | — | — | — | 未测试 |
| 模型灵活性 | ❌ 锁定 | ❌ 锁定 | ❌ 锁定 | ✅ BYOK | ✅ BYOK | ✅ 多 Provider |
| 沙箱隔离 | ✅ | ✅ 默认 | ❌ | ❌ | ❌ | ✅ 4 后端 |
| 多 Agent | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| LSP 集成 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 7 语言 |
| 权限系统 | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ 6 步 |
| 记忆系统 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 上下文窗口 | 200K | 128K | 1M 🏆 | 取决模型 | 取决模型 | 200K |
| 免费额度 | ❌ | ✅ | ✅ 🏆 | ✅ | ✅ | ✅ |
| 开源 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 四、KC-CLI 竞争定位

### 独特优势
1. **架构完整性**: 唯一同时具备沙箱 + 权限 + LSP + 多 Agent + 记忆系统的开源 CLI Agent
2. **Provider 无关**: 7 个 Provider，不锁定
3. **安全深度**: seccomp + Docker + 路径遍历防护 + 受保护路径
4. **TUI 体验**: 侧栏 + Diff 预览 + 命令面板 + 模型选择器
5. **测试覆盖**: 974 个测试

### 劣势
1. 无 SWE-bench 分数
2. 社区规模小
3. 无官方模型
4. 知名度低

### 建议
- 跑 SWE-bench 展示竞争力
- 强调"开源 + 安全 + 多 Provider"三角
- 建社区、写对比博客

---

## 五、趋势判断

1. **收敛效应**: 所有 CLI Agent 收敛到相似功能集
2. **脚手架 > 模型**: 同模型在不同 Agent 中得分差 17 分
3. **免费是入口**: Gemini CLI 免费策略改变市场预期
4. **安全成标配**: 无沙箱的 CLI Agent 将不被企业接受
5. **多 Agent 是方向**: 2026.2 所有主要工具同时发布多 Agent
