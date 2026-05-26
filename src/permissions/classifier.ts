// Auto classifier for permission decisions

import type { PermissionResult, PermissionContext } from '../types/permissions';
import { LOW_RISK_BASH_PATTERNS, MEDIUM_RISK_BASH_PATTERNS } from './readonlyCommands';
import { containsProtectedPath } from './protectedPaths';
import { normalizeCommand } from './commandNormalizer';

// Module-level constants (avoid allocation per call)
const SAFE_TOOLS = new Set(['FileRead', 'Glob', 'Grep', 'Monitor']);
const RM_RF_REGEX = /\brm\s+-rf/;
const DESTRUCTIVE_REGEX = /\b(mkfs|dd|Format)\b/;
const CLASSIFIER_TIMEOUT_MS = 5000;
const MAX_CLASSIFICATIONS_PER_SEC = 10;

export interface ClassifierDecision {
  behavior: 'allow' | 'deny' | 'ask';
  confidence: number; // 0-1
  reason: string;
}

/**
 * Simple token-bucket rate limiter for classifier calls.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxTokens: number, perSecond: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = perSecond / 1000;
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Simple rule-based classifier
 * In production, this would use an LLM for intelligent decisions
 */
export class PermissionClassifier {
  private consecutiveDenials = 0;
  private totalDenials = 0;
  private readonly maxConsecutiveDenials = 5;
  private rateLimiter = new RateLimiter(MAX_CLASSIFICATIONS_PER_SEC, MAX_CLASSIFICATIONS_PER_SEC);

  /**
   * Classify permission request with timeout and rate limiting.
   * Falls back to 'ask' if the classifier times out or is rate-limited.
   */
  async classify(
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionContext
  ): Promise<ClassifierDecision> {
    // Stage 1: Quick path (low cost checks) — bypasses rate limit
    const quickDecision = this.quickPathCheck(toolName, input);
    if (quickDecision) {
      return quickDecision;
    }

    // Rate limit check
    if (!this.rateLimiter.tryConsume()) {
      return {
        behavior: 'ask',
        confidence: 0.3,
        reason: 'Rate limit exceeded, defaulting to ask',
      };
    }

    // Stage 2: Run classifier with timeout, fallback to 'ask'
    try {
      return await Promise.race([
        this.runClassifier(toolName, input, context),
        new Promise<ClassifierDecision>((_, reject) =>
          setTimeout(() => reject(new Error('Classifier timeout')), CLASSIFIER_TIMEOUT_MS)
        ),
      ]);
    } catch {
      return {
        behavior: 'ask',
        confidence: 0.3,
        reason: 'Classifier timeout, defaulting to ask',
      };
    }
  }

  /**
   * Quick path checks
   */
  private quickPathCheck(
    toolName: string,
    input: Record<string, unknown>
  ): ClassifierDecision | null {
    // Always allow safe read-only tools (O(1) Set lookup)
    if (SAFE_TOOLS.has(toolName)) {
      return {
        behavior: 'allow',
        confidence: 0.95,
        reason: `Safe read-only tool: ${toolName}`,
      };
    }

    // Always deny known dangerous patterns (pre-compiled regex)
    const rawCommand = (input.command as string) || '';
    const command = normalizeCommand(rawCommand);

    if (RM_RF_REGEX.test(command)) {
      return {
        behavior: 'deny',
        confidence: 0.99,
        reason: 'Dangerous recursive delete command',
      };
    }

    if (DESTRUCTIVE_REGEX.test(command)) {
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
    const rawCommand = (input.command as string) || '';
    const command = normalizeCommand(rawCommand);

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
