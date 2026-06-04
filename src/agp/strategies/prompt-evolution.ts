/**
 * AGP Strategy: Prompt Evolution
 *
 * TextGrad-style prompt optimization strategy.
 * Analyzes LLM response quality and iteratively refines prompts
 * through gradient-like textual feedback.
 *
 * Strategy:
 * 1. Collect prompt-response pairs from trace data
 * 2. Generate textual "gradients" (feedback about what to improve)
 * 3. Apply feedback to refine prompt templates
 * 4. Evaluate refined prompts against baseline
 */

import type { ServerInterface } from '../server-interface';
import type { TraceManager } from '../trace-manager';
import type { EvolutionCycleResult } from '../sepl/protocol';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromptEvolutionConfig {
  /** Maximum iterations for prompt refinement */
  maxIterations: number;
  /** Target prompt resource names */
  targetPrompts: string[];
  /** Quality threshold (0-1) */
  qualityThreshold: number;
  /** Whether to preserve the original prompt structure */
  preserveStructure: boolean;
}

export interface PromptFeedback {
  /** Prompt resource name */
  promptName: string;
  /** Current prompt content */
  currentContent: string;
  /** Textual gradient (what to improve) */
  gradient: string;
  /** Quality score from evaluation */
  qualityScore: number;
  /** Specific issues found */
  issues: string[];
}

export interface PromptEvolutionResult {
  /** Whether any prompt was improved */
  improved: boolean;
  /** Feedback collected for each prompt */
  feedbacks: PromptFeedback[];
  /** Evolution cycle results */
  cycleResults: EvolutionCycleResult[];
}

const DEFAULT_CONFIG: PromptEvolutionConfig = {
  maxIterations: 3,
  targetPrompts: [],
  qualityThreshold: 0.7,
  preserveStructure: true,
};

// ─── Strategy Implementation ─────────────────────────────────────────────────

export class PromptEvolutionStrategy {
  private config: PromptEvolutionConfig;
  private serverInterface: ServerInterface;
  private traceManager: TraceManager;

  constructor(
    serverInterface: ServerInterface,
    traceManager: TraceManager,
    config?: Partial<PromptEvolutionConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serverInterface = serverInterface;
    this.traceManager = traceManager;
  }

  /**
   * Run the prompt evolution strategy.
   * Analyzes recent execution traces to identify prompt improvements.
   */
  async evolve(): Promise<PromptEvolutionResult> {
    const feedbacks = this.collectFeedback();
    const cycleResults: EvolutionCycleResult[] = [];

    if (feedbacks.length === 0) {
      return { improved: false, feedbacks: [], cycleResults: [] };
    }

    // Apply improvements for prompts below quality threshold
    let improved = false;
    for (const feedback of feedbacks) {
      if (feedback.qualityScore >= this.config.qualityThreshold) continue;

      const applied = await this.applyFeedback(feedback);
      if (applied) improved = true;
    }

    return { improved, feedbacks, cycleResults };
  }

  /**
   * Collect textual feedback from execution traces.
   */
  private collectFeedback(): PromptFeedback[] {
    const feedbacks: PromptFeedback[] = [];
    const recentErrors = this.traceManager.getErrors(20);
    const llmCalls = this.traceManager.query({ category: 'llm_request', limit: 50 });

    // Find prompts that were used in failing or low-quality executions
    const promptNames = this.config.targetPrompts.length > 0
      ? this.config.targetPrompts
      : this.getPromptNames();

    for (const promptName of promptNames) {
      const issues: string[] = [];
      let qualityScore = 0.8; // Start optimistic

      // Check if errors correlate with this prompt
      const relatedErrors = recentErrors.filter(e =>
        e.source.includes('prompt') || e.source.includes(promptName)
      );
      if (relatedErrors.length > 0) {
        issues.push(`${relatedErrors.length} errors related to this prompt`);
        qualityScore -= relatedErrors.length * 0.05;
      }

      // Check LLM response quality indicators
      const recentLLM = llmCalls.slice(-5);
      for (const call of recentLLM) {
        if (call.isError) {
          issues.push(`LLM error with model ${call.source}`);
          qualityScore -= 0.1;
        }
      }

      // Generate textual gradient
      const gradient = this.generateGradient(promptName, issues);

      // Get current prompt content
      let currentContent = '';
      try {
        const resp = this.serverInterface.get_info('Prompt', promptName);
        if (resp.success && resp.data) {
          const meta = resp.data.record.entity.metadata as Record<string, unknown>;
          currentContent = (meta.template as string) ?? resp.data.record.entity.description;
        }
      } catch {
        currentContent = 'Unknown prompt';
      }

      feedbacks.push({
        promptName,
        currentContent,
        gradient,
        qualityScore: Math.max(0, qualityScore),
        issues,
      });
    }

    return feedbacks;
  }

  /**
   * Generate a textual gradient (improvement feedback) for a prompt.
   */
  private generateGradient(promptName: string, issues: string[]): string {
    if (issues.length === 0) {
      return 'No issues detected. Prompt is performing well.';
    }

    const parts: string[] = [];
    for (const issue of issues) {
      if (issue.includes('error')) {
        parts.push(`Address error patterns: ${issue}. Consider adding explicit error handling guidance.`);
      } else if (issue.includes('LLM error')) {
        parts.push(`Improve clarity to reduce LLM confusion. Simplify complex instructions.`);
      } else {
        parts.push(`Issue: ${issue}`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Apply textual gradient feedback to improve a prompt.
   */
  private async applyFeedback(feedback: PromptFeedback): Promise<boolean> {
    try {
      // For now, append improvement notes as a refinement comment
      // In a full implementation, this would use an LLM to rewrite the prompt
      const improvedContent = feedback.currentContent +
        `\n\n[Evolution v${Date.now()}] Refinement notes: ${feedback.gradient}`;

      // Update via server interface
      this.serverInterface.set_variables('Prompt', feedback.promptName, {
        template: improvedContent,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all prompt names from the registry.
   */
  private getPromptNames(): string[] {
    try {
      const all = this.serverInterface.listAll();
      return all
        .filter(item => item.type === 'Prompt')
        .map(item => item.name);
    } catch {
      return [];
    }
  }
}
