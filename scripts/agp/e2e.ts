/**
 * T8 — first end-to-end offline experiment on the failure-recovery surface.
 *
 * Pipeline (all offline, mock backend):
 *   load candidate → overlay store → evaluatePair (held-in + held-out,
 *   repeats>=3 averaged) → acceptance gate → promote --yes → catalog
 *
 * The mock pin carries mockTaskOverrides so the candidate arm can show a
 * real Δ verifiedTaskRate without touching eval sets or fixtures. The
 * candidate's production payload remains the prompt-surface text; the
 * overrides only exist inside the isolated mock workdir.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadCandidateFromFile } from './candidate-generator';
import {
  getAllowlistEntry,
  type CandidateRecord,
} from './artifact-adapter';
import { resolveLabPaths } from './lab-paths';
import { VersionStore } from './version-store';
import { OverlayStore } from './overlay-store';
import { EvidenceStore } from './evidence-store';
import { promoteVariant } from './promotion';
import { evaluateAcceptance } from './acceptance-gate';
import {
  evaluatePair,
  type EvalRunOk,
  type EvalRunResult,
  type EvalSplit,
  type SplitResult,
  type VariantPin,
} from './evaluator-backend';
import { createMockLongtaskBackend, type MockVariantPayload } from './mock-longtask-backend';
import { loadEvalSet } from '../eval/metrics';
import { loadCatalog } from './catalog-writer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const DEFAULT_CANDIDATE_PATH = path.join(HERE, 'candidates', 'failure-recovery-001.json');
export const HELD_IN_PATH = path.join(REPO_ROOT, 'scripts/eval/sets/longtask-held-in.json');
export const HELD_OUT_PATH = path.join(REPO_ROOT, 'scripts/eval/sets/longtask-held-out.json');

/** Gate requires repeats >= 3 (spec §3.6). Mock is deterministic. */
export const DEMO_REPEATS = 3;

/**
 * Mock behavioral delta simulated for the failure-recovery candidate:
 * the observe-only task now actually writes a report file (not marker.txt),
 * so verification passes. Source fixtures / eval sets stay untouched.
 */
export function demoMockOverrides(): MockVariantPayload {
  return {
    mockTaskOverrides: {
      'hi-no-patch-observe': {
        mode: 'apply-patch',
        turns: 2,
        costUsd: 0.01,
        patchFiles: [
          {
            path: 'report.txt',
            content: 'Repository observed. No files modified except this report.\n',
          },
        ],
      },
    },
  };
}

function isOk(result: EvalRunResult): result is EvalRunOk {
  return result.status === 'ok';
}

function averageSplit(results: SplitResult[]): SplitResult {
  if (results.length === 0) {
    throw new Error('cannot average zero SplitResults');
  }
  const n = results.length;
  return {
    tasks: results[0].tasks,
    verifiedTaskRate: results.reduce((s, r) => s + r.verifiedTaskRate, 0) / n,
    noPatchRate: results.reduce((s, r) => s + r.noPatchRate, 0) / n,
    avgTurns: results.reduce((s, r) => s + r.avgTurns, 0) / n,
    avgCostUsd: results.reduce((s, r) => s + r.avgCostUsd, 0) / n,
    safetyViolations: results.reduce((s, r) => s + r.safetyViolations, 0),
  };
}

function loadSplit(setPath: string): EvalSplit {
  const set = loadEvalSet(setPath);
  return { name: set.split, set, sourcePath: setPath };
}

export interface E2eExperimentOptions {
  candidatePath?: string;
  labRoot?: string;
  runsRoot?: string;
  workDirParent?: string;
  repeats?: number;
  operator?: string;
  /** When false, stop after gate report (no promote). Default true. */
  promote?: boolean;
}

export interface E2eExperimentResult {
  candidate: CandidateRecord;
  gate: ReturnType<typeof evaluateAcceptance>;
  promoted: boolean;
  promoteReason?: string;
  catalogActive: string | null;
  evidenceRef: string;
  heldIn: { baseline: SplitResult; candidate: SplitResult };
  heldOut: { baseline: SplitResult; candidate: SplitResult };
}

/**
 * Run the full offline demo. Throws on hard pipeline errors; gate reject
 * still returns a structured result with promoted=false.
 */
export async function runFailureRecoveryE2e(
  options: E2eExperimentOptions = {}
): Promise<E2eExperimentResult> {
  const candidatePath = options.candidatePath ?? DEFAULT_CANDIDATE_PATH;
  const repeats = options.repeats ?? DEMO_REPEATS;
  const labRoot = options.labRoot;
  const runsRoot = options.runsRoot ?? path.join(REPO_ROOT, '.kc-cli/experiments/eval-runs');
  const workDirParent = options.workDirParent;
  const operator = options.operator ?? 'agp-demo';
  const shouldPromote = options.promote !== false;

  const loaded = loadCandidateFromFile(candidatePath);
  if ('reasons' in loaded) {
    throw new Error(`candidate rejected: ${loaded.reasons.join('; ')}`);
  }
  const candidate = loaded.candidate;
  const entry = getAllowlistEntry(candidate.artifactId);
  if (!entry) {
    throw new Error(`artifact not on allowlist: ${candidate.artifactId}`);
  }

  const paths = resolveLabPaths(labRoot);
  const versions = new VersionStore(paths);
  const overlays = new OverlayStore(paths, versions);
  const evidence = new EvidenceStore(paths);

  // Intake as candidate (idempotent payload replace while status=candidate).
  overlays.putVariant({
    artifactId: candidate.artifactId,
    kind: entry.kind,
    baseHash: entry.baseHash,
    baselineDescription: entry.description,
    variantId: candidate.variantId,
    parentVariantId: candidate.parentVariantId ?? null,
    payload: candidate.payload,
    evidenceRef: 'pending-gate', // replaced after evaluate writes real evidence
    provenance: {
      source: candidate.provenance?.source ?? 'manual',
      labRunId: candidate.provenance?.labRunId,
    },
  });

  const pin: VariantPin = {
    artifactId: candidate.artifactId,
    variantId: candidate.variantId,
    baseHash: entry.baseHash,
    payload: demoMockOverrides(),
  };

  const backend = createMockLongtaskBackend({
    root: REPO_ROOT,
    runsRoot,
    workDirParent,
  });

  const heldIn = loadSplit(HELD_IN_PATH);
  const heldOut = loadSplit(HELD_OUT_PATH);

  const baseHeldIn: SplitResult[] = [];
  const candHeldIn: SplitResult[] = [];
  const baseHeldOut: SplitResult[] = [];
  const candHeldOut: SplitResult[] = [];

  for (let i = 0; i < repeats; i++) {
    const pairIn = await evaluatePair(backend, pin, heldIn, {
      runId: `demo-${candidate.variantId}-held-in-r${i}`,
    });
    if (!isOk(pairIn.baseline) || !isOk(pairIn.candidate)) {
      throw new Error(
        `held-in evaluate blocked: ${!isOk(pairIn.baseline) ? pairIn.baseline.reason : pairIn.candidate.reason}`
      );
    }
    baseHeldIn.push(pairIn.baseline.split);
    candHeldIn.push(pairIn.candidate.split);

    const pairOut = await evaluatePair(backend, pin, heldOut, {
      runId: `demo-${candidate.variantId}-held-out-r${i}`,
    });
    if (!isOk(pairOut.baseline) || !isOk(pairOut.candidate)) {
      throw new Error(
        `held-out evaluate blocked: ${!isOk(pairOut.baseline) ? pairOut.baseline.reason : pairOut.candidate.reason}`
      );
    }
    baseHeldOut.push(pairOut.baseline.split);
    candHeldOut.push(pairOut.candidate.split);
  }

  const baseline = {
    heldIn: averageSplit(baseHeldIn),
    heldOut: averageSplit(baseHeldOut),
  };
  const candidateSplits = {
    heldIn: averageSplit(candHeldIn),
    heldOut: averageSplit(candHeldOut),
  };

  const gate = evaluateAcceptance({
    baseline,
    candidate: candidateSplits,
    repeats,
  });

  const evidenceWritten = evidence.write({
    kind: 'gate-report',
    content: {
      format: 'kc.agp.gate_report.v1',
      artifactId: candidate.artifactId,
      variantId: candidate.variantId,
      candidatePath,
      evaluatedAt: 0, // keep evidence content deterministic for mock demo
      repeats,
      gate,
      splits: { baseline, candidate: candidateSplits },
      mockOverrides: demoMockOverrides(),
    },
  });

  // Refresh variant with the real evidenceRef (still candidate status).
  overlays.putVariant({
    artifactId: candidate.artifactId,
    kind: entry.kind,
    baseHash: entry.baseHash,
    baselineDescription: entry.description,
    variantId: candidate.variantId,
    parentVariantId: candidate.parentVariantId ?? null,
    payload: candidate.payload,
    evidenceRef: evidenceWritten.evidenceHash,
    provenance: {
      source: candidate.provenance?.source ?? 'manual',
      labRunId: candidate.provenance?.labRunId,
    },
  });

  let promoted = false;
  let promoteReason: string | undefined;
  if (shouldPromote && gate.accept) {
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId: candidate.artifactId,
      variantId: candidate.variantId,
      operator,
      reason: `e2e demo gate accept (repeats=${repeats})`,
      confirmed: true,
    });
    promoted = result.ok;
    if (!result.ok) promoteReason = result.reason;
  } else if (shouldPromote && !gate.accept) {
    promoteReason = `gate ${gate.outcome}: ${gate.reasons.map(r => r.code).join(', ')}`;
  }

  const catalog = loadCatalog(paths.catalogPath);
  const catalogActive =
    catalog.state === 'valid'
      ? (catalog.catalog.artifacts[candidate.artifactId]?.active ?? null)
      : null;

  return {
    candidate,
    gate,
    promoted,
    promoteReason,
    catalogActive,
    evidenceRef: evidenceWritten.evidenceHash,
    heldIn: { baseline: baseline.heldIn, candidate: candidateSplits.heldIn },
    heldOut: { baseline: baseline.heldOut, candidate: candidateSplits.heldOut },
  };
}
