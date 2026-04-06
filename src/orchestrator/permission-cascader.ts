// Permission cascading system for sub-agents

import type { PermissionMode, PermissionContext } from '../types/permissions';
import type { ToolName } from '../types/tools';

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

/**
 * Security critical paths that always require permission check
 * Even with bypassPermissions, sub-agents must be checked for these
 */
const SECURITY_CRITICAL_PATHS = [
  '/etc/passwd',
  '/etc/shadow',
  '.ssh',
  '.gnupg',
  '/sys/',
  '/proc/',
  '~/.ssh',
  '~/.gnupg',
];

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

  // If child requests a specific mode, validate it
  if (requestedMode) {
    if (allowedChildModes.includes(requestedMode)) {
      return requestedMode;
    }
    // Requested mode exceeds parent's capability, use the most permissive allowed
    return allowedChildModes[0];
  }

  // No request: inherit parent's mode (if allowed) or use most permissive
  if (allowedChildModes.includes(parentMode)) {
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

  // If specific tools are allowed (whitelist)
  if (config?.tools && config.tools.length > 0) {
    allowedTools = parentTools.filter((tool) => config.tools!.includes(tool));
  }

  // If specific tools are denied (blacklist)
  if (config?.deniedTools && config.deniedTools.length > 0) {
    allowedTools = allowedTools.filter((tool) => !config.deniedTools!.includes(tool));
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

  for (const protectedPath of SECURITY_CRITICAL_PATHS) {
    if (pathToCheck.includes(protectedPath)) {
      return true;
    }
  }

  return false;
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
  const allowedChildModes = PERMISSION_HIERARCHY[parentMode] || ['default'];
  return allowedChildModes.includes(childMode);
}
