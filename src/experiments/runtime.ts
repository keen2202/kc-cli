// FileExperimentRuntime — session-locked, catalog-read-only experiment overlay.
// Default path (enabled=false) is a pure no-op with zero disk IO.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { logger } from '../services/logger';
import { createHash } from 'crypto';
import {
  artifactIdForPromptSurface,
  computeBaseHash,
  computeBaseHashJson,
  getActivePromotedVariant,
  parseCatalog,
  POLICY_ARTIFACT_ID,
  type Catalog,
  type CatalogArtifact,
} from './catalog';
import {
  createNoopExperimentRuntime,
  type ExperimentRuntime,
  type ResolvedVariant,
  type RunOutcome,
  type RuntimePolicyOverlay,
  type VariantRef,
} from './protocol';

export interface FileExperimentRuntimeOptions {
  /** Master switch. false → noop with zero IO. */
  enabled: boolean;
  /** Absolute or cwd-relative catalog path. Default: .kc-cli/experiments/catalog.json */
  catalogPath?: string;
  /** Directory for run outcome JSONL. Default: .kc-cli/experiments/runs */
  runsDir?: string;
  /** cwd used to resolve relative paths. Default: process.cwd() */
  cwd?: string;
  /** Session id used for run outcome filenames. */
  sessionId: string;
  /**
   * Prompt-surface name → current baseline text. Used for baseHash drift checks.
   * Surfaces missing from this map resolve to baseline without overlay.
   */
  promptSurfaceBaselines?: Record<string, string>;
  /** Baseline runtime policy (allowlist shape) for baseHash + merge. */
  runtimePolicyBaseline?: RuntimePolicyOverlay;
  /** Force canary bucket (tests). When set, overrides sessionId hash. */
  forceCanaryBucket?: 'in' | 'out';
}

/**
 * Stable canary bucket: 0..99 from sha256(sessionId + artifactId).
 * Same session always lands in the same bucket for a given artifact.
 */
export function canaryBucket(sessionId: string, artifactId: string): number {
  const h = createHash('sha256').update(`${sessionId}::${artifactId}`, 'utf8').digest();
  return h.readUInt32BE(0) % 100;
}

/** True when this session should receive the canary overlay for the artifact. */
export function isInCanaryBucket(
  sessionId: string,
  artifactId: string,
  artifact: Pick<CatalogArtifact, 'rollout'>,
  force?: 'in' | 'out'
): boolean {
  if (force === 'in') return true;
  if (force === 'out') return false;
  const rollout = artifact.rollout;
  if (!rollout || rollout.mode !== 'canary') return true; // full rollout
  if (rollout.percent <= 0) return false;
  if (rollout.percent >= 100) return true;
  return canaryBucket(sessionId, artifactId) < rollout.percent;
}

const policyOverlaySchema = z
  .object({
    maxSameCallRetries: z.number().int().min(0).max(5).optional(),
    retryIntervention: z.enum(['soft', 'hard']).optional(),
    maxReadOnlyStreak: z.number().int().min(1).max(20).optional(),
    maxTotalToolMessages: z.number().int().min(0).max(200).optional(),
    redirectInstruction: z.string().max(1024).optional(),
  })
  .strict();

interface LockedAssignment {
  artifactId: string;
  variantId: string;
  baseHash: string;
  evidenceRef: string;
  payload: string | Record<string, unknown>;
}

export class FileExperimentRuntime implements ExperimentRuntime {
  private readonly enabled: boolean;
  private readonly catalogPath: string;
  private readonly runsDir: string;
  private readonly sessionId: string;
  private readonly promptSurfaceBaselines: Record<string, string>;
  private readonly runtimePolicyBaseline: RuntimePolicyOverlay;
  private readonly forceCanaryBucket: 'in' | 'out' | undefined;
  private assignments = new Map<string, LockedAssignment>();
  private initialized = false;

  constructor(options: FileExperimentRuntimeOptions) {
    this.enabled = options.enabled;
    const cwd = options.cwd ?? process.cwd();
    this.catalogPath = path.resolve(cwd, options.catalogPath ?? path.join('.kc-cli', 'experiments', 'catalog.json'));
    this.runsDir = path.resolve(cwd, options.runsDir ?? path.join('.kc-cli', 'experiments', 'runs'));
    this.sessionId = options.sessionId;
    this.forceCanaryBucket = options.forceCanaryBucket;
    this.promptSurfaceBaselines = options.promptSurfaceBaselines ?? {};
    this.runtimePolicyBaseline = options.runtimePolicyBaseline ?? {};
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.enabled) return;

    const catalog = this.loadCatalog();
    this.assignPrompts(catalog);
    this.assignPolicy(catalog);
  }

  resolvePromptSurface(name: string, base: string): ResolvedVariant<string> {
    const artifactId = artifactIdForPromptSurface(name);
    const locked = this.assignments.get(artifactId);
    if (!locked || typeof locked.payload !== 'string') {
      return {
        value: base,
        artifactId,
        variantId: null,
        baseHash: computeBaseHash(base),
        source: 'baseline',
      };
    }
    // Drift: locked baseHash must still match the code baseline we saw at init.
    const currentHash = computeBaseHash(base);
    if (locked.baseHash && currentHash !== locked.baseHash) {
      logger.services.warn(
        `[experiments] baseHash drift for ${artifactId}; falling back to baseline`
      );
      return {
        value: base,
        artifactId,
        variantId: null,
        baseHash: currentHash,
        source: 'baseline',
      };
    }
    return {
      value: locked.payload,
      artifactId,
      variantId: locked.variantId,
      baseHash: locked.baseHash,
      source: 'experiment',
    };
  }

  resolveRuntimePolicy<T extends RuntimePolicyOverlay>(base: T): ResolvedVariant<T> {
    const baselineResult: ResolvedVariant<T> = {
      value: base,
      artifactId: POLICY_ARTIFACT_ID,
      variantId: null,
      baseHash: computeBaseHashJson(base),
      source: 'baseline',
    };
    const locked = this.assignments.get(POLICY_ARTIFACT_ID);
    if (!locked || typeof locked.payload === 'string') {
      return baselineResult;
    }
    const parsed = policyOverlaySchema.safeParse(locked.payload);
    if (!parsed.success) {
      logger.services.warn(
        `[experiments] invalid runtime-policy overlay; using baseline (${parsed.error.issues.length} issues)`
      );
      return baselineResult;
    }
    // enabled is frozen — never taken from overlay.
    const merged = { ...base, ...parsed.data } as T;
    return {
      value: merged,
      artifactId: POLICY_ARTIFACT_ID,
      variantId: locked.variantId,
      baseHash: locked.baseHash,
      source: 'experiment',
    };
  }

  getAssignments(): readonly VariantRef[] {
    return [...this.assignments.values()].map(a => ({
      artifactId: a.artifactId,
      variantId: a.variantId,
      baseHash: a.baseHash,
      evidenceRef: a.evidenceRef,
    }));
  }

  async recordRunOutcome(outcome: RunOutcome): Promise<void> {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      const file = path.join(this.runsDir, `${sanitizeFileId(this.sessionId)}.jsonl`);
      const line = JSON.stringify(outcome) + '\n';
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      logger.services.warn(
        `[experiments] failed to record run outcome: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private loadCatalog(): Catalog {
    try {
      if (!fs.existsSync(this.catalogPath)) {
        return parseCatalog('{"format":"kc.experiments.v1","artifacts":{}}');
      }
      const raw = fs.readFileSync(this.catalogPath, 'utf8');
      return parseCatalog(raw);
    } catch (err) {
      logger.services.warn(
        `[experiments] failed to read catalog: ${err instanceof Error ? err.message : String(err)}`
      );
      return parseCatalog('{"format":"kc.experiments.v1","artifacts":{}}');
    }
  }

  private assignPrompts(catalog: Catalog): void {
    for (const [name, baselineText] of Object.entries(this.promptSurfaceBaselines)) {
      const artifactId = artifactIdForPromptSurface(name);
      const artifact = catalog.artifacts[artifactId];
      if (!artifact) continue;
      const expectedHash = computeBaseHash(baselineText);
      if (artifact.baseHash && artifact.baseHash !== expectedHash) {
        logger.services.warn(
          `[experiments] catalog baseHash mismatch for ${artifactId}; skipping overlay`
        );
        continue;
      }
      const variant = getActivePromotedVariant(catalog, artifactId);
      if (!variant || typeof variant.payload !== 'string') continue;
      // P2 canary: serve overlay only to the bucket; never mutates catalog.active.
      if (!isInCanaryBucket(this.sessionId, artifactId, artifact, this.forceCanaryBucket)) {
        continue;
      }
      this.assignments.set(artifactId, {
        artifactId,
        variantId: variant.variantId,
        baseHash: expectedHash,
        evidenceRef: variant.evidenceRef,
        payload: variant.payload,
      });
    }
  }

  private assignPolicy(catalog: Catalog): void {
    const artifact = catalog.artifacts[POLICY_ARTIFACT_ID];
    if (!artifact) return;
    const expectedHash = computeBaseHashJson(this.runtimePolicyBaseline);
    if (artifact.baseHash && artifact.baseHash !== expectedHash) {
      logger.services.warn(
        `[experiments] catalog baseHash mismatch for ${POLICY_ARTIFACT_ID}; skipping overlay`
      );
      return;
    }
    const variant = getActivePromotedVariant(catalog, POLICY_ARTIFACT_ID);
    if (!variant) return;
    if (typeof variant.payload === 'string') return;
    if (!isInCanaryBucket(this.sessionId, POLICY_ARTIFACT_ID, artifact, this.forceCanaryBucket)) {
      return;
    }
    this.assignments.set(POLICY_ARTIFACT_ID, {
      artifactId: POLICY_ARTIFACT_ID,
      variantId: variant.variantId,
      baseHash: expectedHash,
      evidenceRef: variant.evidenceRef,
      payload: variant.payload,
    });
  }
}

function sanitizeFileId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
}

/**
 * Factory used by Bootstrap. Disabled → pure no-op (zero disk IO).
 */
export function createExperimentRuntime(options: FileExperimentRuntimeOptions): ExperimentRuntime {
  if (!options.enabled) {
    return createNoopExperimentRuntime();
  }
  return new FileExperimentRuntime(options);
}
