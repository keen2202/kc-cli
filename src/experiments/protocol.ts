// Core experiment runtime port — default-off, catalog-read-only.
// Core never imports scripts/agp or src/agp. Offline lab implements this port.

export type ArtifactKind = 'prompt-surface' | 'runtime-policy';

export interface VariantRef {
  artifactId: string;
  variantId: string;
  baseHash: string;
  evidenceRef: string;
}

export interface ResolvedVariant<T> {
  value: T;
  artifactId: string;
  /** null = baseline (code default). */
  variantId: string | null;
  baseHash: string;
  source: 'baseline' | 'experiment';
}

/** Bounded runtime-policy overlay payload (allowlist fields only). */
export interface RuntimePolicyOverlay {
  maxSameCallRetries?: number;
  retryIntervention?: 'soft' | 'hard';
  maxReadOnlyStreak?: number;
  maxTotalToolMessages?: number;
  redirectInstruction?: string;
}

export interface RunOutcome {
  runId: string;
  sessionId: string;
  taskId?: string;
  artifactAssignments: VariantRef[];
  success: boolean;
  verified: boolean;
  patchFiles: string[];
  verificationCommand?: string;
  verificationExitCode?: number;
  turns: number;
  noPatch: boolean;
  costUsd?: number;
  errorCode?: string;
  timestamp: number;
}

export interface ExperimentRuntime {
  /** Session-start lock of active variants. Never throws into the main loop. */
  initialize(): void;
  resolvePromptSurface(name: string, base: string): ResolvedVariant<string>;
  resolveRuntimePolicy<T extends RuntimePolicyOverlay>(base: T): ResolvedVariant<T>;
  getAssignments(): readonly VariantRef[];
  recordRunOutcome(outcome: RunOutcome): Promise<void>;
}

/** Baseline no-op used when experiments are disabled or catalog is unusable. */
export function createNoopExperimentRuntime(): ExperimentRuntime {
  return {
    initialize(): void {
      /* no-op */
    },
    resolvePromptSurface(name, base): ResolvedVariant<string> {
      return {
        value: base,
        artifactId: `prompt-surface:${name}`,
        variantId: null,
        baseHash: '',
        source: 'baseline',
      };
    },
    resolveRuntimePolicy<T extends RuntimePolicyOverlay>(base: T): ResolvedVariant<T> {
      return {
        value: base,
        artifactId: 'runtime-policy:default',
        variantId: null,
        baseHash: '',
        source: 'baseline',
      };
    },
    getAssignments(): readonly VariantRef[] {
      return [];
    },
    async recordRunOutcome(): Promise<void> {
      /* no-op */
    },
  };
}
