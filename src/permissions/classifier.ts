// Auto classifier for permission decisions

import type { PermissionResult, PermissionContext } from '../types/permissions';
import { LOW_RISK_BASH_PATTERNS, MEDIUM_RISK_BASH_PATTERNS } from './readonlyCommands';
import { containsProtectedPath } from './protectedPaths';

export interface ClassifierDecision {
  behavior: 'allow' | 'deny' | 'ask';
  confidence: number; // 0-1
  reason: string;
}

/**
 * Simple rule-based classifier
 * In production, this would use an LLM for intelligent decisions
 */
export class PermissionClassifier {
  private consecutiveDenials = 0;
  private totalDenials = 0;
  private readonly maxConsecutiveDenials = 5;

  /**
   * Classify permission request
   */
  async classify(
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionContext
  ): Promise<ClassifierDecision> {
    // Stage 1: Quick path (low cost checks)
    const quickDecision = this.quickPathCheck(toolName, input);
    if (quickDecision) {
      return quickDecision;
    }

    // Stage 2: Run classifier (would call LLM in production)
    return this.runClassifier(toolName, input, context);
  }

  /**
   * Quick path checks
   */
  private quickPathCheck(
    toolName: string,
    input: Record<string, unknown>
  ): ClassifierDecision | null {
    // Always allow safe read-only tools
    const safeTools = ['FileRead', 'Glob', 'Grep', 'Monitor'];
    if (safeTools.includes(toolName)) {
      return {
        behavior: 'allow',
        confidence: 0.95,
        reason: `Safe read-only tool: ${toolName}`,
      };
    }

    // Always deny known dangerous patterns
    const command = (input.command as string) || '';

    if (command.match(/\b(rm\s+-rf\s+)\b/)) {
      return {
        behavior: 'deny',
        confidence: 0.99,
        reason: 'Dangerous recursive delete command',
      };
    }

    if (command.match(/\b(mkfs|dd|Format)\b/)) {
      return {
        behavior: 'deny',
        confidence: 0.99,
        reason: 'Destructive system command',
      };
    }

    return null;
  }

  /**
   * Run full classifier (placeholder for LLM-based classification)
   */
  private async runClassifier(
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionContext
  ): Promise<ClassifierDecision> {
    // In production, this would:
    // 1. Send command/context to LLM
    // 2. LLM analyzes risk level
    // 3. Returns allow/deny/ask with confidence

    // Simple heuristic for now
    const command = (input.command as string) || '';

    // Low-risk commands
    for (const pattern of LOW_RISK_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'allow',
          confidence: 0.85,
          reason: 'Low-risk command pattern',
        };
      }
    }

    // Medium-risk commands
    for (const pattern of MEDIUM_RISK_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'ask',
          confidence: 0.70,
          reason: 'Medium-risk command, needs confirmation',
        };
      }
    }

    // Default to ask
    return {
      behavior: 'ask',
      confidence: 0.50,
      reason: 'Unknown command pattern',
    };
  }

  /**
   * Track denial count and enforce limits
   */
  trackDenial(decision: ClassifierDecision): void {
    if (decision.behavior === 'deny') {
      this.consecutiveDenials++;
      this.totalDenials++;
    } else {
      this.consecutiveDenials = 0;
    }
  }

  /**
   * Check if we've exceeded denial limits
   */
  hasExceededLimits(): boolean {
    return this.consecutiveDenials >= this.maxConsecutiveDenials;
  }

  /**
   * Reset counters
   */
  reset(): void {
    this.consecutiveDenials = 0;
    this.totalDenials = 0;
  }

  /**
   * Get stats
   */
  getStats(): { consecutiveDenials: number; totalDenials: number } {
    return {
      consecutiveDenials: this.consecutiveDenials,
      totalDenials: this.totalDenials,
    };
  }
}

// Singleton instance
export const classifier = new PermissionClassifier();
