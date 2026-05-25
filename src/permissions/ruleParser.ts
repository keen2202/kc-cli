// Enhanced permission rule parser with YAML support and complex conditions

import type { PermissionBehavior } from '../types/permissions';

/**
 * Enhanced permission rule with complex conditions.
 */
export interface EnhancedPermissionRule {
  /** Rule name for identification */
  name?: string;
  /** Priority (higher = evaluated first) */
  priority?: number;
  /** Tool name pattern (supports wildcards) */
  tool?: string;
  /** Command pattern (supports regex and prefix matching) */
  command?: string | string[];
  /** Path pattern (supports glob and regex) */
  path?: string | string[];
  /** Environment variable conditions */
  env?: Record<string, string | { pattern: string }>;
  /** When condition (composite boolean expression) */
  when?: ConditionExpression;
  /** Rule behavior */
  behavior: PermissionBehavior;
  /** Human-readable reason */
  reason?: string;
  /** Whether this rule is enabled */
  enabled?: boolean;
}

/**
 * Condition expression for complex boolean logic.
 */
export type ConditionExpression =
  | { and: ConditionExpression[] }
  | { or: ConditionExpression[] }
  | { not: ConditionExpression }
  | { equals: { value: string; expected: string } }
  | { matches: { value: string; pattern: string } }
  | { contains: { value: string; substring: string } }
  | { startsWith: { value: string; prefix: string } }
  | { endsWith: { value: string; suffix: string } }
  | { gt: { value: number; threshold: number } }
  | { lt: { value: number; threshold: number } }
  | boolean;

/**
 * Rule evaluation context.
 */
export interface RuleEvaluationContext {
  toolName: string;
  command?: string;
  path?: string;
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Rule evaluation result.
 */
export interface RuleEvaluationResult {
  matched: boolean;
  rule?: EnhancedPermissionRule;
  reason?: string;
}

/**
 * Parse YAML-like rule configuration.
 * Supports both simple string rules and enhanced rule objects.
 */
export function parseEnhancedRule(rule: unknown): EnhancedPermissionRule | null {
  if (typeof rule === 'string') {
    return parseSimpleRuleString(rule);
  }

  if (typeof rule === 'object' && rule !== null) {
    return parseRuleObject(rule as Record<string, unknown>);
  }

  return null;
}

/**
 * Parse simple rule string format.
 * Examples: "Bash", "Bash(ls *)", "FileWrite(/src/*)"
 */
function parseSimpleRuleString(ruleString: string): EnhancedPermissionRule {
  const match = ruleString.match(/^([A-Za-z*]+)(?:\((.+)\))?$/);

  if (!match) {
    return {
      tool: ruleString,
      behavior: 'ask',
    };
  }

  return {
    tool: match[1],
    command: match[2],
    behavior: 'ask',
  };
}

/**
 * Parse rule object from configuration.
 */
function parseRuleObject(obj: Record<string, unknown>): EnhancedPermissionRule | null {
  if (!obj.behavior || !['allow', 'deny', 'ask'].includes(obj.behavior as string)) {
    return null;
  }

  const rule: EnhancedPermissionRule = {
    behavior: obj.behavior as PermissionBehavior,
  };

  if (typeof obj.name === 'string') rule.name = obj.name;
  if (typeof obj.priority === 'number') rule.priority = obj.priority;
  if (typeof obj.tool === 'string') rule.tool = obj.tool;
  if (typeof obj.command === 'string' || Array.isArray(obj.command)) {
    rule.command = obj.command as string | string[];
  }
  if (typeof obj.path === 'string' || Array.isArray(obj.path)) {
    rule.path = obj.path as string | string[];
  }
  if (typeof obj.env === 'object' && obj.env !== null) {
    rule.env = obj.env as Record<string, string | { pattern: string }>;
  }
  if (typeof obj.when === 'object' && obj.when !== null) {
    rule.when = obj.when as ConditionExpression;
  }
  if (typeof obj.reason === 'string') rule.reason = obj.reason;
  if (typeof obj.enabled === 'boolean') rule.enabled = obj.enabled;

  return rule;
}

/**
 * Evaluate a condition expression against context.
 */
export function evaluateCondition(
  condition: ConditionExpression,
  context: RuleEvaluationContext
): boolean {
  if (typeof condition === 'boolean') {
    return condition;
  }

  if ('and' in condition) {
    return condition.and.every(c => evaluateCondition(c, context));
  }

  if ('or' in condition) {
    return condition.or.some(c => evaluateCondition(c, context));
  }

  if ('not' in condition) {
    return !evaluateCondition(condition.not, context);
  }

  if ('equals' in condition) {
    const value = resolveValue(condition.equals.value, context);
    return value === condition.equals.expected;
  }

  if ('matches' in condition) {
    const value = resolveValue(condition.matches.value, context);
    const regex = new RegExp(condition.matches.pattern);
    return regex.test(value);
  }

  if ('contains' in condition) {
    const value = resolveValue(condition.contains.value, context);
    return value.includes(condition.contains.substring);
  }

  if ('startsWith' in condition) {
    const value = resolveValue(condition.startsWith.value, context);
    return value.startsWith(condition.startsWith.prefix);
  }

  if ('endsWith' in condition) {
    const value = resolveValue(condition.endsWith.value, context);
    return value.endsWith(condition.endsWith.suffix);
  }

  if ('gt' in condition) {
    const value = Number(resolveValue(String(condition.gt.value), context));
    return value > condition.gt.threshold;
  }

  if ('lt' in condition) {
    const value = Number(resolveValue(String(condition.lt.value), context));
    return value < condition.lt.threshold;
  }

  return false;
}

/**
 * Resolve value from context using dot notation.
 * Examples: "command", "path", "env.HOME", "cwd"
 */
function resolveValue(path: string, context: RuleEvaluationContext): string {
  const parts = path.split('.');
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return '';
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }

  return String(current ?? '');
}

/**
 * Match a pattern against a value.
 * Supports: exact match, glob (* and ?), regex (/pattern/)
 */
export function matchEnhancedPattern(pattern: string, value: string): boolean {
  // Regex pattern (starts and ends with /)
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const regex = new RegExp(pattern.slice(1, -1));
      return regex.test(value);
    } catch (_err) {
      console.error("Suppressed error:", _err);
      return false;
    }
  }

  // Glob pattern
  if (pattern.includes('*') || pattern.includes('?')) {
    return matchGlobPattern(pattern, value);
  }

  // Exact match
  return pattern === value;
}

/**
 * Match glob pattern.
 */
function matchGlobPattern(pattern: string, text: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(text);
}

/**
 * Evaluate a single enhanced rule against context.
 */
export function evaluateRule(
  rule: EnhancedPermissionRule,
  context: RuleEvaluationContext
): RuleEvaluationResult {
  // Check if rule is enabled
  if (rule.enabled === false) {
    return { matched: false };
  }

  // Check tool pattern
  if (rule.tool) {
    if (!matchEnhancedPattern(rule.tool, context.toolName)) {
      return { matched: false };
    }
  }

  // Check command pattern
  if (rule.command && context.command) {
    const patterns = Array.isArray(rule.command) ? rule.command : [rule.command];
    const commandMatch = patterns.some(p => matchEnhancedPattern(p, context.command!));
    if (!commandMatch) {
      return { matched: false };
    }
  }

  // Check path pattern
  if (rule.path && context.path) {
    const patterns = Array.isArray(rule.path) ? rule.path : [rule.path];
    const pathMatch = patterns.some(p => matchEnhancedPattern(p, context.path!));
    if (!pathMatch) {
      return { matched: false };
    }
  }

  // Check environment variables
  if (rule.env && context.env) {
    for (const [key, condition] of Object.entries(rule.env)) {
      const envValue = context.env[key];
      if (envValue === undefined) {
        return { matched: false };
      }

      if (typeof condition === 'string') {
        if (envValue !== condition) {
          return { matched: false };
        }
      } else if (typeof condition === 'object' && condition.pattern) {
        if (!matchEnhancedPattern(condition.pattern, envValue)) {
          return { matched: false };
        }
      }
    }
  }

  // Check when condition
  if (rule.when) {
    if (!evaluateCondition(rule.when, context)) {
      return { matched: false };
    }
  }

  return {
    matched: true,
    rule,
    reason: rule.reason || `Matched rule: ${rule.name || 'unnamed'}`,
  };
}

/**
 * Evaluate multiple rules in priority order.
 * Returns the first matching rule.
 */
export function evaluateRules(
  rules: EnhancedPermissionRule[],
  context: RuleEvaluationContext
): RuleEvaluationResult {
  // Sort by priority (higher first)
  const sortedRules = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of sortedRules) {
    const result = evaluateRule(rule, context);
    if (result.matched) {
      return result;
    }
  }

  return { matched: false };
}

/**
 * Validate rule syntax.
 */
export function validateRule(rule: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof rule === 'string') {
    // Simple string rules are always valid
    return { valid: true, errors: [] };
  }

  if (typeof rule !== 'object' || rule === null) {
    return { valid: false, errors: ['Rule must be a string or object'] };
  }

  const obj = rule as Record<string, unknown>;

  if (!obj.behavior || !['allow', 'deny', 'ask'].includes(obj.behavior as string)) {
    errors.push('Rule must have a behavior of "allow", "deny", or "ask"');
  }

  if (obj.priority !== undefined && typeof obj.priority !== 'number') {
    errors.push('Priority must be a number');
  }

  if (obj.tool !== undefined && typeof obj.tool !== 'string') {
    errors.push('Tool must be a string');
  }

  if (obj.command !== undefined) {
    if (typeof obj.command !== 'string' && !Array.isArray(obj.command)) {
      errors.push('Command must be a string or array of strings');
    }
  }

  if (obj.path !== undefined) {
    if (typeof obj.path !== 'string' && !Array.isArray(obj.path)) {
      errors.push('Path must be a string or array of strings');
    }
  }

  if (obj.when !== undefined) {
    if (typeof obj.when !== 'object' || obj.when === null) {
      errors.push('When condition must be an object');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert enhanced rule to simple rule string format.
 * Falls back to basic format for simple rules.
 */
export function ruleToSimpleString(rule: EnhancedPermissionRule): string {
  if (!rule.tool) {
    return `*(${rule.behavior})`;
  }

  if (!rule.command && !rule.path && !rule.env && !rule.when) {
    return rule.tool;
  }

  if (rule.command && typeof rule.command === 'string') {
    return `${rule.tool}(${rule.command})`;
  }

  return `${rule.tool}(${rule.behavior})`;
}
