/**
 * SEPL Commit Operator (κ)
 *
 * Based on evaluation results, either accepts the evolved state
 * (creating a versioned update + audit entry) or rejects it (rollback).
 *
 * κ : (S', S_eval) → (S'', {accept, reject})
 * Input: EvaluationSpace
 * Output: Committed or rolled-back state
 *
 * Corresponds to the paper's Commit operator (§4.5).
 */

import type { ServerInterface } from '../server-interface';
import type { VersionManager } from '../version-manager';
import type {
  SEPLOperator,
  SEPLOutput,
  EvolvableState,
  EvaluationSpace,
} from './protocol';

// ─── Commit Decision ─────────────────────────────────────────────────────────

export interface CommitDecision {
  /** Whether changes were accepted */
  accepted: boolean;
  /** Resources that were committed */
  committedResources: string[];
  /** Resources that were rolled back */
  rolledBackResources: string[];
  /** New version strings for committed resources */
  newVersions: Map<string, string>;
  /** Reason for the decision */
  reason: string;
  /** Timestamp */
  timestamp: number;
}

// ─── Commit Operator ─────────────────────────────────────────────────────────

export class CommitOperator implements SEPLOperator<EvaluationSpace, CommitDecision> {
  readonly name = 'Commit';

  private serverInterface: ServerInterface;
  private versionManager: VersionManager;
  private autoRollback: boolean;
  /** Snapshot of baseline versions at evolution cycle start (FUN-10) */
  private baselineVersions: Map<string, string> = new Map();

  constructor(
    serverInterface: ServerInterface,
    versionManager: VersionManager,
    autoRollback = true
  ) {
    this.serverInterface = serverInterface;
    this.versionManager = versionManager;
    this.autoRollback = autoRollback;
  }

  async execute(
    state: EvolvableState,
    input: EvaluationSpace
  ): Promise<SEPLOutput<CommitDecision>> {
    const startTime = Date.now();

    // Snapshot baseline versions at evolution cycle start (FUN-10)
    this.baselineVersions.clear();
    for (const varKey of state.trainableSubset) {
      const variable = state.variables.get(varKey);
      if (!variable) continue;
      const resourceName = variable.resourceId.split(':')[1];
      const activeVersion = this.versionManager.getActiveVersion(variable.resourceType, resourceName);
      if (activeVersion) {
        this.baselineVersions.set(`${variable.resourceType}:${resourceName}`, activeVersion);
      }
    }

    try {
      if (input.bestCandidateIndex < 0 || input.results.length === 0) {
        // No acceptable candidates — rollback if configured
        if (this.autoRollback) {
          await this.rollbackAll(state);
        }

        return {
          state,
          output: {
            accepted: false,
            committedResources: [],
            rolledBackResources: [],
            newVersions: new Map(),
            reason: 'No candidates passed evaluation',
            timestamp: Date.now(),
          },
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      // Find all accepted candidates
      const acceptedResults = input.results.filter(r => r.accepted);

      if (acceptedResults.length === 0) {
        return {
          state,
          output: {
            accepted: false,
            committedResources: [],
            rolledBackResources: [],
            newVersions: new Map(),
            reason: 'All candidates rejected',
            timestamp: Date.now(),
          },
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      // Commit accepted changes
      const committedResources: string[] = [];
      const newVersions = new Map<string, string>();

      for (const result of acceptedResults) {
        // Extract resource info from the summary
        const match = result.summary.match(/on\s+(\S+)/);
        if (match) {
          const resource = match[1];
          committedResources.push(resource);
        }
      }

      // Create version snapshots for committed resources
      for (const varKey of state.trainableSubset) {
        const variable = state.variables.get(varKey);
        if (!variable) continue;

        const resourceId = variable.resourceId;
        if (!committedResources.some(r => r === resourceId || resourceId.includes(r))) continue;

        try {
          const record: import('../protocol').ResourceRegistrationRecord = {
            entity: {
              name: resourceId.split(':')[1],
              description: String(variable.currentValue),
              ioMapping: {},
              evolvability: variable.learnability,
              metadata: {} as any,
            },
            version: this.versionManager.nextVersion(variable.resourceType, resourceId.split(':')[1]),
            implementationDescriptor: `sepl/evolved/${resourceId}`,
            instantiationParams: { [variable.variableName]: variable.currentValue },
            exportedRepresentations: [],
          };

          const snapshot = this.versionManager.createSnapshot(record, {
            resourceType: variable.resourceType,
            commitMessage: `SEPL evolution: ${variable.variableName} updated`,
          });

          if (snapshot) {
            newVersions.set(resourceId, snapshot.version);
          }
        } catch {
          // Version snapshot is best-effort
        }
      }

      return {
        state,
        output: {
          accepted: true,
          committedResources,
          rolledBackResources: [],
          newVersions,
          reason: `${committedResources.length} resource(s) committed after passing evaluation`,
          timestamp: Date.now(),
        },
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // On unexpected error, rollback
      if (this.autoRollback) {
        await this.rollbackAll(state);
      }

      return {
        state,
        output: {
          accepted: false,
          committedResources: [],
          rolledBackResources: [],
          newVersions: new Map(),
          reason: `Commit failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Rollback all changes in the evolvable state to their baseline versions (FUN-10).
   */
  private async rollbackAll(state: EvolvableState): Promise<void> {
    for (const varKey of state.trainableSubset) {
      const variable = state.variables.get(varKey);
      if (!variable) continue;

      try {
        // Attempt to restore via ServerInterface to the baseline version
        const resourceName = variable.resourceId.split(':')[1];
        const key = `${variable.resourceType}:${resourceName}`;
        const baselineVersion = this.baselineVersions.get(key);
        if (baselineVersion) {
          this.serverInterface.restore(variable.resourceType, resourceName, baselineVersion);
        }
      } catch {
        // Best effort rollback
      }
    }
  }

  /**
   * Rollback a specific resource to a previous version.
   */
  async rollbackResource(resourceType: string, resourceName: string, targetVersion?: string): Promise<boolean> {
    try {
      if (targetVersion) {
        this.versionManager.rollback(resourceType as any, resourceName, targetVersion);
      } else {
        // Rollback to the most recent previous version
        const lineage = this.versionManager.getLineage(resourceType as any, resourceName);
        if (lineage.length > 1) {
          // Rollback to the previous version (one before the latest)
          this.versionManager.rollback(resourceType as any, resourceName, lineage[lineage.length - 2].version);
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
