# Performance Benchmarks

基准脚本与性能棘轮（参见 `docs/specs/2026-08-31-performance-optimization-design.md` 第 0 阶段）。

## 脚本

- `npm run bench:startup` — 冷启动基准（10 次），写 `scripts/perf-current.json`。
  运行路径为 `node --import tsx src/main.ts`（与 `npm run kc` 一致），耗时含 tsx 转换开销；
  所有测量同路径，相对比较有效。
- `npm run bench:turn` — 单轮开销基准（`buildApiMessages` + token 估算，50/200/800 消息转录）。
- `npm run bench:long` — 长会话内存曲线（60 轮 MockLLM，每 5 轮采样堆内存）。
- `npm run perf:ratchet` — 回归棘轮：当前启动 p50 超出基线 +20% 即失败。

Windows 本机需 `KC_SANDBOX_FAIL_IF_NO_SANDBOX=false`（无沙箱后端；有后端的平台无副作用）。

## NODE_COMPILE_CACHE 评估（Task 1.9，2026-08-31 实测）

`NODE_COMPILE_CACHE`（Node ≥22 原生 V8 编译缓存）在 tsx 运行路径下**无显著收益**：

| 测量 | p50 |
|---|---|
| 无编译缓存 | 4027.6ms |
| 缓存预热后（热态） | 4025.6ms |

原因：启动耗时的主要部分在 tsx 的 TS→JS 转换与模块加载，V8 编译缓存不覆盖该路径。
结论：不纳入启动脚本；esbuild 打包（设计文档第 4 阶段）是覆盖该路径的唯一手段，维持条件触发。

## 基线锚点说明（2026-08-31 重锚）

`scripts/perf-baseline.json` 的 startup 锚点已重锚为 **4120ms**：在原基线代码
（提交 `1c5edf0`，全部优化之前）于当前机器实测 p50=4119.9ms。原 2079ms 锚点
（2026-08-31T02:04 记录）在当前机器条件下不可复现（同代码同日实测 ~2x），
跨时段的机器状态漂移使绝对值不可比；棘轮只在同机同时段的相对比较下有意义。
