# Pending Spec — Memory Consolidation（待建条目）

**Status**: Parked（本轮从 src 移除，见 audit-remediation-round3 T10 / spec §3-H9）
**Date**: 2026-08-23
**Origin**: kc-cli v3.2.0 深度审计 round3 —— `src/memory/memoryConsolidation.ts`（~330 行，4 导出零生产调用）及其卫星模块（consolidationScheduler / consolidationPrompts / memoryQuality）与 `src/services/` 下 8 个 "dual-track removal" re-export shim 一并删除。

## 若重启此功能，需先立项回答

1. **触发模型**： consolidation 由什么驱动？（turn 阈值 / 会话结束 / 定时 / 显式命令）——原实现是 `consolidationScheduler` 的锁文件 + 手动触发混合体，从未接线。
2. **LLM 成本归属**： 合并摘要调用哪个 provider、预算从哪个 budget 池扣（session/tool/sub-agent）？
3. **与 compaction 的边界**： 会话内压缩（services/compaction/）与跨会话合并的职责分界与数据流。
4. **质量门**： 原 memoryQuality 的评分规则是否保留；合并冲突（同主题多文件）的裁决策略。
5. **验收**： 行为级测试先行（MockLLMClient 驱动真实合并管线），禁止 mock 断言 mock（AGENTS.md Testing 段规约）。

## 已删除内容（git 考古入口）

- tag `pre-agp-removal` 之后的首个提交（T09+T10 同期）
- `src/memory/memoryConsolidation.ts`、`src/memory/consolidationScheduler.ts`、`src/memory/consolidationPrompts.ts`、`src/memory/memoryQuality.ts`
- `src/services/{memoryExtraction,memoryConsolidation,consolidationScheduler,consolidationPrompts,extractionPrompts,memoryQuality,memory-extraction-guard,compaction}.ts`（8 个 re-export shim；memoryExtraction/extractionPrompts/memory-extraction-guard 的真实实现在 `src/memory/` 下继续存活并被 integration.ts 使用）
- 测试：`test/services/memoryConsolidation{,-coverage}.test.ts`、`consolidationScheduler.test.ts`、`consolidationPrompts.test.ts`、`memoryQuality.test.ts`
