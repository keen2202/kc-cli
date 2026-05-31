// Three-layer permission decision engine

import type {
  PermissionResult,
  PermissionContext,
  PermissionRule,
  PermissionBehavior,
} from '../types/permissions';
import type { PluginPermissionRule } from '../plugins/types';
import { getState } from '../bootstrap/state';
import { containsProtectedPath } from './protectedPaths';
import { parseRuleString } from './rules';
import { getCacheManager } from '../services/cache';

export interface PermissionEngineConfig {
  alwaysDenyRules?: string[];
  alwaysAskRules?: string[];
  alwaysAllowRules?: string[];
}

// TieredCache for parsed permission rules with hit rate tracking
const parsedRuleCache = getCacheManager().getOrCreate<{ toolName: string; ruleContent?: string }>(
  'permission-rules', 'permission', { maxSize: 500 }
);

function getCachedRule(ruleString: string): { toolName: string; ruleContent?: string } {
  const cached = parsedRuleCache.get(ruleString);
  if (cached) return cached;
  const parsed = parseRuleString(ruleString);
  parsedRuleCache.set(ruleString, parsed);
  return parsed;
}

/**
 * Main permission check function
 *
 * Flow:
 * 1. Check global deny rules (alwaysDenyRules)
 * 2. Tool-specific permission check (tool.checkPermissions)
 * 3. Security checks (bypass-immune)
 * 4. Bypass permission mode
 * 5. Check global allow rules (alwaysAllowRules)
 * 6. Default based on mode
 */
export async function hasPermissionsToUseTool(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolCheckPermissions?: (
      input: Record<string, unknown>,
      context: PermissionContext
    ) => PermissionResult;
    content?: string; // For content-specific rules
    config?: PermissionEngineConfig; // Permission engine configuration
    pluginManager?: { getPluginPermissionRules(): PluginPermissionRule[] }; // Plugin manager for plugin rules
  } = {}
): Promise<PermissionResult> {
  const state = getState();

  // Parse rules from config or use empty arrays (cached for static rules)
  const config = options.config || {};
  const alwaysDenyRules: PermissionRule[] = (config.alwaysDenyRules || []).map(ruleString => ({
    source: 'cliArg' as const,
    ruleBehavior: 'deny' as const,
    ruleValue: getCachedRule(ruleString),
  }));
  const alwaysAllowRules: PermissionRule[] = (config.alwaysAllowRules || []).map(ruleString => ({
    source: 'cliArg' as const,
    ruleBehavior: 'allow' as const,
    ruleValue: getCachedRule(ruleString),
  }));
  const alwaysAskRules: PermissionRule[] = (config.alwaysAskRules || []).map(ruleString => ({
    source: 'cliArg' as const,
    ruleBehavior: 'ask' as const,
    ruleValue: getCachedRule(ruleString),
  }));
  
  const context: PermissionContext = {
    mode: state.permissionMode,
    cwd: state.cwd,
    toolName,
    input,
    alwaysDenyRules,
    alwaysAskRules,
    alwaysAllowRules,
    bypassPermissions: state.permissionMode === 'bypassPermissions',
  };

  // Step 1: Check global deny rules
  const denyMatch = matchRules(context.alwaysDenyRules, toolName, options.content);
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Tool '${toolName}' is denied by policy`,
      decisionReason: {
        type: 'policy_deny',
        reason: 'Matched alwaysDenyRules',
      },
    };
  }

  // Step 1.5: Check plugin permission rules (after global deny, before tool-specific)
  if (options.pluginManager) {
    const pluginRules = options.pluginManager.getPluginPermissionRules();
    const pluginMatch = matchPluginRules(pluginRules, toolName, options.content);
    if (pluginMatch) {
      return pluginMatch;
    }
  }

  // Step 2: Tool-specific permission check
  if (options.toolCheckPermissions) {
    const toolResult = options.toolCheckPermissions(input, context);
    if (toolResult.behavior === 'deny') {
      return toolResult;
    }
    if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type !== 'passthrough') {
      // Tool asks for permission, but continue to check if bypass applies
      if (context.bypassPermissions) {
        // In bypass mode, allow unless it's a security-critical operation
        const securityCheck = checkSecurityCritical(toolName, input);
        if (securityCheck) {
          return securityCheck;
        }
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'bypass',
            reason: 'Bypass permissions mode',
          },
        };
      }
      return toolResult;
    }
    if (toolResult.behavior === 'allow') {
      // Tool says allow, but still check security-critical paths (Step 3)
      // This prevents tools from accidentally bypassing protected path checks
      const securityCheck = checkSecurityCritical(toolName, input);
      if (securityCheck && securityCheck.behavior === 'ask') {
        return securityCheck; // Security-critical overrides tool allow
      }
      return toolResult;
    }
  }

  // Step 3: Security checks (bypass-immune)
  const securityResult = checkSecurityCritical(toolName, input);
  if (securityResult && securityResult.behavior === 'ask') {
    return securityResult;
  }

  // Step 4: Bypass permission mode
  if (context.bypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'bypass',
        reason: 'Bypass permissions mode',
      },
    };
  }

  // Step 5: Check global allow rules
  const allowMatch = matchRules(context.alwaysAllowRules, toolName, options.content);
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'policy_allow',
        reason: 'Matched alwaysAllowRules',
      },
    };
  }

  // Step 5.5: Check always-ask rules (overrides mode defaults)
  const askMatch = matchRules(context.alwaysAskRules, toolName, options.content);
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Tool '${toolName}' requires explicit permission (alwaysAskRules)`,
      decisionReason: {
        type: 'policy_ask',
        reason: 'Matched alwaysAskRules',
      },
    };
  }

  // Step 6: Default based on mode
  switch (context.mode) {
    case 'dontAsk':
      return {
        behavior: 'deny',
        message: `Permission denied in dontAsk mode`,
      };
    case 'auto':
      // Use classifier (placeholder - would call LLM classifier)
      return {
        behavior: 'ask',
        message: `Auto classifier needs to evaluate '${toolName}'`,
      };
    case 'plan':
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' not allowed in plan mode`,
      };
    default:
      return {
        behavior: 'ask',
        message: `Tool '${toolName}' requires permission`,
      };
  }
}

/**
 * Check if operation is security-critical (bypass-immune)
 */
function checkSecurityCritical(
  toolName: string,
  input: Record<string, unknown>
): PermissionResult | null {
  // Check for protected paths
  const pathToCheck = (input.path as string) || (input.command as string) || '';

  if (containsProtectedPath(pathToCheck)) {
    return {
      behavior: 'ask',
      message: `Access to protected path requires explicit permission`,
      decisionReason: {
        type: 'security_critical',
        reason: `Protected path access detected`,
      },
    };
  }

  return null;
}

/**
 * Match rules against tool name and content
 */
function matchRules(
  rules: PermissionRule[],
  toolName: string,
  content?: string
): boolean {
  for (const rule of rules) {
    if (rule.ruleValue.toolName !== toolName) {
      continue;
    }

    if (!rule.ruleValue.ruleContent) {
      // Rule applies to entire tool
      return true;
    }

    // Check content pattern
    if (content && matchPattern(rule.ruleValue.ruleContent, content)) {
      return true;
    }
  }

  return false;
}

/**
 * Match pattern with wildcard support
 * Supports: "*", "?", "prefix:*"
 * Caches compiled regex patterns for repeated use.
 */
const patternCache = getCacheManager().getOrCreate<RegExp>(
  'permission-patterns', 'permission', { maxSize: 500 }
);

function matchPattern(pattern: string, content: string): boolean {
  const cached = patternCache.get(pattern);
  if (cached) return cached.test(content);
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexPattern}$`, 'i');
  patternCache.set(pattern, regex);
  return regex.test(content);
}

/**
 * Match plugin permission rules against tool name and content.
 * Returns a PermissionResult if a rule matches, null otherwise.
 * Rules are expected to be sorted by priority (lower number = higher priority).
 */
function matchPluginRules(
  rules: PluginPermissionRule[],
  toolName: string,
  content?: string
): PermissionResult | null {
  for (const rule of rules) {
    // Check tool pattern (supports wildcard "*")
    if (rule.toolPattern !== '*' && rule.toolPattern !== toolName) {
      continue;
    }

    // Check content pattern if specified
    if (rule.contentPattern && content) {
      if (!matchPattern(rule.contentPattern, content)) {
        continue;
      }
    } else if (rule.contentPattern && !content) {
      // Rule has content pattern but no content to match - skip
      continue;
    }

    // Rule matches - return result
    return {
      behavior: rule.behavior,
      message: `Plugin rule: ${rule.behavior} for ${toolName}`,
      decisionReason: {
        type: 'plugin_rule',
        reason: `Matched plugin rule: ${rule.toolPattern}${rule.contentPattern ? `:${rule.contentPattern}` : ''}`,
      },
    } as PermissionResult;
  }

  return null;
}

/**
 * Build permission context for tool execution
 */
export function buildPermissionContext(): PermissionContext {
  const state = getState();
  return {
    mode: state.permissionMode,
    cwd: state.cwd,
    toolName: '',
    input: {},
    alwaysDenyRules: [],
    alwaysAskRules: [],
    alwaysAllowRules: [],
    bypassPermissions: state.permissionMode === 'bypassPermissions',
  };
}
