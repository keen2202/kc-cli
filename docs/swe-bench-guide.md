# SWE-bench 提交指南

> **日期**: 2026-05-14
> **目标**: 提交 KC-CLI 到 SWE-bench Verified 排行榜

---

## 一、SWE-bench 简介

SWE-bench 是当前 AI 编码 Agent 最权威的基准测试。给 Agent 一个真实的 GitHub issue + 代码仓库，要求生成 patch 修复问题。

| 数据集 | 问题数 | 说明 |
|--------|--------|------|
| SWE-bench Verified | 500 | 人工验证，主流排行榜 |
| SWE-bench Lite | 300 | 轻量版 |

**当前排行榜**: Claude Mythos Preview (93.9%)、Claude Opus 4.7 (87.6%)、GPT-5.3 Codex (85%)

---

## 二、提交流程

### Step 1: 安装工具
```bash
pip install sb-cli swebench
export SWEBENCH_API_KEY="***"
sb-cli get-quotas
```

### Step 2: 构建适配层
项目路径: `kc-cli/evaluation/swe_bench/`

核心文件:
- `adapter.ts` — KC-CLI ↔ SWE-bench 桥接
- `run_predictions.ts` — 批量运行
- `submit.ts` — 提交脚本
- `prompt.ts` — Prompt 模板
- `dataset.ts` — 数据集加载

### Step 3: 运行预测
```bash
# 本地测试 (10 题)
npx tsx run_predictions.ts --limit 10

# 完整运行 (500 题)
npx tsx run_predictions.ts --dataset verified
```

### Step 4: 本地评估
```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path output/preds.json \
  --max_workers 4 --run_id kc-cli-local
```

### Step 5: 提交排行榜
```bash
sb-cli submit swe-bench-verified test \
  --predictions_path output/preds.json \
  --run_id kc-cli-v3-20260514

# Fork swe-bench/experiments, 添加 metadata.yaml + README.md, 提交 PR
```

---

## 三、预测文件格式
```json
{
  "instance_id": {
    "model_patch": "diff --git a/file.py b/file.py\n...",
    "model_name_or_path": "kc-cli-v3.0.0"
  }
}
```

---

## 四、成本估算

| 模型 | 每题成本 | 500 题总计 |
|------|----------|-----------|
| Claude Sonnet 4 | ~$0.03 | ~$15 |
| Claude Opus 4 | ~$0.15 | ~$75 |
| GPT-5 | ~$0.05 | ~$25 |

---

## 五、资源需求

- 磁盘: 120GB+ (Docker 镜像)
- 内存: 16GB+
- CPU: 8+ 核
- 耗时: 1-2 小时
