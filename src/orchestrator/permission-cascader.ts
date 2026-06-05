// Permission cascading system for sub-agents

import type { PermissionMode, PermissionContext } from '../permissions/protocol.js';
import type { ToolName } from '../tools/protocol.js';

/**
 * Permission hierarchy (parent → max child permission)
 *
 * bypassPermissions → bypassPermissions / auto
 * auto              → auto / default
 * default           → default / plan
 * plan              → plan (cannot downgrade)
 * dontAsk           → deny all tools
 */

const PERMISSION_HIERARCHY: Record<PermissionMode, PermissionMode[]> = {
  bypassPermissions: ['bypassPermissions', 'auto'],
  auto: ['auto', 'default'],
  default: ['default', 'plan'],
  plan: ['plan'],
  dontAsk: ['dontAsk'],
  acceptEdits: ['acceptEdits', 'default', 'plan'],
};

// Pre-built Sets for O(1) permission lookups (avoids Array.includes per call)
const PERMISSION_HIERARCHY_SETS: Record<PermissionMode, Set<PermissionMode>> = Object.fromEntries(
  Object.entries(PERMISSION_HIERARCHY).map(([key, values]) => [key, new Set(values)])
) as Record<PermissionMode, Set<PermissionMode>>;

/**
 * Security critical paths that always require permission check
 * Even with bypassPermissions, sub-agents must be checked for these
 * Pre-compiled regex for single-pass matching instead of 8 sequential includes()
 */
const SECURITY_CRITICAL_PATHS_REGEX = /\/etc\/passwd|\/etc\/shadow|\.ssh|\.gnupg|\/sys\/|\/proc\/|~\/\.ssh|~\/\.gnupg/;

/**
 * Derive child agent's permission mode from parent's mode
 *
 * @param parentMode - Parent agent's permission mode
 * @param requestedMode - Child's requested permission mode (optional)
 * @returns Actual permission mode for child (never exceeds parent)
 */
export function deriveChildPermissions(
  parentMode: PermissionMode,
  requestedMode?: PermissionMode
): PermissionMode {
  // Parent in dontAsk mode: child cannot use any tools
  if (parentMode === 'dontAsk') {
    return 'dontAsk';
  }

  const allowedChildModes = PERMISSION_HIERARCHY[parentMode] || ['default'];
  const allowedSet = PERMISSION_HIERARCHY_SETS[parentMode] || new Set(['default']);

  // If child requests a specific mode, validate it (O(1) Set lookup)
  if (requestedMode) {
    if (allowedSet.has(requestedMode)) {
      return requestedMode;
    }
    // Requested mode exceeds parent's capability, use the most permissive allowed
    return allowedChildModes[0];
  }

  // No request: inherit parent's mode (if allowed) or use most permissive
  if (allowedSet.has(parentMode)) {
    return parentMode;
  }
  return allowedChildModes[0];
}

/**
 * Build child agent's tool allowlist
 *
 * @param parentTools - All tools available to parent
 * @param config - Spawn config with tools/deniedTools
 * @returns Tool allowlist for child agent
 */
export function buildChildToolAllowList(
  parentTools: ToolName[],
  config?: {
    tools?: ToolName[];
    deniedTools?: ToolName[];
  }
): ToolName[] {
  let allowedTools = [...parentTools];

  // If specific tools are allowed (whitelist) - use Set for O(1) lookup
  if (config?.tools && config.tools.length > 0) {
    const allowSet = new Set(config.tools);
    allowedTools = parentTools.filter((tool) => allowSet.has(tool));
  }

  // If specific tools are denied (blacklist) - use Set for O(1) lookup
  if (config?.deniedTools && config.deniedTools.length > 0) {
    const denySet = new Set(config.deniedTools);
    allowedTools = allowedTools.filter((tool) => !denySet.has(tool));
  }

  // Sub-agents cannot spawn other sub-agents (prevent infinite recursion)
  // This is enforced at the tool level, not here
  allowedTools = allowedTools.filter((tool) => tool !== 'Agent');

  return allowedTools;
}

/**
 * Create child agent's permission context
 *
 * @param parentContext - Parent's permission context
 * @param childMode - Derived child permission mode
 * @returns Child's permission context
 */
export function createChildPermissionContext(
  parentContext: PermissionContext,
  childMode: PermissionMode
): PermissionContext {
  return {
    mode: childMode,
    cwd: parentContext.cwd,
    toolName: '',
    input: {},
    alwaysDenyRules: parentContext.alwaysDenyRules,
    alwaysAskRules: parentContext.alwaysAskRules,
    alwaysAllowRules: parentContext.alwaysAllowRules,
    bypassPermissions: childMode === 'bypassPermissions',
  };
}

/**
 * Check if a tool input accesses security critical paths
 *
 * @param toolName - Tool name
 * @param input - Tool input
 * @returns True if accessing security critical paths
 */
export function isSecurityCritical(
  toolName: string,
  input: Record<string, unknown>
): boolean {
  const pathToCheck =
    (input.path as string) ||
    (input.command as string) ||
    (input.file_path as string) ||
    '';

  // Single regex test instead of 8 sequential includes() calls
  return SECURITY_CRITICAL_PATHS_REGEX.test(pathToCheck);
}

/**
 * Validate child agent's permission mode against parent
 *
 * @param parentMode - Parent's permission mode
 * @param childMode - Child's requested permission mode
 * @returns True if child's mode is valid (does not exceed parent)
 */
export function isValidChildPermission(
  parentMode: PermissionMode,
  childMode: PermissionMode
): boolean {
  const allowedSet = PERMISSION_HIERARCHY_SETS[parentMode] || new Set(['default']);
  return allowedSet.has(childMode);
}
