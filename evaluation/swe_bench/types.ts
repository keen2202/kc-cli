/**
 * SWE-bench type definitions
 */

export interface SWEBenchInstance {
  instance_id: string;        // e.g. "sympy__sympy-20590"
  problem_statement: string;  // GitHub issue 文本
  base_commit: string;        // git commit hash
  repo: string;               // e.g. "sympy/sympy"
  version: string;            // Python version
  test_patch: string;         // 测试代码 patch（验证用）
  patch: string;              // gold patch（ground truth，仅训练集有）
  created_at: string;
  FAIL_TO_PASS: string;       // 需要从 fail 变 pass 的测试
  PASS_TO_PASS: string;       // 需要保持 pass 的测试
}

export interface Prediction {
  model_patch: string;        // KC-CLI 生成的 git diff patch
  model_name_or_path: string; // 模型/系统名称
}

export interface PredictionsFile {
  [instance_id: string]: Prediction;
}

export interface RunConfig {
  dataset: 'verified' | 'lite' | 'full' | 'multilingual';
  split: 'dev' | 'test';
  limit?: number;             // 限制运行数量（调试用）
  model: string;              // LLM 模型
  provider: string;           // LLM provider
  maxTurns: number;           // 每题最大轮数
  timeout: number;            // 每题超时（秒）
  concurrency: number;        // 并发数
  outputDir: string;          // 输出目录
}

export interface RunResult {
  instanceId: string;
  success: boolean;
  patch: string;
  duration: number;           // ms
  turns: number;
  error?: string;
}

export interface RunSummary {
  total: number;
  solved: number;
  failed: number;
  errored: number;
  avgDuration: number;
  avgTurns: number;
  results: RunResult[];
}
