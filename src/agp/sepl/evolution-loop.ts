/**
 * SEPL Evolution Loop — Orchestrator
 *
 * Implements AGP Algorithm 1: the complete self-evolution cycle.
 *
 *   Execute → [Reflect → Select → Improve → Evaluate → Commit] × T
 *
 * Where T is the number of allowed iterations (budget).
 *
 * This orchestrator:
 * 1. Captures execution traces (from TraceManager)
 * 2. Runs the SEPL operator pipeline
 * 3. Tracks evolution state across iterations
 * 4. Handles auto-rollback on failures
 * 5. Produces audit-ready cycle results
 */

import type { TraceManager } from '../trace-manager';
import type { ServerInterface } from '../server-interface';
import type { VersionManager } from '../version-manager';
import type {
  SEPLConfig,
  EvolutionCycleState,
  EvolutionCycleResult,
  EvolvableState,
  TraceSpace,
} from './protocol';
import { DEFAULT_SEPL_CONFIG, createEmptyEvolvableState, buildEvolvableState } from './protocol';
import { ReflectOperator, buildTraceSpace } from './reflect';
import { SelectOperator } from './select';
import { ImproveOperator } from './improve';
import { EvaluateOperator } from './evaluate';
import { CommitOperator, type CommitDecision } from './commit';
import type { ResourceType, ResourceRegistrationRecord } from '../protocol';

// ─── Evolution Loop ──────────────────────────────────────────────────────────

export interface EvolutionLoopDeps {
  traceManager: TraceManager;
  serverInterface: ServerInterface;
  versionManager: VersionManager;
}

export class EvolutionLoop {
  private config: SEPLConfig;
  private deps: EvolutionLoopDeps;
  private operators: {
    reflect: ReflectOperator;
    select: SelectOperator;
    improve: ImproveOperator;
    evaluate: EvaluateOperator;
    commit: CommitOperator;
  };

  /** History of completed cycles */
  private cycleHistory: EvolutionCycleResult[] = [];

  constructor(deps: EvolutionLoopDeps, config?: Partial<SEPLConfig>) {
    this.config = { ...DEFAULT_SEPL_CONFIG, ...config };
    this.deps = deps;

    // Initialize operators
    this.operators = {
      reflect: new ReflectOperator(deps.traceManager),
      select: new SelectOperator(),
      improve: new ImproveOperator(deps.serverInterface),
      evaluate: new EvaluateOperator(this.config.objective, deps.traceManager),
      commit: new CommitOperator(
        deps.serverInterface,
        deps.versionManager,
        this.config.autoRollback,
        this.config.acceptanceGate // harness-evolution T4 (disabled by default)
      ),
    };
  }

  /**
   * Run a complete evolution cycle.
   *
   * This is the main entry point. It runs the SEPL pipeline for up to
   * `maxIterations` iterations or until no more improvements are found.
   */
  async run(
    evolvableState?: EvolvableState,
    sessionId?: string
  ): Promise<EvolutionCycleResult[]> {
    const results: EvolutionCycleResult[] = [];

    // Build initial evolvable state if not provided
    let state = evolvableState ?? this.buildStateFromRegistry();

    // Filter to target resources if configured
    if (this.config.targetResources.length > 0) {
      state = this.filterToTargets(state);
    }

    // Run iterations
    for (let i = 0; i < this.config.maxIterations; i++) {
      const cycleState: EvolutionCycleState = {
        iteration: i,
        evolvableState: state,
        traces: null,
        hypotheses: null,
        modifications: null,
        evaluation: null,
        committed: false,
        startedAt: Date.now(),
        errors: [],
      };

      try {
        const result = await this.runSingleCycle(cycleState, sessionId);
        results.push(result);
        this.cycleHistory.push(result);

        // Update state for next iteration
        state = cycleState.evolvableState;

        // Stop if committed (successful evolution)
        if (result.committed) break;

        // Stop if no modifications were generated (nothing to evolve)
        if (!cycleState.modifications || cycleState.modifications.modifications.length === 0) {
          break;
        }
      } catch (error) {
        results.push({
          iteration: i,
          committed: false,
          committedResources: [],
          durationMs: Date.now() - cycleState.startedAt,
          rolledBack: this.config.autoRollback,
        });
        break;
      }
    }

    return results;
  }

  /**
   * Run a single evolution cycle iteration.
   */
  private async runSingleCycle(
    cycle: EvolutionCycleState,
    sessionId?: string
  ): Promise<EvolutionCycleResult> {
    const startTime = Date.now();

    // Step 1: Reflect — gather traces and generate hypotheses
    const traceSpace = buildTraceSpace(this.deps.traceManager, sessionId);
    cycle.traces = traceSpace;

    const reflectResult = await this.withTimeout(
      this.operators.reflect.execute(cycle.evolvableState, traceSpace),
      this.config.operatorTimeoutMs
    );

    if (!reflectResult.success) {
      cycle.errors.push(`Reflect failed: ${reflectResult.error}`);
      return this.buildCycleResult(cycle, startTime, false);
    }

    cycle.hypotheses = reflectResult.output;
    cycle.evolvableState = reflectResult.state;

    if (reflectResult.output.hypotheses.length === 0) {
      return this.buildCycleResult(cycle, startTime, false);
    }

    // Step 2: Select — determine what to modify
    const selectResult = await this.withTimeout(
      this.operators.select.execute(cycle.evolvableState, reflectResult.output),
      this.config.operatorTimeoutMs
    );

    if (!selectResult.success) {
      cycle.errors.push(`Select failed: ${selectResult.error}`);
      return this.buildCycleResult(cycle, startTime, false);
    }

    cycle.modifications = selectResult.output;
    cycle.evolvableState = selectResult.state;

    if (selectResult.output.modifications.length === 0) {
      return this.buildCycleResult(cycle, startTime, false);
    }

    // Step 3: Improve — apply modifications
    const improveResult = await this.withTimeout(
      this.operators.improve.execute(cycle.evolvableState, selectResult.output),
      this.config.operatorTimeoutMs
    );

    if (!improveResult.success) {
      cycle.errors.push(`Improve failed: ${improveResult.error}`);
      return this.buildCycleResult(cycle, startTime, false);
    }

    cycle.evolvableState = improveResult.state;

    // Step 4: Evaluate — score candidates
    const evaluateResult = await this.withTimeout(
      this.operators.evaluate.execute(cycle.evolvableState, improveResult.output),
      this.config.operatorTimeoutMs
    );

    if (!evaluateResult.success) {
      cycle.errors.push(`Evaluate failed: ${evaluateResult.error}`);
      return this.buildCycleResult(cycle, startTime, false);
    }

    cycle.evaluation = evaluateResult.output;
    cycle.evolvableState = evaluateResult.state;

    // Step 5: Commit — accept or rollback
    const commitResult = await this.withTimeout(
      this.operators.commit.execute(cycle.evolvableState, evaluateResult.output),
      this.config.operatorTimeoutMs
    );

    const commitDecision = commitResult.output;
    cycle.committed = commitDecision.accepted;

    return this.buildCycleResult(cycle, startTime, commitDecision.accepted, commitDecision);
  }

  /**
   * Build a cycle result from the cycle state.
   */
  private buildCycleResult(
    cycle: EvolutionCycleState,
    startTime: number,
    committed: boolean,
    decision?: CommitDecision
  ): EvolutionCycleResult {
    return {
      iteration: cycle.iteration,
      committed,
      committedResources: decision?.committedResources ?? [],
      evaluationSummary: cycle.evaluation?.results
        .filter(r => r.accepted)
        .map(r => r.summary)
        .join('; '),
      durationMs: Date.now() - startTime,
      rolledBack: !committed && this.config.autoRollback,
    };
  }

  /**
   * Build evolvable state from the current registry state.
   */
  private buildStateFromRegistry(): EvolvableState {
    const allRecords: Array<{ record: ResourceRegistrationRecord; resourceType: ResourceType }> = [];

    // Gather all resources from the server interface
    const allResources = this.deps.serverInterface.listAll();
    for (const { type, name } of allResources) {
      try {
        const resp = this.deps.serverInterface.get_info(type, name);
        if (resp.success && resp.data && resp.data.record.entity.evolvability === 1) {
          allRecords.push({ record: resp.data.record, resourceType: type });
        }
      } catch {
        // Skip resources that can't be accessed
      }
    }

    return buildEvolvableState(allRecords);
  }

  /**
   * Filter evolvable state to only include target resources.
   */
  private filterToTargets(state: EvolvableState): EvolvableState {
    const filtered = new Map<string, import('./protocol').EvolvableVariable>();
    const trainable: string[] = [];

    for (const [key, variable] of state.variables) {
      const isTarget = this.config.targetResources.some(
        t => variable.resourceId === t || key.startsWith(t)
      );
      if (isTarget) {
        filtered.set(key, variable);
        if (variable.learnability === 1) trainable.push(key);
      }
    }

    return { variables: filtered, trainableSubset: trainable };
  }

  /**
   * Run a promise with a timeout.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operator timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        result => {
          clearTimeout(timer);
          resolve(result);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /** Get the cycle history */
  getHistory(): EvolutionCycleResult[] {
    return [...this.cycleHistory];
  }

  /** Get the SEPL config */
  getConfig(): SEPLConfig {
    return { ...this.config };
  }

  /** Update the SEPL config */
  updateConfig(updates: Partial<SEPLConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** Clear cycle history */
  clearHistory(): void {
    this.cycleHistory = [];
  }
}
