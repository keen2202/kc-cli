/**
 * Offline AGP lab CLI.
 *
 * Subcommands: status | list | archive | evaluate
 * promote / rollback / report arrive in T7.
 *
 * Usage:
 *   npx tsx scripts/agp/cli.ts status [--root <dir>]
 *   npx tsx scripts/agp/cli.ts list [--root <dir>] [artifactId]
 *   npx tsx scripts/agp/cli.ts archive --root <dir> <artifactId> <variantId>
 *   npx tsx scripts/agp/cli.ts evaluate --baseline-run <dir> --candidate-run <dir>
 *        [--root <dir>] [--repeats 3] [--variant-id <id>] [--artifact-id <id>]
 *
 * `status` with no lab data prints an empty state and exits 0.
 * `evaluate` never mutates the catalog — it only writes an immutable gate report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveLabPaths, type LabPaths } from './lab-paths';
import { VersionStore } from './version-store';
import { OverlayStore } from './overlay-store';
import { EvidenceStore } from './evidence-store';
import { loadCatalog } from './catalog-writer';
import { evaluateAcceptance, type AcceptanceGateResult } from './acceptance-gate';
import { promoteVariant, rollbackActive, tryAcquirePromoteLock, releasePromoteLock } from './promotion';
import { runFailureRecoveryE2e } from './e2e';
import {
  loadTaskRecords,
  aggregateSplitResult,
  type SplitResult,
  type TaskResult,
} from '../eval/metrics';

interface CliArgs {
  command: string;
  root: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let command = '';

  const valueFlags = new Set([
    '--root',
    '--baseline-run',
    '--candidate-run',
    '--repeats',
    '--variant-id',
    '--artifact-id',
    '--operator',
    '--reason',
  ]);
  const booleanFlags = new Set(['--yes', '--no-promote']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (booleanFlags.has(arg)) {
      flags[arg.slice(2)] = 'true';
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      flags[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (!command) {
      command = arg;
      continue;
    }
    positional.push(arg);
  }

  return { command, root: flags.root, positional, flags };
}

function ensureStores(paths: LabPaths): {
  versions: VersionStore;
  overlays: OverlayStore;
  evidence: EvidenceStore;
} {
  const versions = new VersionStore(paths);
  const overlays = new OverlayStore(paths, versions);
  const evidence = new EvidenceStore(paths);
  return { versions, overlays, evidence };
}

function hasAnyLabData(paths: LabPaths): boolean {
  return (
    fs.existsSync(paths.catalogPath) ||
    fs.existsSync(paths.versionsPath) ||
    fs.existsSync(paths.overlaysPath) ||
    fs.existsSync(paths.evidenceDir)
  );
}

function cmdStatus(paths: LabPaths): number {
  console.log('AGP offline lab');
  console.log(`  root: ${paths.root}`);

  if (!hasAnyLabData(paths)) {
    console.log('  catalog: missing');
    console.log('  artifacts: 0');
    console.log('  variants: 0');
    console.log('  evidence: 0');
    console.log('  (empty — no lab data yet)');
    return 0;
  }

  const catalogLoad = loadCatalog(paths.catalogPath);
  console.log(`  catalog: ${catalogLoad.state}`);

  const { versions, overlays, evidence } = ensureStores(paths);
  const artifactIds = overlays.listArtifacts();
  let variantCount = 0;
  for (const id of artifactIds) {
    variantCount += overlays.listVariants(id).length;
  }
  const evidenceCount = evidence.list().length;

  console.log(`  artifacts: ${artifactIds.length}`);
  console.log(`  variants: ${variantCount}`);
  console.log(`  evidence: ${evidenceCount}`);
  console.log(`  lineages: ${versions.listArtifacts().length}`);

  for (const id of artifactIds) {
    const baseline = overlays.getBaseline(id);
    const variants = overlays.listVariants(id);
    const promoted = variants.filter(v => v.status === 'promoted');
    const active = promoted.length > 0 ? promoted[promoted.length - 1].variantId : null;
    console.log(`    ${id}`);
    console.log(`      kind=${baseline?.kind ?? '?'} baseHash=${baseline?.baseHash ?? '?'} active=${active ?? 'null'}`);
    for (const v of variants) {
      console.log(`      - ${v.variantId} status=${v.status} evidence=${v.evidenceRef ? v.evidenceRef.slice(0, 20) + '…' : '(none)'}`);
    }
  }
  return 0;
}

function cmdList(paths: LabPaths, positional: string[]): number {
  const { overlays, evidence } = ensureStores(paths);
  const artifactFilter = positional[0];

  if (!hasAnyLabData(paths)) {
    console.log('(empty — no lab data yet)');
    return 0;
  }

  const ids = artifactFilter
    ? overlays.listArtifacts().filter(id => id === artifactFilter)
    : overlays.listArtifacts();

  if (ids.length === 0) {
    console.log(artifactFilter ? `no artifact ${artifactFilter}` : '(no artifacts)');
    return 0;
  }

  for (const id of ids) {
    const baseline = overlays.getBaseline(id);
    console.log(`${id}`);
    console.log(`  kind: ${baseline?.kind ?? '?'}`);
    console.log(`  baseHash: ${baseline?.baseHash ?? '?'}`);
    console.log(`  baseline: ${baseline?.description?.slice(0, 120) ?? ''}`);
    const variants = overlays.listVariants(id);
    if (variants.length === 0) {
      console.log('  variants: (none)');
      continue;
    }
    console.log('  variants:');
    for (const v of variants) {
      console.log(
        `    ${v.variantId}  status=${v.status}  parent=${v.parentVariantId ?? 'null'}  evidence=${v.evidenceRef || '(none)'}`
      );
    }
  }

  const hashes = evidence.list();
  console.log(`evidence files: ${hashes.length}`);
  return 0;
}

function cmdArchive(paths: LabPaths, positional: string[]): number {
  const artifactId = positional[0];
  const variantId = positional[1];
  if (!artifactId || !variantId) {
    console.error('usage: archive <artifactId> <variantId>');
    return 2;
  }
  const { overlays } = ensureStores(paths);
  const result = overlays.archive(artifactId, variantId);
  if (!result.ok) {
    console.error(`archive failed: ${result.reason}`);
    return 1;
  }
  console.log(`archived ${artifactId}/${variantId} → ${result.variant.status}`);
  return 0;
}

function splitFromRecords(records: TaskResult[], split: string): SplitResult {
  return aggregateSplitResult(records.filter(r => r.split === split));
}

function taskIds(records: TaskResult[], split: string): string[] {
  return records.filter(r => r.split === split).map(r => r.taskId);
}

/**
 * T6 evaluate: compare two eval-run directories and write an immutable
 * gate-report evidence file. Never mutates the catalog.
 */
function cmdEvaluate(paths: LabPaths, flags: Record<string, string>): number {
  const baselineRun = flags['baseline-run'];
  const candidateRun = flags['candidate-run'];
  if (!baselineRun || !candidateRun) {
    console.error(
      'usage: evaluate --baseline-run <dir> --candidate-run <dir> [--repeats 3] [--variant-id id] [--artifact-id id]'
    );
    return 2;
  }

  const baselineRecords = loadTaskRecords(baselineRun);
  const candidateRecords = loadTaskRecords(candidateRun);
  if (baselineRecords.length === 0 || candidateRecords.length === 0) {
    console.error('baseline or candidate run has no task records');
    return 1;
  }

  const repeats = Number(flags.repeats ?? '1');
  const variantId = flags['variant-id'] ?? null;
  const artifactId = flags['artifact-id'] ?? null;

  const gateInput = {
    baseline: {
      heldIn: splitFromRecords(baselineRecords, 'held-in'),
      heldOut: splitFromRecords(baselineRecords, 'held-out'),
    },
    candidate: {
      heldIn: splitFromRecords(candidateRecords, 'held-in'),
      heldOut: splitFromRecords(candidateRecords, 'held-out'),
    },
    repeats: Number.isFinite(repeats) ? repeats : 1,
    heldInTaskIds: taskIds(baselineRecords, 'held-in'),
    heldOutTaskIds: taskIds(baselineRecords, 'held-out'),
    candidateHeldInTaskIds: taskIds(candidateRecords, 'held-in'),
    candidateHeldOutTaskIds: taskIds(candidateRecords, 'held-out'),
  };

  const result = evaluateAcceptance(gateInput);

  const evidence = new EvidenceStore(paths);
  const written = evidence.write({
    kind: 'gate-report',
    content: {
      format: 'kc.agp.gate_report.v1',
      artifactId,
      variantId,
      baselineRunId: path.basename(baselineRun),
      candidateRunId: path.basename(candidateRun),
      evaluatedAt: Date.now(),
      gate: result as AcceptanceGateResult,
      splits: {
        baseline: gateInput.baseline,
        candidate: gateInput.candidate,
      },
      repeats: gateInput.repeats,
    },
  });

  console.log(JSON.stringify({ ...result, evidenceRef: written.evidenceHash }, null, 2));
  return result.accept ? 0 : 1;
}

function cmdPromote(paths: LabPaths, positional: string[], flags: Record<string, string>): number {
  const artifactId = flags['artifact-id'] ?? positional[0];
  const variantId = flags['variant-id'] ?? positional[1];
  if (!artifactId || !variantId) {
    console.error('usage: promote <artifactId> <variantId> --yes [--operator name] [--reason text]');
    return 2;
  }
  const lock = tryAcquirePromoteLock(paths);
  if (!lock.ok) {
    console.error(`promote lock held: ${lock.lockPath}`);
    return 1;
  }
  try {
    const { overlays, evidence } = ensureStores(paths);
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId,
      variantId,
      operator: flags.operator ?? process.env.USER ?? process.env.USERNAME ?? 'unknown',
      reason: flags.reason ?? '',
      confirmed: flags.yes === 'true',
    });
    if (!result.ok) {
      console.error(`promote failed: ${result.reason}`);
      return 1;
    }
    console.log(`promoted ${artifactId}/${variantId} evidence=${result.evidenceRef}`);
    return 0;
  } finally {
    releasePromoteLock(lock.lockPath);
  }
}

function cmdRollback(paths: LabPaths, positional: string[], flags: Record<string, string>): number {
  const artifactId = flags['artifact-id'] ?? positional[0];
  if (!artifactId) {
    console.error('usage: rollback <artifactId> --yes [--operator name] [--reason text]');
    return 2;
  }
  const lock = tryAcquirePromoteLock(paths);
  if (!lock.ok) {
    console.error(`rollback lock held: ${lock.lockPath}`);
    return 1;
  }
  try {
    const { overlays } = ensureStores(paths);
    const result = rollbackActive(paths, overlays, {
      artifactId,
      operator: flags.operator ?? process.env.USER ?? process.env.USERNAME ?? 'unknown',
      reason: flags.reason ?? 'rollback',
      confirmed: flags.yes === 'true',
    });
    if (!result.ok) {
      console.error(`rollback failed: ${result.reason}`);
      return 1;
    }
    console.log(
      `rolled back ${artifactId}: active ${result.previousActive} → ${result.newActive ?? 'baseline'}`
    );
    return 0;
  } finally {
    releasePromoteLock(lock.lockPath);
  }
}

async function cmdDemo(paths: LabPaths, flags: Record<string, string>): Promise<number> {
  void paths;
  try {
    const r = await runFailureRecoveryE2e({
      labRoot: flags.root,
      repeats: flags.repeats ? Number(flags.repeats) : undefined,
      operator: flags.operator ?? 'agp-demo',
      promote: flags['no-promote'] !== 'true',
    });
    console.log(
      JSON.stringify(
        {
          outcome: r.gate.outcome,
          accept: r.gate.accept,
          reasons: r.gate.reasons,
          promoted: r.promoted,
          promoteReason: r.promoteReason,
          catalogActive: r.catalogActive,
          evidenceRef: r.evidenceRef,
          heldIn: r.heldIn,
          heldOut: r.heldOut,
        },
        null,
        2
      )
    );
    return r.promoted || r.gate.accept ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function usage(): void {
  console.log(`usage: tsx scripts/agp/cli.ts <command> [--root <dir>]

commands:
  status                         lab summary (empty state when no data)
  list [artifactId]              list artifacts and variants
  archive <artifactId> <variantId>
                                 mark a variant retired
  evaluate --baseline-run <dir> --candidate-run <dir>
                                 run acceptance gate; write evidence; no catalog mutation
           [--repeats 3] [--variant-id id] [--artifact-id id]
  promote <artifactId> <variantId> --yes
                                 promote candidate (requires accepted gate evidence)
  rollback <artifactId> --yes    retire current promoted; active → previous or baseline
  demo                           T8 e2e: failure-recovery-001 → evaluate → gate → promote
           [--repeats 3] [--no-promote] [--operator name]
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    return 2;
  }

  const paths = resolveLabPaths(args.root);

  switch (args.command) {
    case 'status':
      return cmdStatus(paths);
    case 'list':
      return cmdList(paths, args.positional);
    case 'archive':
      return cmdArchive(paths, args.positional);
    case 'evaluate':
      return cmdEvaluate(paths, args.flags);
    case 'promote':
      return cmdPromote(paths, args.positional, args.flags);
    case 'rollback':
      return cmdRollback(paths, args.positional, args.flags);
    case 'demo':
      return cmdDemo(paths, args.flags);
    case '':
    case 'help':
    case '--help':
      usage();
      return args.command === '' ? 2 : 0;
    default:
      console.error(`unknown command: ${args.command}`);
      usage();
      return 2;
  }
}

// Run when invoked directly (tsx scripts/agp/cli.ts …), not when imported by tests.
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /cli\.(ts|js|mjs)$/.test(process.argv[1]);

if (isDirectRun) {
  main().then(code => {
    process.exitCode = code;
  });
}
