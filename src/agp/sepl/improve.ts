/**
 * SEPL Improve Operator (ι)
 *
 * Takes modification proposals from Select and applies them to the
 * evolvable state via the RSPL ServerInterface, generating candidate states.
 *
 * ι : (S, D) → (S', D')
 * Input: ModificationSpace
 * Output: Updated EvolvableState + applied modifications
 *
 * Corresponds to the paper's Improve operator (§4.3).
 */

import type { ServerInterface } from '../server-interface';
import type {
  SEPLOperator,
  SEPLOutput,
  EvolvableState,
  ModificationSpace,
  Modification,
} from './protocol';
import type { ResourceType } from '../protocol';

// ─── Improve Operator ────────────────────────────────────────────────────────

export class ImproveOperator implements SEPLOperator<ModificationSpace, ModificationSpace> {
  readonly name = 'Improve';

  private serverInterface: ServerInterface;
  private improvers: Map<string, ImproverFn> = new Map();

  constructor(serverInterface: ServerInterface) {
    this.serverInterface = serverInterface;
    this.registerDefaultImprovers();
  }

  async execute(
    state: EvolvableState,
    input: ModificationSpace
  ): Promise<SEPLOutput<ModificationSpace>> {
    const startTime = Date.now();

    try {
      const appliedModifications: Modification[] = [];
      const newState = this.cloneState(state);

      // Apply modifications in order of estimated impact
      for (const mod of input.modifications) {
        try {
          const applied = await this.applyModification(newState, mod);
          if (applied) {
            appliedModifications.push(applied);
          }
        } catch {
          // Skip modifications that fail to apply
        }
      }

      return {
        state: newState,
        output: {
          modifications: appliedModifications,
          sourceHypothesisId: input.sourceHypothesisId,
        },
        success: appliedModifications.length > 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        state,
        output: { modifications: [], sourceHypothesisId: input.sourceHypothesisId },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Apply a single modification to the evolvable state.
   */
  private async applyModification(
    state: EvolvableState,
    mod: Modification
  ): Promise<Modification | null> {
    // Find the target variable
    const varKeys = this.findVariableKeysForResource(state, mod.targetResource, mod.changeType);
    if (varKeys.length === 0) return null;

    for (const varKey of varKeys) {
      const variable = state.variables.get(varKey);
      if (!variable || variable.learnability !== 1) continue;

      // Get the appropriate improver
      const improver = this.improvers.get(mod.changeType) ?? this.improvers.get('default');
      if (!improver) continue;

      // Generate improved value
      const improvedValue = await improver(variable.currentValue, mod, variable);
      if (improvedValue === null || improvedValue === undefined) continue;

      // Validate bounds
      if (!this.validateBounds(improvedValue, variable)) continue;

      // Update the variable in state
      state.variables.set(varKey, {
        ...variable,
        currentValue: improvedValue,
      });

      // Also update via ServerInterface for RSPL consistency
      try {
        await this.syncToRegistry(mod, varKey, improvedValue);
      } catch {
        // ServerInterface sync is best-effort
      }

      return { ...mod, proposedValue: improvedValue };
    }

    return null;
  }

  /**
   * Sync a change to the RSPL ServerInterface.
   */
  private async syncToRegistry(
    mod: Modification,
    varKey: string,
    value: unknown
  ): Promise<void> {
    const varName = varKey.split(':').pop()!;
    // Use set_variables to update the resource
    this.serverInterface.set_variables(mod.resourceType, mod.targetResource.split(':')[1], {
      [varName]: value,
    });
  }

  /**
   * Find variable keys in state matching a resource and change type.
   */
  private findVariableKeysForResource(
    state: EvolvableState,
    targetResource: string,
    changeType: Modification['changeType']
  ): string[] {
    const keys: string[] = [];
    for (const varKey of state.trainableSubset) {
      if (!varKey.startsWith(targetResource)) continue;
      const variable = state.variables.get(varKey);
      if (!variable) continue;

      switch (changeType) {
        case 'template_rewrite':
          if (['template', 'systemPrompt'].includes(variable.variableName)) keys.push(varKey);
          break;
        case 'description_update':
          if (variable.variableName === 'description') keys.push(varKey);
          break;
        case 'variable_update':
        case 'metadata_update':
          keys.push(varKey);
          break;
      }
    }
    return keys;
  }

  /**
   * Validate that a value is within configured bounds.
   */
  private validateBounds(value: unknown, variable: import('./protocol').EvolvableVariable): boolean {
    if (!variable.bounds) return true;
    if (typeof value !== 'number') return true;
    if (variable.bounds.min !== undefined && value < variable.bounds.min) return false;
    if (variable.bounds.max !== undefined && value > variable.bounds.max) return false;
    return true;
  }

  /**
   * Clone an evolvable state for safe mutation.
   */
  private cloneState(state: EvolvableState): EvolvableState {
    const variables = new Map<string, import('./protocol').EvolvableVariable>();
    for (const [key, value] of state.variables) {
      variables.set(key, { ...value });
    }
    return { variables, trainableSubset: [...state.trainableSubset] };
  }

  // ─── Default Improvers ───────────────────────────────────────────────────

  private registerDefaultImprovers(): void {
    // Template rewrite: append guidance hints
    this.improvers.set('template_rewrite', async (currentValue, mod) => {
      if (typeof currentValue !== 'string') return null;
      // Add a refinement hint based on the hypothesis
      const hint = `\n[Refinement] ${mod.hypothesisId}: Address identified issue.`;
      return currentValue + hint;
    });

    // Description update: refine description
    this.improvers.set('description_update', async (currentValue, mod) => {
      if (typeof currentValue !== 'string') return null;
      return currentValue; // Description changes need LLM — return as-is for now
    });

    // Variable update: adjust numeric/boolean values
    this.improvers.set('variable_update', async (currentValue, mod, variable) => {
      if (typeof currentValue === 'number') {
        // Small perturbation towards improvement
        const delta = currentValue * 0.1 * (Math.random() > 0.5 ? 1 : -1);
        return currentValue + delta;
      }
      if (typeof currentValue === 'boolean') {
        return !currentValue; // Toggle boolean
      }
      return currentValue;
    });

    // Metadata update: pass through (requires domain-specific logic)
    this.improvers.set('metadata_update', async (currentValue) => currentValue);

    // Default: no change
    this.improvers.set('default', async (currentValue) => currentValue);
  }

  /**
   * Register a custom improver function for a change type.
   */
  registerImprover(changeType: string, improver: ImproverFn): void {
    this.improvers.set(changeType, improver);
  }
}

// ─── Improver Function Type ──────────────────────────────────────────────────

/**
 * A function that generates an improved value for a variable.
 * Returns null if improvement is not possible.
 */
export type ImproverFn = (
  currentValue: unknown,
  modification: Modification,
  variable: import('./protocol').EvolvableVariable
) => Promise<unknown | null>;
