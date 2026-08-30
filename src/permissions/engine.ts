// 6-step deny-first permission decision engine with plugin-contributed rules

import * as fs from 'fs';
import type {
  PermissionResult,
  PermissionContext,
  PermissionRule,
  PermissionBehavior,
} from '../permissions/protocol';
import type { PluginPermissionRule } from '../plugins/types';
import { getState } from '../bootstrap/state';
import { containsProtectedPath, isSystemWriteDirectory } from './protectedPaths';
import { parseRuleString } from './rules';
import { splitSubCommands } from './commandNormalizer';
import { classifier } from './classifier';
import { getCacheManager } from '../services/cache';
import { logger } from '../services/logger';
import { isInternalUrl } from '../utils/ssrf';

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
 * 3.5. Plugin permission rules (can tighten but never loosen security decisions)
 * 4. Bypass permission mode
 * 5. Check global allow rules (alwaysAllowRules)
 * 5.5. Check always-ask rules
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
    autoReadOnly?: boolean; // Auto-approve read-only operations in non-interactive modes
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

  // S3: bypassPermissions requires explicit KC_ALLOW_BYPASS=1 opt-in.
  // Without the env flag, bypass is denied (not silently allowed).
  const bypassArmed = context.bypassPermissions && process.env.KC_ALLOW_BYPASS === '1';
  if (context.bypassPermissions && !bypassArmed) {
    logger.permissions.warn('[perm] bypassPermissions requested but KC_ALLOW_BYPASS != 1 — denying');
    return {
      behavior: 'deny',
      message: 'bypass requires KC_ALLOW_BYPASS=1',
    };
  }

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

  // Step 2: Tool-specific permission check
  if (options.toolCheckPermissions) {
    const toolResult = options.toolCheckPermissions(input, context);
    if (toolResult.behavior === 'deny') {
      return toolResult;
    }
    if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type !== 'passthrough') {
      // Tool asks for permission, but continue to check if bypass applies
      if (bypassArmed) {
        // In bypass mode, allow unless it's a security-critical operation
        const securityCheck = checkSecurityCritical(toolName, input);
        if (securityCheck) {
          return securityCheck;
        }
        logger.permissions.info('[perm] bypass engaged', { ts: Date.now(), session: state.sessionId });
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
      // This prevents tools from accidentally bypassing protected path checks.
      // S4: also covers Sql db/query (protected path) and WebFetch url (SSRF).
      const securityCheck = checkSecurityCritical(toolName, input);
      if (securityCheck && (securityCheck.behavior === 'ask' || securityCheck.behavior === 'deny')) {
        return securityCheck; // Security-critical overrides tool allow
      }
      return toolResult;
    }
  }

  // Step 3: Security checks (bypass-immune)
  const securityResult = checkSecurityCritical(toolName, input);

  // Step 3.5: Check plugin permission rules (after security-critical, before bypass)
  // Plugin rules can tighten security (ask→deny) but never loosen bypass-immune decisions
  {
    const pluginResult = applyPluginRulesAfterSecurity(
      securityResult, options.pluginManager, toolName, options.content
    );
    if (pluginResult) return pluginResult;
  }

  // If security flagged this and no plugin escalated, return security decision now
  if (securityResult) return securityResult;

  // Step 4: Bypass permission mode
  if (bypassArmed) {
    logger.permissions.info('[perm] bypass engaged', { ts: Date.now(), session: state.sessionId });
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
    case 'auto': {
      const classification = await classifier.classify(toolName, input, context);
      switch (classification.behavior) {
        case 'allow':
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'auto_allowed',
              reason: classification.reason,
            },
          };
        case 'deny':
          return {
            behavior: 'deny',
            message: classification.reason,
            decisionReason: {
              type: 'auto_denied',
              reason: classification.reason,
            },
          };
        case 'ask':
        default:
          // autoReadOnly: promote read-only tool asks to allow
          if (options.autoReadOnly && classification.confidence >= 0.7) {
            return {
              behavior: 'allow',
              updatedInput: input,
              decisionReason: {
                type: 'auto_allowed',
                reason: `Auto-approved read-only operation: ${classification.reason}`,
              },
            };
          }
          return {
            behavior: 'ask',
            message: classification.reason,
            decisionReason: {
              type: 'auto_ask',
              reason: classification.reason,
            },
          };
      }
    }
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
 * Recursively extract all string values from an input object.
 * Handles nested objects, arrays, and array elements.
 */
function extractAllStringValues(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value === 'string') {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          values.push(item);
        } else if (item && typeof item === 'object') {
          values.push(...extractAllStringValues(item as Record<string, unknown>));
        }
      }
    } else if (value && typeof value === 'object') {
      values.push(...extractAllStringValues(value as Record<string, unknown>));
    }
  }
  return values;
}

// Tools capable of writing to the filesystem
const WRITE_CAPABLE_TOOLS = new Set([
  'FileWrite', 'FileEdit', 'Bash', 'Run', 'NotebookEdit',
]);

/**
 * Check if operation is security-critical (bypass-immune)
 * Walks ALL string-valued input properties recursively to catch
 * protected paths in non-standard field names (source, target, files[], etc.)
 * Also splits compound commands (&&, ;, |, ||) and checks each sub-command.
 * Covers tool-specific inputs — Sql database/query (protected paths),
 * WebFetch url (SSRF internal-network) — in addition to path/command.
 */
/**
 * Rough check whether a string looks like a file path.
 * Covers Unix (`/`, `./`, `../`, `~/`), Windows drive-letter (`C:\`, `C:/`),
 * and UNC (`\\server\share`) prefixes so drive/UNC paths also reach
 * `tryRealpath` for symlink/junction resolution.
 * Avoids calling realpath on things that are clearly not paths (e.g. SQL queries).
 */
function looksLikePath(value: string): boolean {
  return /^(\/|\.\/|\.\.\/|~\/|[a-zA-Z]:[\\/]|\\\\)/.test(value);
}

/**
 * Safely resolve symlinks. Returns null on failure (file may not exist yet).
 */
function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function checkSecurityCritical(
  toolName: string,
  input: Record<string, unknown>
): PermissionResult | null {
  const stringValues = extractAllStringValues(input);
  const isWriteTool = WRITE_CAPABLE_TOOLS.has(toolName);

  // Expand compound commands into individual sub-commands for analysis
  const allValuesToCheck: string[] = [];
  for (const value of stringValues) {
    allValuesToCheck.push(value);
    // If value looks like a compound command, split and check each part
    if (/[;&|]/.test(value)) {
      const subCommands = splitSubCommands(value);
      for (const subCmd of subCommands) {
        allValuesToCheck.push(subCmd.trim());
      }
    }
  }

  // T24 (P2, decision D3): dedupe realpath resolution *within this one check*
  // — nested inputs and compound commands commonly repeat the same path. The
  // cache lives and dies with this call, so there is zero staleness across
  // permission checks (a TTL cache was explicitly rejected for that reason).
  const realpathCache = new Map<string, string | null>();
  const resolveOnce = (value: string): string | null => {
    if (!looksLikePath(value)) return value;
    const cached = realpathCache.get(value);
    if (cached !== undefined) return cached;
    const resolved = tryRealpath(value);
    realpathCache.set(value, resolved);
    return resolved;
  };

  for (const value of allValuesToCheck) {
    if (!value) continue;

    // Resolve symlinks for path-like values before matching (SEC-05)
    // Prevents symlink-based bypass of protected path checks.
    // Use try/catch — realpath fails if file doesn't exist yet.
    const resolved = resolveOnce(value);

    // System write directories: deny for write-capable tools only
    if (isWriteTool && isSystemWriteDirectory(resolved || value)) {
      return {
        behavior: 'deny',
        message: `Writing to system directory is not allowed: ${value}`,
        decisionReason: {
          type: 'security_critical',
          reason: `System write directory access detected: ${value}`,
        },
      };
    }
    if (containsProtectedPath(resolved || value)) {
      return {
        behavior: 'ask',
        message: `Access to protected path requires explicit permission`,
        decisionReason: {
          type: 'security_critical',
          reason: `Protected path access detected: ${value}`,
        },
      };
    }
  }

  // S4: Sql — database path or query referencing a protected path → ask
  if (toolName === 'Sql') {
    const database = (input.database as string) || '';
    const query = (input.query as string) || '';
    if (containsProtectedPath(database) || containsProtectedPath(query)) {
      return {
        behavior: 'ask',
        message: `SQL access referencing a protected path requires explicit permission`,
        decisionReason: {
          type: 'security_critical',
          reason: `Protected path in Sql database/query`,
        },
      };
    }
  }

  // S4: WebFetch — url targeting an internal/private network → deny (SSRF)
  if (toolName === 'WebFetch') {
    const urlStr = (input.url as string) || '';
    if (urlStr && isInternalUrl(urlStr)) {
      return {
        behavior: 'deny',
        message: `SSRF blocked: access to internal network URL is denied`,
        decisionReason: {
          type: 'security_critical',
          reason: `Internal network URL detected`,
        },
      };
    }
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
    // Wildcard: * matches any tool name
    if (rule.ruleValue.toolName === '*') {
      if (!rule.ruleValue.ruleContent) {
        return true;
      }
      if (content && matchPattern(rule.ruleValue.ruleContent, content)) {
        return true;
      }
      continue;
    }
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
 * Apply plugin permission rules after security-critical checks have already run.
 * Plugins can tighten security (ask→deny, allow→deny, allow→ask) but can NEVER
 * loosen a security-critical decision. This prevents plugins from bypassing
 * bypass-immune protected path checks.
 */
function applyPluginRulesAfterSecurity(
  securityResult: PermissionResult | null,
  pluginManager: { getPluginPermissionRules(): PluginPermissionRule[] } | undefined,
  toolName: string,
  content?: string
): PermissionResult | null {
  if (!pluginManager) return null;
  const pluginRules = pluginManager.getPluginPermissionRules();
  const pluginMatch = matchPluginRules(pluginRules, toolName, content);
  if (!pluginMatch) return null;

  // If security already flagged this as ask, plugin can only escalate to deny
  if (securityResult && securityResult.behavior === 'ask') {
    if (pluginMatch.behavior === 'deny') return pluginMatch;
    return securityResult; // plugin allow/ask cannot override security ask
  }

  // No security issue — plugin decision stands
  return pluginMatch;
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
