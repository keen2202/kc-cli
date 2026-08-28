# Tool Search Efficiency Spec — 减少文档查找的工具调用往返

状态:已实现(核心)/ 后续项见 §5。本规范记录"查找文档/代码时工具调用过多"问题的根因、已落地的修复与被否决的备选方案,供后续演进引用。

## 1. 问题

模型查找文档/代码时典型路径是串行的 `Grep → Grep → Glob → Read → Read` 链,每一环都是一次完整的 LLM 往返。三个放大因素:

1. **单次调用信息密度低**:`Grep` 一次只接受一个 pattern,目录遍历成本无法摊销;没有 `files_with_matches` 类输出模式,找文件也只能倾倒内容。
2. **并行能力未开启**:除 Anthropic/OpenAI/Qwen 外,`supportsParallelToolCalls` 均为 false(或整条能力缺失落到默认 false),指令面明确要求"一次只调一个工具,等结果再调下一个"(`src/api/prompts/instruction-surfaces.ts`)。
3. **无搜索策略指引**:工具 `prompt()`/描述未告知"先定位文件、再精准读"的策略,模型倾向于直接反复全文搜索。

## 2. 已实现的修复

### 2.1 Grep 单次调用信息密度(`src/tools/GrepTool/index.ts`)

- `patterns: string[]`:多模式 OR 匹配,**一次目录遍历**服务 N 个查询(遍历是主要成本)。原 `pattern` 保留兼容。
- `output_mode: 'content' | 'files_with_matches' | 'count'`(默认 content):
  - `files_with_matches`:只列命中文件,廉价定位候选;
  - `count`:每文件命中数,评估扩散面;
  - `max_results` 在 content 模式下限匹配数,其余模式限文件数。
- **二进制跳过**:每文件先读首 8KB 做 null 字节嗅探,命中即跳过(minified 产物/图片/lockfile 不再涌入结果)。
- **大小上限**:超过 1MB 的文件直接跳过。
- 语义收敛:无命中时返回 `No (files|matches) found`;metadata 携带 `output_mode`。

### 2.2 并行工具调用开关(`src/api/capabilities.ts`)

`supportsParallelToolCalls: true` 覆盖:anthropic、openai、qwen(原有)+ **deepseek、glm(翻转)+ kimi、mimo、step、gemini(新增能力条目,原先缺席落入默认 false)**。`ollama` 保持 false(本地模型并行函数调用不可靠)。效果:`instruction-surfaces` 的指令从"一次一个工具"切换为"同一消息内并行发起多个独立搜索"。

执行侧无需改动:`ToolExecutor.executeParallel`(信号量 5,按 `isConcurrencySafe` 分组)与并发 ask 权限队列(commit 72a1f36)已就绪;每个工具调用仍独立过权限检查,不放大安全面。

### 2.3 搜索策略提示词

- `instruction-surfaces` 新增 `search-strategy` surface:多 patterns 一次查 → files_with_matches 定位 → 精准 FileRead;文件名形态已知用 Glob;独立查询并行发。
- Grep/Glob/FileRead 的 `prompt()` 同步补充策略说明(工具描述直接进入模型上下文)。

## 3. 被否决的方案(记录取舍)

- **FileRead 多文件 `paths[]`**:否决。权限系统按 `input.path` 提取路径做保护路径(bypass-immune)检查(`toolExecutor.ts` 的 `extractContentForPermission` 等),多路径参数会绕过该安全面,需要重审权限提取逻辑并补防护测试,收益(读本来就是终端动作)不抵风险。
- **ripgrep 原生后端**:推迟。JS 遍历对小中型仓库足够;引入 rg 二进制依赖(Windows 分发/版本管理/测试回退)成本高。若大仓库性能成为瓶颈,按 §5.1 演进。
- **搜索结果缓存**:推迟。模型很少重复完全相同的查询,TieredCache 接入收益有限且需要失效策略(写后失效可挂 `QueryEngineTurnControl` 的 modifiedFiles)。

## 4. 测试

- `test/tools/GrepTool.test.ts`:schema(默认值/refine/多模式)+ 临时目录实测(content/files_with_matches/count、多模式 OR、二进制跳过、子目录相对路径)。
- `test/api/capabilities*`:并行标志一致性(capabilities-consistency 保护表漂移)。

## 5. 后续项

1. **ripgrep 后端**:`spawn('rg')` 优先、`walkDirectory` 兜底,带 `-e` 多模式/`--files-without-match`/glob 过滤原生加速。
2. **搜索结果缓存**:TieredCache 按 `(pattern, path, mode, mtime 快照)` 键控,写后失效挂 journal。
3. **ReadBatch 工具**:在权限路径提取支持数组字段的前提下重审(见 §3)。
