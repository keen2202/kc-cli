/**
 * SEPL Select Operator (σ)
 *
 * Takes hypotheses from Reflect and determines which evolvable variables
 * to modify, generating concrete modification proposals.
 *
 * σ : (S, H) → (S, D)
 * Input: HypothesisSpace
 * Output: ModificationSpace
 *
 * Corresponds to the paper's Select operator (§4.2).
 */

import type {
  SEPLOperator,
  SEPLOutput,
  EvolvableState,
  Hypothesis,
  HypothesisSpace,
  ModificationSpace,
  Modification,
} from './protocol';
import { generateModificationId } from './protocol';

// ─── Select Operator ─────────────────────────────────────────────────────────

export class SelectOperator implements SEPLOperator<HypothesisSpace, ModificationSpace> {
  readonly name = 'Select';

  /** Maximum modifications per hypothesis */
  private maxModificationsPerHypothesis: number;
  /** Minimum confidence threshold */
  private confidenceThreshold: number;

  constructor(options?: { maxModificationsPerHypothesis?: number; confidenceThreshold?: number }) {
    this.maxModificationsPerHypothesis = options?.maxModificationsPerHypothesis ?? 3;
    this.confidenceThreshold = options?.confidenceThreshold ?? 0.3;
  }

  async execute(
    state: EvolvableState,
    input: HypothesisSpace
  ): Promise<SEPLOutput<ModificationSpace>> {
    const startTime = Date.now();

    try {
      // Filter hypotheses by confidence threshold
      const viableHypotheses = input.hypotheses
        .filter(h => h.confidence >= this.confidenceThreshold)
        .slice(0, 5); // Top 5 hypotheses

      if (viableHypotheses.length === 0) {
        return {
          state,
          output: { modifications: [], sourceHypothesisId: '' },
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      const allModifications: Modification[] = [];

      for (const hypothesis of viableHypotheses) {
        const mods = this.generateModifications(hypothesis, state);
        allModifications.push(...mods.slice(0, this.maxModificationsPerHypothesis));
      }

      // Sort by estimated impact descending
      allModifications.sort((a, b) => b.estimatedImpact - a.estimatedImpact);

      return {
        state,
        output: {
          modifications: allModifications,
          sourceHypothesisId: viableHypotheses[0].id,
        },
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        state,
        output: { modifications: [], sourceHypothesisId: '' },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Generate concrete modifications from a hypothesis.
   */
  private generateModifications(
    hypothesis: Hypothesis,
    state: EvolvableState
  ): Modification[] {
    const modifications: Modification[] = [];

    // Find evolvable variables matching the hypothesis's suspected resources
    const relevantVars = this.findRelevantVariables(hypothesis, state);

    for (const [varKey, variable] of relevantVars) {
      if (variable.learnability !== 1) continue;

      const mod = this.createModification(hypothesis, variable, varKey);
      if (mod) {
        modifications.push(mod);
      }
    }

    // If no specific variables matched, target description fields of implicated resources
    if (modifications.length === 0 && hypothesis.suspectedResources.length > 0) {
      for (const resource of hypothesis.suspectedResources) {
        const descKey = `${resource}:description`;
        const variable = state.variables.get(descKey);
        if (variable && variable.learnability === 1) {
          modifications.push({
            id: generateModificationId(),
            hypothesisId: hypothesis.id,
            targetResource: resource,
            resourceType: variable.resourceType,
            changeType: 'description_update',
            proposedValue: variable.currentValue, // Will be refined by Improve
            estimatedImpact: hypothesis.confidence * 0.5,
            riskLevel: 'low',
          });
        }
      }
    }

    return modifications;
  }

  /**
   * Find evolvable variables relevant to a hypothesis.
   */
  private findRelevantVariables(
    hypothesis: Hypothesis,
    state: EvolvableState
  ): Array<[string, import('./protocol').EvolvableVariable]> {
    const relevant: Array<[string, import('./protocol').EvolvableVariable]> = [];

    for (const varKey of state.trainableSubset) {
      const variable = state.variables.get(varKey);
      if (!variable) continue;

      // Check if the variable's resource is implicated
      const resourceMatch = hypothesis.suspectedResources.some(
        (r: string) => varKey.startsWith(r)
      );

      // Check if the variable's type is implicated
      const typeMatch = hypothesis.implicatedTypes.includes(variable.resourceType);

      if (resourceMatch || typeMatch) {
        relevant.push([varKey, variable]);
      }
    }

    return relevant;
  }

  /**
   * Create a modification proposal for a specific variable.
   */
  private createModification(
    hypothesis: Hypothesis,
    variable: import('./protocol').EvolvableVariable,
    varKey: string
  ): Modification | null {
    const changeType = this.inferChangeType(variable);
    const riskLevel = this.assessRisk(variable, changeType);

    return {
      id: generateModificationId(),
      hypothesisId: hypothesis.id,
      targetResource: variable.resourceId,
      resourceType: variable.resourceType,
      changeType,
      proposedValue: variable.currentValue, // Improve operator will refine this
      estimatedImpact: hypothesis.confidence * this.impactMultiplier(variable),
      riskLevel,
    };
  }

  private inferChangeType(variable: import('./protocol').EvolvableVariable): Modification['changeType'] {
    switch (variable.variableName) {
      case 'template':
      case 'systemPrompt':
        return 'template_rewrite';
      case 'description':
        return 'description_update';
      default:
        return variable.valueType === 'string' || variable.valueType === 'template'
          ? 'variable_update'
          : 'metadata_update';
    }
  }

  private assessRisk(
    variable: import('./protocol').EvolvableVariable,
    changeType: Modification['changeType']
  ): Modification['riskLevel'] {
    // Template rewrites are higher risk
    if (changeType === 'template_rewrite') return 'medium';
    // Tool config changes are higher risk
    if (variable.resourceType === 'Tool') return 'medium';
    // Metadata changes are generally low risk
    if (changeType === 'metadata_update') return 'low';
    return 'low';
  }

  private impactMultiplier(variable: import('./protocol').EvolvableVariable): number {
    // Prompts have higher impact potential
    if (variable.resourceType === 'Prompt') return 1.0;
    if (variable.resourceType === 'Agent') return 0.9;
    if (variable.resourceType === 'Mem') return 0.7;
    return 0.5;
  }
}
