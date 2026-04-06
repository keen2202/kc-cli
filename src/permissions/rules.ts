// Permission rule matching and management

import type { PermissionRule, PermissionRuleValue, PermissionBehavior } from '../types/permissions';

/**
 * Parse rule string into PermissionRuleValue
 * Format: "ToolName" or "ToolName(contentPattern)"
 * Examples: "Bash", "Bash(ls *)", "Bash(git commit:*)", "FileWrite(/src/*)"
 */
export function parseRuleString(ruleString: string): PermissionRuleValue {
  const match = ruleString.match(/^([A-Za-z]+)(?:\((.+)\))?$/);

  if (!match) {
    return {
      toolName: ruleString,
      ruleContent: undefined,
    };
  }

  return {
    toolName: match[1]!,
    ruleContent: match[2],
  };
}

/**
 * Format PermissionRuleValue back to string
 */
export function formatRuleString(ruleValue: PermissionRuleValue): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName;
  }
  return `${ruleValue.toolName}(${ruleValue.ruleContent})`;
}

/**
 * Check if content matches rule pattern
 */
export function matchRuleContent(pattern: string, content: string): boolean {
  // Handle prefix pattern (ends with *)
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return content.startsWith(prefix);
  }

  // Handle wildcard pattern
  if (pattern.includes('*') || pattern.includes('?')) {
    return matchWildcardPattern(pattern, content);
  }

  // Exact match
  return pattern === content;
}

/**
 * Match wildcard pattern (supports * and ?)
 */
function matchWildcardPattern(pattern: string, text: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(text);
}

/**
 * Create permission rules from configuration
 */
export function createRulesFromConfig(
  source: string,
  behavior: PermissionBehavior,
  rules: string[]
): PermissionRule[] {
  return rules.map(ruleString => ({
    source: source as any,
    ruleBehavior: behavior,
    ruleValue: parseRuleString(ruleString),
  }));
}

/**
 * Merge rules from multiple sources
 * Priority: policy > flag > project > user > local > cliArg > session
 */
export function mergeRuleSets(ruleSets: PermissionRule[][]): PermissionRule[] {
  const merged: PermissionRule[] = [];
  const seen = new Set<string>();

  // Reverse order so higher priority sources are processed last
  for (const rules of ruleSets.reverse()) {
    for (const rule of rules) {
      const key = formatRuleString(rule.ruleValue);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(rule);
      }
    }
  }

  return merged;
}

/**
 * Check if any deny rule matches
 */
export function matchesAnyDenyRule(
  rules: PermissionRule[],
  toolName: string,
  content?: string
): boolean {
  for (const rule of rules) {
    if (rule.ruleValue.toolName !== toolName) {
      continue;
    }

    if (!rule.ruleValue.ruleContent) {
      return true; // Entire tool is denied
    }

    if (content && matchRuleContent(rule.ruleValue.ruleContent, content)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if any allow rule matches
 */
export function matchesAnyAllowRule(
  rules: PermissionRule[],
  toolName: string,
  content?: string
): boolean {
  for (const rule of rules) {
    if (rule.ruleValue.toolName !== toolName) {
      continue;
    }

    if (!rule.ruleValue.ruleContent) {
      return true; // Entire tool is allowed
    }

    if (content && matchRuleContent(rule.ruleValue.ruleContent, content)) {
      return true;
    }
  }

  return false;
}
