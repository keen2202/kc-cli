/**
 * AGP Strategy: Solution Evolution
 *
 * Reflective solution optimization strategy.
 * Analyzes failed or suboptimal solutions and generates improved
 * approaches through structured reflection.
 *
 * Strategy:
 * 1. Identify failed/suboptimal solution attempts from traces
 * 2. Analyze failure patterns and root causes
 * 3. Generate alternative solution approaches
 * 4. Evaluate alternatives against original outcomes
 * 5. Commit best alternative or rollback
 */

import type { ServerInterface } from '../server-interface';
import type { TraceManager } from '../trace-manager';
import type { EvolutionCycleResult } from '../sepl/protocol';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SolutionEvolutionConfig {
  /** Maximum solution variants to generate */
  maxVariants: number;
  /** Minimum improvement threshold to commit */
  improvementThreshold: number;
  /** Target agent resource names */
  targetAgents: string[];
}

export interface SolutionVariant {
  /** Variant ID */
  id: string;
  /** Description of the approach */
  approach: string;
  /** Agent resource this variant targets */
  agentResource: string;
  /** Estimated success probability */
  estimatedSuccess: number;
  /** Whether this variant was evaluated */
  evaluated: boolean;
  /** Actual score after evaluation */
  actualScore?: number;
}

export interface SolutionEvolutionResult {
  /** Whether a better solution was found */
  improved: boolean;
  /** Generated variants */
  variants: SolutionVariant[];
  /** Best variant (if any) */
  bestVariant?: SolutionVariant;
  /** Evolution cycle results */
  cycleResults: EvolutionCycleResult[];
}

const DEFAULT_CONFIG: SolutionEvolutionConfig = {
  maxVariants: 3,
  improvementThreshold: 0.1,
  targetAgents: [],
};

// ─── Strategy Implementation ─────────────────────────────────────────────────

export class SolutionEvolutionStrategy {
  private config: SolutionEvolutionConfig;
  private serverInterface: ServerInterface;
  private traceManager: TraceManager;
  private variantCounter = 0;

  constructor(
    serverInterface: ServerInterface,
    traceManager: TraceManager,
    config?: Partial<SolutionEvolutionConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serverInterface = serverInterface;
    this.traceManager = traceManager;
  }

  /**
   * Run the solution evolution strategy.
   * Analyzes failed solutions and generates improved alternatives.
   */
  async evolve(): Promise<SolutionEvolutionResult> {
    // 1. Identify failure patterns
    const failurePatterns = this.identifyFailurePatterns();

    if (failurePatterns.length === 0) {
      return { improved: false, variants: [], cycleResults: [] };
    }

    // 2. Generate solution variants
    const variants = this.generateVariants(failurePatterns);

    if (variants.length === 0) {
      return { improved: false, variants: [], cycleResults: [] };
    }

    // 3. Evaluate variants
    const evaluatedVariants = this.evaluateVariants(variants);

    // 4. Find best variant
    const bestVariant = evaluatedVariants
      .filter(v => v.evaluated && v.actualScore !== undefined)
      .sort((a, b) => (b.actualScore ?? 0) - (a.actualScore ?? 0))[0];

    // 5. Commit if improvement exceeds threshold
    const improved = bestVariant !== undefined &&
      (bestVariant.actualScore ?? 0) > this.config.improvementThreshold;

    if (improved && bestVariant) {
      await this.commitVariant(bestVariant);
    }

    return {
      improved,
      variants: evaluatedVariants,
      bestVariant: improved ? bestVariant : undefined,
      cycleResults: [],
    };
  }

  /**
   * Identify failure patterns from recent execution traces.
   */
  private identifyFailurePatterns(): Array<{
    pattern: string;
    occurrences: number;
    affectedAgents: string[];
  }> {
    const errors = this.traceManager.getErrors(20);
    const summary = this.traceManager.generateExecutionSummary();

    const patterns: Array<{
      pattern: string;
      occurrences: number;
      affectedAgents: string[];
    }> = [];

    // Extract patterns from failure data
    for (const [message, count] of summary.failurePatterns) {
      if (count < 2) continue; // Only recurring patterns

      const affectedAgents = errors
        .filter(e => e.errorMessage === message || e.message === message)
        .map(e => e.source)
        .filter((v, i, a) => a.indexOf(v) === i);

      // Filter to target agents if configured
      const filteredAgents = this.config.targetAgents.length > 0
        ? affectedAgents.filter(a => this.config.targetAgents.includes(a))
        : affectedAgents;

      if (filteredAgents.length > 0) {
        patterns.push({
          pattern: message,
          occurrences: count,
          affectedAgents: filteredAgents,
        });
      }
    }

    return patterns.sort((a, b) => b.occurrences - a.occurrences).slice(0, 5);
  }

  /**
   * Generate solution variants for identified failure patterns.
   */
  private generateVariants(
    patterns: Array<{ pattern: string; occurrences: number; affectedAgents: string[] }>
  ): SolutionVariant[] {
    const variants: SolutionVariant[] = [];

    for (const pattern of patterns) {
      for (const agent of pattern.affectedAgents) {
        if (variants.length >= this.config.maxVariants) break;

        // Generate a variant that addresses this specific failure
        const approach = this.generateApproach(pattern.pattern, agent);

        variants.push({
          id: `sol_var_${++this.variantCounter}`,
          approach,
          agentResource: agent,
          estimatedSuccess: Math.min(0.9, 0.3 + pattern.occurrences * 0.1),
          evaluated: false,
        });
      }
    }

    return variants;
  }

  /**
   * Generate an approach description for addressing a failure pattern.
   */
  private generateApproach(failurePattern: string, agentResource: string): string {
    // Generate a structured approach based on the failure type
    if (failurePattern.toLowerCase().includes('timeout')) {
      return `Reduce scope for ${agentResource}: break task into smaller steps with shorter timeouts`;
    }
    if (failurePattern.toLowerCase().includes('permission')) {
      return `Adjust permission handling for ${agentResource}: request specific permissions upfront`;
    }
    if (failurePattern.toLowerCase().includes('tool')) {
      return `Improve tool usage guidance for ${agentResource}: add tool selection hints to system prompt`;
    }
    return `General improvement for ${agentResource}: refine instructions to address "${failurePattern}"`;
  }

  /**
   * Evaluate solution variants using heuristic scoring.
   */
  private evaluateVariants(variants: SolutionVariant[]): SolutionVariant[] {
    return variants.map(variant => {
      // Heuristic evaluation based on approach quality and feasibility
      let score = variant.estimatedSuccess;

      // Boost for specific, actionable approaches
      if (variant.approach.includes('break task') || variant.approach.includes('smaller steps')) {
        score += 0.15;
      }
      if (variant.approach.includes('permission')) {
        score += 0.1;
      }

      // Penalize vague approaches
      if (variant.approach.includes('General improvement')) {
        score -= 0.1;
      }

      return {
        ...variant,
        evaluated: true,
        actualScore: Math.max(0, Math.min(1, score)),
      };
    });
  }

  /**
   * Commit a successful solution variant.
   * Updates the agent's configuration via the server interface.
   */
  private async commitVariant(variant: SolutionVariant): Promise<void> {
    try {
      // Update the agent's system prompt or metadata with the improvement
      const resp = this.serverInterface.get_info('Agent', variant.agentResource);
      if (resp.success && resp.data) {
        const currentPrompt = (resp.data.record.entity.metadata as Record<string, unknown>).systemPrompt;
        if (typeof currentPrompt === 'string') {
          const improvedPrompt = currentPrompt +
            `\n\n[Solution Evolution] ${variant.approach}`;
          this.serverInterface.set_variables('Agent', variant.agentResource, {
            systemPrompt: improvedPrompt,
          });
        }
      }
    } catch {
      // Best-effort commit
    }
  }
}
