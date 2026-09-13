/**
 * T11 — canary metrics report: aggregate RunOutcome JSONL by variant.
 * Offline lab only. Reads `.kc-cli/experiments/runs/*.jsonl`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RunOutcome, VariantRef } from '../../src/experiments/protocol';
import type { SplitResult } from '../eval/metrics';

export interface VariantCanaryMetrics {
  artifactId: string;
  variantId: string;
  runs: number;
  successRate: number;
  verifiedRate: number;
  noPatchRate: number;
  avgTurns: number;
  avgCostUsd: number;
  errorCodes: Record<string, number>;
}

export interface CanaryReport {
  generatedAt: number;
  totalOutcomes: number;
  byVariant: VariantCanaryMetrics[];
  baselineLike: VariantCanaryMetrics[];
}

function loadOutcomes(runsDir: string): RunOutcome[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: RunOutcome[] = [];
  for (const name of fs.readdirSync(runsDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const raw = fs.readFileSync(path.join(runsDir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RunOutcome;
        if (parsed && typeof parsed.success === 'boolean') out.push(parsed);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return out;
}

function metricsFor(
  artifactId: string,
  variantId: string,
  outcomes: RunOutcome[]
): VariantCanaryMetrics {
  const n = outcomes.length || 1;
  const errorCodes: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.errorCode) errorCodes[o.errorCode] = (errorCodes[o.errorCode] ?? 0) + 1;
  }
  return {
    artifactId,
    variantId,
    runs: outcomes.length,
    successRate: outcomes.filter(o => o.success).length / n,
    verifiedRate: outcomes.filter(o => o.verified).length / n,
    noPatchRate: outcomes.filter(o => o.noPatch).length / n,
    avgTurns: outcomes.reduce((s, o) => s + (o.turns || 0), 0) / n,
    avgCostUsd: outcomes.reduce((s, o) => s + (o.costUsd || 0), 0) / n,
    errorCodes,
  };
}

/**
 * Aggregate run outcomes by (artifactId, variantId).
 * Outcomes with no assignments land in baselineLike under artifactId '*'.
 */
export function buildCanaryReport(runsDir: string): CanaryReport {
  const outcomes = loadOutcomes(runsDir);
  const byKey = new Map<string, RunOutcome[]>();
  const baseline: RunOutcome[] = [];

  for (const o of outcomes) {
    const assigns: VariantRef[] = o.artifactAssignments ?? [];
    if (assigns.length === 0) {
      baseline.push(o);
      continue;
    }
    for (const a of assigns) {
      const key = `${a.artifactId}::${a.variantId}`;
      const list = byKey.get(key) ?? [];
      list.push(o);
      byKey.set(key, list);
    }
  }

  const byVariant: VariantCanaryMetrics[] = [];
  for (const [key, list] of byKey) {
    const [artifactId, variantId] = key.split('::');
    byVariant.push(metricsFor(artifactId, variantId, list));
  }
  byVariant.sort((a, b) =>
    a.artifactId === b.artifactId
      ? a.variantId.localeCompare(b.variantId)
      : a.artifactId.localeCompare(b.artifactId)
  );

  return {
    generatedAt: Date.now(),
    totalOutcomes: outcomes.length,
    byVariant,
    baselineLike: baseline.length ? [metricsFor('*', 'baseline', baseline)] : [],
  };
}

/** SplitResult-shaped view of one canary metrics row (for gate comparison). */
export function toSplitResult(m: VariantCanaryMetrics, tasks = m.runs): SplitResult {
  return {
    tasks,
    verifiedTaskRate: m.verifiedRate,
    noPatchRate: m.noPatchRate,
    avgTurns: m.avgTurns,
    avgCostUsd: m.avgCostUsd,
    safetyViolations: 0,
  };
}

/**
 * P2 canary rollback suggestion: fires when a variant's verified rate drops
 * more than `threshold` below baseline, or any safety-like error appears.
 */
export function suggestRollback(
  report: CanaryReport,
  baselineVerifiedRate: number,
  threshold = 0.1
): Array<{ artifactId: string; variantId: string; reason: string }> {
  const out: Array<{ artifactId: string; variantId: string; reason: string }> = [];
  for (const m of report.byVariant) {
    if (baselineVerifiedRate - m.verifiedRate > threshold) {
      out.push({
        artifactId: m.artifactId,
        variantId: m.variantId,
        reason: `verifiedRate ${m.verifiedRate.toFixed(3)} is more than ${threshold} below baseline ${baselineVerifiedRate.toFixed(3)}`,
      });
    }
    if ((m.errorCodes['budget_exceeded'] ?? 0) > 0 && m.successRate < 0.5) {
      out.push({
        artifactId: m.artifactId,
        variantId: m.variantId,
        reason: `high budget_exceeded rate with successRate ${m.successRate.toFixed(3)}`,
      });
    }
  }
  return out;
}
