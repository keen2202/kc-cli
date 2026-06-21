// Task-specific prompt overlays

import type { TaskType } from './types';

// Pre-compiled regex patterns for task type detection (single test instead of multiple includes())
const DEBUGGING_REGEX = /bug|error|fix|debug|not\s+working|fails|crash/;
const REFACTORING_REGEX = /refactor|clean\s+up|improve|restructure|optimize/;
const DOCUMENTATION_REGEX = /document|readme|explain|comment|jsdoc|docstring/;
const CODEGEN_REGEX = /create|implement|add|write|build|new\s+feature/;

/**
 * Detect the task type from a user message.
 * Simple heuristic-based detection.
 */
export function detectTaskType(message: string): TaskType {
  const lower = message.toLowerCase();

  if (DEBUGGING_REGEX.test(lower)) return 'debugging';
  if (REFACTORING_REGEX.test(lower)) return 'refactoring';
  if (DOCUMENTATION_REGEX.test(lower)) return 'documentation';
  if (CODEGEN_REGEX.test(lower)) return 'code-gen';

  return 'general';
}

// ── Task Complexity Estimation ──

export type TaskComplexity = 'simple' | 'medium' | 'complex';

export interface ComplexityEstimate {
  complexity: TaskComplexity;
  suggestedTurns: number;
}

// Pre-compiled patterns for complexity signals
const MULTI_FILE_REGEX = /\b(multiple|several|many|all|every|across|throughout)\s+(files?|directories?|modules?|packages?|components?)/i;
const CROSS_PROJECT_REGEX = /\b(entire|whole|across)\s+(project|codebase|repo|repository)/i;
const TEST_AND_IMPLEMENT_REGEX = /\b(test|spec|specs|tests?)\b.*\b(implement|create|add|build|write)\b|\b(implement|create|add|build|write)\b.*\b(test|spec|specs|tests?)\b/i;
const SINGLE_FILE_REGEX = /\b(single|one|a)\s+(file|function|method|class|module)/i;
const SIMPLE_FIX_REGEX = /\b(typo|rename|add comment|update string|change message|simple fix|quick fix)\b/i;

/**
 * Estimate task complexity based on the user message.
 * Used to adapt the turn budget dynamically.
 */
export function estimateTaskComplexity(message: string): ComplexityEstimate {
  const lower = message.toLowerCase();
  const length = message.length;

  // Simple signals
  if (length < 80 && SIMPLE_FIX_REGEX.test(lower)) {
    return { complexity: 'simple', suggestedTurns: 20 };
  }
  if (length < 100 && SINGLE_FILE_REGEX.test(lower)) {
    return { complexity: 'simple', suggestedTurns: 20 };
  }
  if (DOCUMENTATION_REGEX.test(lower) && length < 200) {
    return { complexity: 'simple', suggestedTurns: 20 };
  }

  // Complex signals
  let complexityScore = 0;
  if (CROSS_PROJECT_REGEX.test(lower)) complexityScore += 2;
  if (MULTI_FILE_REGEX.test(lower)) complexityScore += 1;
  if (TEST_AND_IMPLEMENT_REGEX.test(lower)) complexityScore += 1;
  if (length > 500) complexityScore += 1;
  if (length > 1000) complexityScore += 1;

  if (complexityScore >= 2) {
    return { complexity: 'complex', suggestedTurns: 80 };
  }

  // Default to medium
  return { complexity: 'medium', suggestedTurns: 40 };
}
