// AGP experiment eval metrics — kc.experiment_eval.v1 types + SplitResult aggregator.
// Offline only; does not import QueryEngine / src/experiments runtime behavior.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

export const EVAL_SET_FORMAT = 'kc.experiment_eval.v1';
export const TASK_RESULT_FORMAT = 'kc.eval_task_result.v1';
/** stdout 摘要上限（字节/字符近似 4KB） */
export const STDOUT_MAX = 4096;

const mockPatchFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const mockConfigSchema = z.object({
  mode: z.enum(['apply-patch', 'no-patch']),
  turns: z.number().int().min(0),
  costUsd: z.number().min(0),
  patchFiles: z.array(mockPatchFileSchema).optional(),
});

const evalTaskSchema = z.object({
  taskId: z.string().min(1),
  repo: z.string().min(1),
  commit: z.string().min(1),
  prompt: z.string().min(1),
  testCommand: z.string().min(1),
  verificationCommand: z.string().min(1),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive(),
  timeoutSec: z.number().positive(),
  mock: mockConfigSchema.optional(),
});

const evalSetSchema = z.object({
  format: z.literal(EVAL_SET_FORMAT),
  split: z.enum(['held-in', 'held-out']),
  description: z.string().optional(),
  tasks: z.array(evalTaskSchema).min(1),
});

export type MockPatchFile = z.infer<typeof mockPatchFileSchema>;
export type MockTaskConfig = z.infer<typeof mockConfigSchema>;
export type EvalTask = z.infer<typeof evalTaskSchema>;
export type EvalSet = z.infer<typeof evalSetSchema>;

/** spec §3.6 SplitResult */
export interface SplitResult {
  tasks: number;
  verifiedTaskRate: number;
  noPatchRate: number;
  avgTurns: number;
  avgCostUsd: number;
  safetyViolations: number;
}

export interface TaskResult {
  format: typeof TASK_RESULT_FORMAT;
  taskId: string;
  split: string;
  backend: string;
  runId: string;
  repo: string;
  commit: string;
  success: boolean;
  verified: boolean;
  noPatch: boolean;
  turns: number;
  costUsd: number;
  patchFiles: string[];
  verificationCommand?: string;
  verificationExitCode?: number | null;
  safetyViolations: number;
  errorCode?: string | null;
  stdoutExcerpt?: string;
  timestamp: number;
}

export function truncateStdout(text: string, max: number = STDOUT_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** 解析并校验 eval set；非法输入抛错（评估集必须显式失败，不可静默空跑）。 */
export function parseEvalSet(raw: string): EvalSet {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('eval set is not valid JSON');
  }
  const parsed = evalSetSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`eval set invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`);
  }
  const set = parsed.data;
  const ids = new Set<string>();
  for (const t of set.tasks) {
    if (ids.has(t.taskId)) throw new Error(`duplicate taskId: ${t.taskId}`);
    ids.add(t.taskId);
  }
  return set;
}

export function loadEvalSet(filePath: string): EvalSet {
  return parseEvalSet(fs.readFileSync(filePath, 'utf8'));
}

/** held-in / held-out taskId 必须不相交 */
export function assertSplitsDisjoint(heldIn: EvalSet, heldOut: EvalSet): void {
  const outIds = new Set(heldOut.tasks.map((t) => t.taskId));
  for (const t of heldIn.tasks) {
    if (outIds.has(t.taskId)) {
      throw new Error(`taskId appears in both splits: ${t.taskId}`);
    }
  }
}

export function emptySplitResult(): SplitResult {
  return {
    tasks: 0,
    verifiedTaskRate: 0,
    noPatchRate: 0,
    avgTurns: 0,
    avgCostUsd: 0,
    safetyViolations: 0,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 从 TaskResult 列表聚合 SplitResult */
export function aggregateSplitResult(records: readonly TaskResult[]): SplitResult {
  if (records.length === 0) return emptySplitResult();
  let verified = 0;
  let noPatch = 0;
  let turnsSum = 0;
  let costSum = 0;
  let safety = 0;
  for (const r of records) {
    if (r.verified) verified++;
    if (r.noPatch) noPatch++;
    turnsSum += r.turns;
    costSum += r.costUsd;
    safety += r.safetyViolations;
  }
  const n = records.length;
  return {
    tasks: n,
    verifiedTaskRate: round4(verified / n),
    noPatchRate: round4(noPatch / n),
    avgTurns: round4(turnsSum / n),
    avgCostUsd: round4(costSum / n),
    safetyViolations: safety,
  };
}

const taskResultSchema = z.object({
  format: z.literal(TASK_RESULT_FORMAT),
  taskId: z.string().min(1),
  split: z.string().min(1),
  backend: z.string().min(1),
  runId: z.string().min(1),
  repo: z.string(),
  commit: z.string(),
  success: z.boolean(),
  verified: z.boolean(),
  noPatch: z.boolean(),
  turns: z.number(),
  costUsd: z.number(),
  patchFiles: z.array(z.string()),
  verificationCommand: z.string().optional().nullable(),
  verificationExitCode: z.number().nullable().optional(),
  safetyViolations: z.number().default(0),
  errorCode: z.string().nullable().optional(),
  stdoutExcerpt: z.string().optional(),
  timestamp: z.number(),
});

export function parseTaskResult(raw: string): TaskResult {
  const parsed = taskResultSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`task result invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`);
  }
  return parsed.data as TaskResult;
}

/** 读取 run 目录下 tasks/<taskId>/record.json */
export function loadTaskRecords(runDir: string, split?: string): TaskResult[] {
  const tasksDir = path.join(runDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  const out: TaskResult[] = [];
  for (const name of fs.readdirSync(tasksDir).sort()) {
    const recordPath = path.join(tasksDir, name, 'record.json');
    if (!fs.existsSync(recordPath)) continue;
    const record = parseTaskResult(fs.readFileSync(recordPath, 'utf8'));
    if (split && record.split !== split) continue;
    out.push(record);
  }
  return out;
}

export interface RunSummary {
  runId: string;
  backend: string;
  createdAt: string;
  splits: Record<string, SplitResult>;
}

/** 汇总 run 目录内所有 split 的 TaskResult */
export function summarizeRun(runDir: string): RunSummary {
  const records = loadTaskRecords(runDir);
  const bySplit = new Map<string, TaskResult[]>();
  for (const r of records) {
    const list = bySplit.get(r.split) ?? [];
    list.push(r);
    bySplit.set(r.split, list);
  }
  const splits: Record<string, SplitResult> = {};
  for (const [split, list] of bySplit) {
    splits[split] = aggregateSplitResult(list);
  }
  const metaPath = path.join(runDir, 'meta.json');
  let runId = path.basename(runDir);
  let backend = 'unknown';
  let createdAt = new Date(0).toISOString();
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      runId?: string;
      backend?: string;
      createdAt?: string;
    };
    runId = meta.runId ?? runId;
    backend = meta.backend ?? backend;
    createdAt = meta.createdAt ?? createdAt;
  }
  return { runId, backend, createdAt, splits };
}

// CLI: npx tsx scripts/eval/metrics.ts <runDir>
const invoked = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (invoked.endsWith('/metrics.ts') || invoked.endsWith('/metrics.js')) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: npx tsx scripts/eval/metrics.ts <runDir>');
    process.exit(2);
  }
  const summary = summarizeRun(runDir);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
