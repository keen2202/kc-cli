# kc-cli 性能优化设计文档

> 日期：2026-08-31
> 路线：A — 基线先行 + 分阶段热点消除
> 状态：待实施
> 约束：三维度全覆盖（启动速度 / 对话响应 / 长会话稳定）；接受激进改动（含热点子系统重写）；所有优化必须基线+数据验证

---

## 1. 背景与目标

此前已完成三轮架构优化（分层压缩、缓存命中、预算执行等），但代码中仍存在明确的剩余热点。本设计覆盖三个维度：

1. **启动速度**：从执行命令到可交互的耗时
2. **对话响应**：流式输出与每轮处理的延迟
3. **长会话稳定**：多轮之后的内存增长与渲染退化

每个维度的目标值由第 0 阶段建立的基线推导，不预设具体数字（预期量级：启动 30-50%↓，重试路径消息构建开销 >50%↓，长会话内存增长趋平）。

## 2. 现状发现（代码佐证）

| 区域 | 问题 | 位置 |
|---|---|---|
| 启动 | Phase 2→4 严格串行 await 链；git 探测、工具注册、插件初始化、AGP 加载、IM 启动互不依赖却排队执行 | `src/bootstrap/Bootstrap.ts:231-554` |
| 启动 | 重型工具（Sql/better-sqlite3、Docker、LSP、Agent）被 `preloadAllTools` 预热，且在 Phase 4 前被强制 join（`await toolsPreheat`），首个提示前全量加载 | `Bootstrap.ts:278,560` |
| 启动 | `loadDotEnv` 调用 2 次（`src/bootstrap/app.ts:15`、`config.ts`），`loadMCPConfig` 调用 2 次（`Bootstrap.ts:288,409`） | — |
| 每轮 | 重试循环内每次调用 `buildApiMessages(this.conversation.getMessagesCopy())`，对全量消息深拷贝+配对修复 | `src/query/QueryEngine.ts:823`、`src/query/QueryEngineStreaming.ts:117-157` |
| 每轮 | `setMessages`/`trimIfNeeded`/`branch`/`checkout`/`invalidateTokenEstimate` 均触发 `estimateMessageTokensArray` 全量重算；溢出恢复路径单轮可连击多次 | `src/query/QueryEngineState.ts:88,195,206,215` |
| UI | 流式层已做 33ms 合并 + 脏标记 + 历史行 memo；剩余拷贝开销需基准证明后再动 | `src/ui/hooks/useStreamingEvents.ts:91-113` |
| 已有资产 | 启动埋点 `profileCheckpoint`（12 个 checkpoint）与 `getProfileReport` 已存在，可直接复用 | `src/bootstrap/profiler.ts` |
| 已有资产 | CI 棘轮先例 `scripts/coverage-ratchet.mjs` 可仿制 | — |

## 3. 第 0 阶段：基准测量体系（所有优化的前提）

| 基准 | 实现方式 |
|---|---|
| 启动耗时 | 新增隐藏的 bench 退出点（`KC_BENCH_STARTUP=1`：bootstrap 完成后打印 profiler 报告并立即退出，不调用 LLM），`scripts/bench/startup.mjs` 重复冷启动该路径，统计 p50/p95；复用 `profileCheckpoint` 输出各阶段耗时，结果写入 JSON 基线文件（提交入库） |
| 单轮开销 | 独立脚本驱动 `QueryEngine` + `MockLLMClient`，在 50/200/800 条消息的转录下测量 `buildApiMessages` 与 token 估算的单次调用耗时 |
| 长会话曲线 | 脚本化跑 N 轮（MockLLM），每 K 轮采样堆内存（`process.memoryUsage`）与 flush 延迟，输出增长曲线 |
| 回归防护 | 仿 `coverage-ratchet.mjs` 增加 `scripts/perf-ratchet.mjs`：启动基线回归超阈值即失败。CI 机器噪声大，阈值放宽（~20%）且仅对启动指标启用 |

**门槛**：基线数据落库后，第 1-3 阶段每个任务在开始前引用对应基线值，完成后记录新值。

## 4. 第 1 阶段：启动路径

### 4.1 并行化无依赖阶段
- git 探测（`Bootstrap.ts:254`）、工具注册、MCP 配置读取互相独立 → 并行发起，在各自消费点 await。
- 插件初始化、AGP `loadState`、IM `startAll` 三段互不依赖 → 合并为 `Promise.allSettled`，保持现有错误语义（失败仅告警不致命）。

### 4.2 移除工具预热的强制 join
- 现状：`toolsPreheat` 在 Phase 4 前被 await，原因是工具清单静态组装。
- 改法：工具元数据（名称/描述/Schema）在启动期注册，重模块（better-sqlite3、Docker、LSP）推迟到首次调用时加载（`ensureTool` 已有 `pendingLoads` 去重）。后台预热保留，但不再阻塞首个提示。
- 风险点：Phase 4 组装工具清单的代码必须改为只依赖元数据；实现时需核实清单组装点对模块的依赖。

### 4.3 去重
- `loadDotEnv` 收敛为一次调用（入口调用，其余消费方读缓存结果）。
- `loadMCPConfig` 收敛为一次（首次结果传递给后续消费点）。

### 4.4 条件化 AGP
- evolution 功能未启用时跳过 `loadState` 磁盘 IO（`Bootstrap.ts:453-489`）。

### 4.5 Node 编译缓存
- 评估 `NODE_COMPILE_CACHE`（Node ≥22 原生，零代码改动）对冷启动的收益，纳入启动脚本文档。
- esbuild 打包推迟到第 4 阶段，由基线数据决定是否值得。

## 5. 第 2 阶段：每轮热路径增量化

### 5.1 `buildApiMessages` 版本缓存
- `ConversationState`（QueryEngineState）增加单调递增 `version`，在 `addMessage`/`setMessages`/`trimIfNeeded`/`branch`/`checkout`/`clear` 时自增。
- 缓存「上次输入版本号 → 构建结果」；版本未变直接复用。重试循环内（消息未变）从 O(n) 深拷贝+修复降为 O(1)。
- **只读契约**：缓存返回数组的所有下游消费方（API 客户端）只做序列化不 mutate——实现时逐一核实调用方，必要时 `Object.freeze` 或文档化。
- 溢出恢复路径调用 `setMessages` 会使版本自增，缓存自动失效，无需特判。

### 5.2 token 估算增量化
- `trimIfNeeded`：减去被移除消息的估算值，不再全量重算。
- `setMessages`：新增可选参数 `knownTotal`（压缩器知道自己丢了多少），缺省才全量重算。
- `branch`/`checkout`：保留全量重算（低频用户命令，不在热路径；若长会话基准证明其有影响再跟进——见实施计划的偏差记录）。
- 等价性测试：属性测试保证增量值与全量重算一致，覆盖分支切换、压缩、溢出恢复路径。

## 6. 第 3 阶段：长会话与 UI（数据驱动，先测后改）

1. 先跑长会话基准，用曲线定位真实退化点。预判候选：
   - `frozenChains` Map 无限增长 → 加上限/轮换（渲染态只保留最近 N 条）。
   - 超长转录的渲染窗口化（只渲染最近 N 条消息 + 折叠标记）——大改动，仅在数据证明必要时做。
2. `flushRender` 的每帧数组拷贝本身不重（重的是 reconciliation，已被 `useStableHistory` memo 挡住）——**不预设改动**。
3. UI 红线（不可协商）：任何 UI 行为改动必须附 `test/ui/behavior/**` 行为测试；ESC 语义走 focus-stack；布局测量归 Yoga；数据契约只进 `view-protocol.ts`。

## 7. 第 4 阶段：构建层（条件触发）

仅当第 0-2 阶段完成后，基线仍显示启动耗时以模块加载为主，才评估：

- esbuild 单文件打包 `dist/`：better-sqlite3 作为 external（native binding），懒工具保持动态 import。
- 需验证：source map、动态 import、MCP SDK、ink/react 在打包产物中的行为。

本阶段为兜底项，优先级最低。

## 8. 测试与验收

- 每个改动独立可回滚；现有测试套件全绿是硬门槛（`npm run typecheck` + `npm test`）。
- 新增单测：
  - 版本缓存失效正确性（每种 mutation 触发失效）
  - 增量 token 与全量重算等价性（属性测试）
  - 启动并行化后的阶段顺序断言（基于 `profileCheckpoint` 序列）
- 基准脚本产出 JSON 基线文件，提交入库；`perf-ratchet.mjs` 接入现有测试流水线。

## 9. 风险边界

- **不触碰**：权限系统、沙箱、受保护路径等安全关键模块。
- **行为不变**：所有优化对外行为（事件序列、工具语义、配置优先级）保持不变；`buildApiMessages` 的配对修复语义逐字保留。
- **回滚粒度**：每个任务独立提交，可单独 revert。

## 10. 实施顺序

1. 第 0 阶段：基准体系（先行，阻塞其余）
2. 第 1 阶段：启动路径（4.1→4.3→4.4→4.2→4.5，4.2 风险最高排后）
3. 第 2 阶段：热路径（5.1→5.2）
4. 第 3 阶段：长会话（以基准数据为准入条件）
5. 第 4 阶段：构建层（条件触发，可整体跳过）
