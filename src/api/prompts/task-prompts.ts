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

// ── Conversational message detection ──

// Patterns that indicate a task-oriented request (code, files, changes).
// If none of these match, the message is likely conversational.
const TASK_ORIENTED_REGEX =
  /(?:fix|debug|implement|create|add|build|write|edit|refactor|optimize|improve|change|update|remove|delete|rename|migrate|upgrade|install|configure|setup|deploy|test|run|check|find|search|read|show|explain|review|analyze|format|lint|compile|commit|push|merge|branch|pr|pull request|docker|kubernetes|ci|cd|pipeline|error|bug|issue|crash|fail|broken|not working|doesn'?t work|function|class|module|file|code|api|endpoint|route|component|database|db|sql|query|schema|migration|config|env|environment|variable|import|export|dependency|package|npm|yarn|pnpm|pip|cargo|gradle|maven|make|dockerfile|docker-compose|yaml|json|xml|html|css|typescript|javascript|python|rust|go|java|c\+\+|ruby|php|swift|kotlin|shell|bash|zsh|terminal|command|cli|tool|src|test|spec|README|\.ts\b|\.js\b|\.py\b)/i;

// Greeting / small-talk patterns — these should never trigger task workflows.
const CONVERSATIONAL_GREETING_REGEX =
  /^(?:hi|hey|hello|yo|sup|good (?:morning|afternoon|evening)|howdy|hola|bonjour|ciao|你好|您好|嗨|哈[啰咯]|早上好|晚上好|下午好|こんにちは|안녕|привет)[\s!！。.]*$/i;

// Simple questions that don't imply a task.
const CONVERSATIONAL_QUESTION_REGEX =
  /^(?:what (?:can|do|are|is) you|who are you|how (?:are|do) you|tell me about yourself|what'?s up|how'?s it going)\b/i;

/**
 * Detect whether a user message is purely conversational (greeting, small talk,
 * simple capability question) rather than a task-oriented request.
 *
 * Conversational messages should bypass the planning phase and not receive
 * inflated turn budgets.
 */
export function isConversationalMessage(message: string): boolean {
  const trimmed = message.trim();
  const len = trimmed.length;

  // Empty or whitespace-only
  if (len === 0) return true;

  // Greetings (any language)
  if (CONVERSATIONAL_GREETING_REGEX.test(trimmed)) return true;

  // Capability / self-intro questions
  if (CONVERSATIONAL_QUESTION_REGEX.test(trimmed)) return true;

  // Short messages (< 40 chars) with no task-oriented keywords
  if (len < 40 && !TASK_ORIENTED_REGEX.test(trimmed)) return true;

  return false;
}

/**
 * Estimate task complexity based on the user message.
 * Used to adapt the turn budget dynamically.
 */
export function estimateTaskComplexity(message: string): ComplexityEstimate {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const length = trimmed.length;

  // Conversational / non-task messages need minimal turn budget
  if (isConversationalMessage(trimmed)) {
    return { complexity: 'simple', suggestedTurns: 5 };
  }

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
