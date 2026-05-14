# KC-CLI SWE-bench Evaluation Adapter

SWE-bench 基准测试适配层，用于评估 KC-CLI 在真实软件工程任务上的表现。

## 目录结构

```
evaluation/swe_bench/
├── adapter.ts              # 核心适配器：KC-CLI ↔ SWE-bench 桥接
├── run_predictions.ts      # 批量运行预测
├── submit.ts               # 提交到排行榜
├── prompt.ts               # Agent prompt 模板
├── types.ts                # 类型定义
├── dataset.ts              # 数据集加载
├── output/                 # 预测输出目录
│   └── preds.json
└── README.md
```

## 快速开始

### 1. 环境准备

```bash
# 安装依赖
cd evaluation/swe_bench
npm install

# 安装 SWE-bench 评估工具
pip install sb-cli swebench

# 设置环境变量
export ANTHROPIC_API_KEY="sk-ant-..."
export SWEBENCH_API_KEY="sb-..."
```

### 2. 本地测试（10 个问题）

```bash
npm run run:local
```

### 3. 完整运行（500 个问题）

```bash
npm run run:verified
```

### 4. 本地评估

```bash
npm run evaluate
```

### 5. 提交到排行榜

```bash
npm run submit
```

## 预测文件格式

```json
{
  "instance_id": {
    "model_patch": "diff --git a/file.py b/file.py\n--- a/file.py\n+++ b/file.py\n@@ -1,3 +1,3 @@\n...",
    "model_name_or_path": "kc-cli-v3.0.0"
  }
}
```

## 成本估算

| 模型 | 每题成本 | 500 题总计 |
|------|----------|-----------|
| Claude Sonnet 4 | ~$0.03 | ~$15 |
| Claude Opus 4 | ~$0.15 | ~$75 |
| GPT-5 | ~$0.05 | ~$25 |
| DeepSeek V4 | ~$0.01 | ~$5 |

## 资源需求

- 磁盘：120GB+（评估 Docker 镜像）
- 内存：16GB+ 推荐
- CPU：8+ 核推荐
- 耗时：约 1-2 小时（完整评估）
