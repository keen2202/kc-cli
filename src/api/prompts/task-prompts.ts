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
