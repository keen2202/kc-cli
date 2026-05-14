// Task-specific prompt overlays

import type { TaskType } from './types';

/**
 * Detect the task type from a user message.
 * Simple heuristic-based detection.
 */
export function detectTaskType(message: string): TaskType {
  const lower = message.toLowerCase();

  // Debugging indicators
  if (
    lower.includes('bug') ||
    lower.includes('error') ||
    lower.includes('fix') ||
    lower.includes('debug') ||
    lower.includes('not working') ||
    lower.includes('fails') ||
    lower.includes('crash')
  ) {
    return 'debugging';
  }

  // Refactoring indicators
  if (
    lower.includes('refactor') ||
    lower.includes('clean up') ||
    lower.includes('improve') ||
    lower.includes('restructure') ||
    lower.includes('optimize')
  ) {
    return 'refactoring';
  }

  // Documentation indicators
  if (
    lower.includes('document') ||
    lower.includes('readme') ||
    lower.includes('explain') ||
    lower.includes('comment') ||
    lower.includes('jsdoc') ||
    lower.includes('docstring')
  ) {
    return 'documentation';
  }

  // Code generation indicators
  if (
    lower.includes('create') ||
    lower.includes('implement') ||
    lower.includes('add') ||
    lower.includes('write') ||
    lower.includes('build') ||
    lower.includes('new feature')
  ) {
    return 'code-gen';
  }

  return 'general';
}
