# Dependency Upgrade Backlog

**Created**: 2026-08-23 (audit round3 T26 / spec §5-L5)
**Policy**: 每次升级独立 PR；major 升级必须先补行为回归测试再合入；安全修复不受排期约束（随时可插队）。
**Current lock baseline (2026-08-23)**: zod 3.23.8 → 已随 T22 评估线升至 ^3.25；commander 12.1.0；uuid 11.1.1；chalk 5.6.x；better-sqlite3 12.9.0；ink 7.1.0（engines ≥22）。

## 排期表

| Dependency | Current | Target | Major gap | Risk / required regression | Scheduled |
|---|---|---|---|---|---|
| zod | ^3.25（T22 同 PR） | v4 线 | 2 major | v4 重写 `_def` 内部结构（本轮 T22 删除手写 zodToJsonSchema 后直捅点归零，迁移面大幅缩小）；error mapping 与 `safeParse` 返回形状变化 | v3.3 后评估；等 zod-to-json-schema 宣布 v4 兼容 |
| commander | 12.1.0 | 13.x | 1 major | CLI 参数解析行为差异——必须先建 `test/commands/` CLI 参数行为回归套件（含 `--help` 输出快照）再升 | 近期（低风险，测试先行） |
| uuid | 11.1.1 | 14.x | 3 major | ESM-only 收紧、默认导出移除历史；项目仅用 `v4()` 工具函数，机械替换即可 | 中期，随手清理 PR |
| chalk | 5.6.x | 6.x | 1 major | ESM-only（已是）；API 稳定，level 检测行为微调 | 中期，与 commander 同批 |
| better-sqlite3 | 12.9.0 | 13.x | 1 major | native 模块重编译；Node ABI 对齐（engines ≥22 后无 20 腿负担）。见下方 optionalDependencies 评估 | 与 optionalDependencies 决议绑定 |
| typescript | ^5.9 | 跟进 minor | — | 随 CI 定期 bump | 滚动 |

## 评估项：SqlTool/better-sqlite3 改 optionalDependencies

**结论（T26 回写）：不采纳，保持 regular dependency + 运行时懒加载。**

理由：
1. SqlTool 是 TOOL_MANIFEST 注册工具（MEDIUM priority lazy load），模块加载已按需进行——optionalDependencies 省下的只是安装带宽，不是启动时间；
2. optionalDependencies 在 npm ci 的静默跳过语义会让"装了但装坏"的 native 构建失败更难诊断（CI 与用户机表现分叉）；
3. better-sqlite3 是唯一 native 依赖，prebuilt 二进制覆盖 Node 22/24 主流平台；真正痛点是源码编译回退场景，解法是文档化 build-essential 前置，而非改依赖类别；
4. 若未来把 SqlTool 拆成独立插件包（`kc-plugin-sql`），届时它自然成为该包的 regular dependency，主包零 sqlite —— 这是比 optionalDependencies 更干净的终局。

## 记录

- 2026-08-23: 建立 backlog；zod ^3.25 随 T22 完成；npm audit 清零 high（T23）。
