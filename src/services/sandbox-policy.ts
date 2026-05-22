// Sandbox policy system - per-tool sandbox configuration
//
// Allows fine-grained control over which tools run in the sandbox,
// with support for tool-level and pattern-based rules.

import { getCacheManager } from './cache';

/**
 * Sandbox enforcement level for a specific tool.
 *
 * - 'required': Tool MUST run in the sandbox. If sandbox unavailable, deny execution.
 * - 'preferred': Tool SHOULD run in the sandbox. Falls back to noop with warning.
 * - 'optional': Tool MAY run in the sandbox. No warning if unavailable.
 * - 'excluded': Tool MUST NOT run in the sandbox (e.g., FileReadTool, GlobTool).
 * - 'inherit': Use the default sandbox policy for this tool type.
 */
export type SandboxEnforcementLevel = 'required' | 'preferred' | 'optional' | 'excluded' | 'inherit';

/**
 * Per-tool sandbox policy configuration.
 */
export interface ToolSandboxPolicy {
  /** Override sandbox settings for this specific tool */
  allowNetwork?: boolean;
  maxMemoryMb?: number;
  cpuTimeLimitSec?: number;
  /** Enforcement level: whether sandbox is required/preferred/optional/excluded */
  enforcement?: SandboxEnforcementLevel;
}

/**
 * Complete sandbox policy configuration.
 */
export interface SandboxPolicy {
  /** Global sandbox settings */
  enabled: boolean;
  backend: 'bubblewrap' | 'seccomp' | 'docker' | 'noop';
  /** Default enforcement level for tools not explicitly configured */
  defaultEnforcement: SandboxEnforcementLevel;
  /** Default allowNetwork setting */
  allowNetwork: boolean;
  /** Default memory limit in MB */
  maxMemoryMb: number;
  /** Default CPU time limit in seconds */
  cpuTimeLimitSec: number;
  /** Per-tool overrides keyed by tool name */
  toolPolicies: Record<string, ToolSandboxPolicy>;
  /** Pattern-based rules (e.g., "File*" applies to all File tools) */
  patternRules: Array<{
    pattern: string;
    policy: ToolSandboxPolicy;
  }>;
}

/**
 * Built-in default sandbox policies by tool category.
 *
 * Security-critical tools (Bash, Run) require sandbox.
 * Read-only tools (FileRead, Grep, Glob) are excluded.
 * Write tools (FileWrite, FileEdit) are preferred.
 */
const DEFAULT_TOOL_POLICIES: Record<string, ToolSandboxPolicy> = {
  // Security-critical: always require sandbox
  Bash: { enforcement: 'required', allowNetwork: false },
  Run: { enforcement: 'required', allowNetwork: false },

  // Write operations: prefer sandbox
  FileWrite: { enforcement: 'preferred', allowNetwork: false },
  FileEdit: { enforcement: 'preferred', allowNetwork: false },

  // Read-only tools: never need sandbox
  FileRead: { enforcement: 'excluded' },
  Grep: { enforcement: 'excluded' },
  Glob: { enforcement: 'excluded' },
  Git: { enforcement: 'excluded' },

  // Network tools: need network access
  WebFetch: { enforcement: 'optional', allowNetwork: true },
  WebSearch: { enforcement: 'optional', allowNetwork: true },
  HTTPRequest: { enforcement: 'preferred', allowNetwork: true },

  // Database tools: prefer sandbox, no network by default
  Sql: { enforcement: 'preferred', allowNetwork: false },

  // Docker tool: excluded (can't run Docker inside Docker easily)
  Docker: { enforcement: 'excluded' },

  // System tools: optional sandbox
  Monitor: { enforcement: 'excluded' },
  Config: { enforcement: 'excluded' },
};

/**
 * Built-in pattern rules for tool name matching.
 */
const DEFAULT_PATTERN_RULES: Array<{ pattern: string; policy: ToolSandboxPolicy }> = [
  { pattern: 'Task*', policy: { enforcement: 'excluded' } },
  { pattern: 'Deploy*', policy: { enforcement: 'preferred', allowNetwork: true } },
  { pattern: 'Agent*', policy: { enforcement: 'excluded' } },
  { pattern: 'AskUser*', policy: { enforcement: 'excluded' } },
  { pattern: 'Todo*', policy: { enforcement: 'excluded' } },
  { pattern: 'LSP*', policy: { enforcement: 'excluded' } },
];

/**
 * Default sandbox policy.
 */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  enabled: true,
  backend: 'bubblewrap',
  defaultEnforcement: 'preferred',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
  toolPolicies: { ...DEFAULT_TOOL_POLICIES },
  patternRules: [...DEFAULT_PATTERN_RULES],
};

/**
 * Check if a tool name matches a glob pattern.
 * Supports '*' (any characters) and '?' (single character).
 */
// TieredCache for compiled regexes with hit rate tracking
const patternCache = getCacheManager().getOrCreate<RegExp>(
  'sandbox-patterns', 'permission', { maxSize: 200 }
);

function getCompiledPattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${regexPattern}$`);
  patternCache.set(pattern, re);
  return re;
}

export function matchPattern(pattern: string, toolName: string): boolean {
  return getCompiledPattern(pattern).test(toolName);
}

/**
 * Get the sandbox policy for a specific tool.
 *
 * Resolution order:
 * 1. Exact tool name match in toolPolicies
 * 2. Pattern rule match in patternRules (first match wins)
 * 3. Default policy values
 */
export function getToolPolicy(
  toolName: string,
  policy: SandboxPolicy = DEFAULT_SANDBOX_POLICY
): {
  enforcement: SandboxEnforcementLevel;
  allowNetwork: boolean;
  maxMemoryMb: number;
  cpuTimeLimitSec: number;
} {
  // Step 1: Exact match
  const exactPolicy = policy.toolPolicies[toolName];
  if (exactPolicy) {
    return {
      enforcement: exactPolicy.enforcement ?? policy.defaultEnforcement,
      allowNetwork: exactPolicy.allowNetwork ?? policy.allowNetwork,
      maxMemoryMb: exactPolicy.maxMemoryMb ?? policy.maxMemoryMb,
      cpuTimeLimitSec: exactPolicy.cpuTimeLimitSec ?? policy.cpuTimeLimitSec,
    };
  }

  // Step 2: Pattern match
  for (const rule of policy.patternRules) {
    if (matchPattern(rule.pattern, toolName)) {
      return {
        enforcement: rule.policy.enforcement ?? policy.defaultEnforcement,
        allowNetwork: rule.policy.allowNetwork ?? policy.allowNetwork,
        maxMemoryMb: rule.policy.maxMemoryMb ?? policy.maxMemoryMb,
        cpuTimeLimitSec: rule.policy.cpuTimeLimitSec ?? policy.cpuTimeLimitSec,
      };
    }
  }

  // Step 3: Default
  return {
    enforcement: policy.defaultEnforcement,
    allowNetwork: policy.allowNetwork,
    maxMemoryMb: policy.maxMemoryMb,
    cpuTimeLimitSec: policy.cpuTimeLimitSec,
  };
}

/**
 * Merge user-provided policy overrides with the default policy.
 *
 * User overrides can specify partial toolPolicies — they are merged
 * with the built-in defaults rather than replacing them entirely.
 */
export function mergeSandboxPolicy(
  userPolicy?: Partial<SandboxPolicy>
): SandboxPolicy {
  if (!userPolicy) {
    return { ...DEFAULT_SANDBOX_POLICY };
  }

  return {
    enabled: userPolicy.enabled ?? DEFAULT_SANDBOX_POLICY.enabled,
    backend: userPolicy.backend ?? DEFAULT_SANDBOX_POLICY.backend,
    defaultEnforcement: userPolicy.defaultEnforcement ?? DEFAULT_SANDBOX_POLICY.defaultEnforcement,
    allowNetwork: userPolicy.allowNetwork ?? DEFAULT_SANDBOX_POLICY.allowNetwork,
    maxMemoryMb: userPolicy.maxMemoryMb ?? DEFAULT_SANDBOX_POLICY.maxMemoryMb,
    cpuTimeLimitSec: userPolicy.cpuTimeLimitSec ?? DEFAULT_SANDBOX_POLICY.cpuTimeLimitSec,
    toolPolicies: {
      ...DEFAULT_SANDBOX_POLICY.toolPolicies,
      ...userPolicy.toolPolicies,
    },
    patternRules: userPolicy.patternRules
      ? [...DEFAULT_SANDBOX_POLICY.patternRules, ...userPolicy.patternRules]
      : [...DEFAULT_SANDBOX_POLICY.patternRules],
  };
}

/**
 * Check if sandbox is required for a tool given the current policy
 * and sandbox availability.
 *
 * Returns:
 * - 'run-sandboxed': Run in sandbox
 * - 'run-unsandboxed': Run without sandbox (allowed)
 * - 'deny': Deny execution (sandbox required but unavailable)
 */
export function shouldSandbox(
  toolName: string,
  sandboxAvailable: boolean,
  policy: SandboxPolicy = DEFAULT_SANDBOX_POLICY
): 'run-sandboxed' | 'run-unsandboxed' | 'deny' {
  if (!policy.enabled) {
    return 'run-unsandboxed';
  }

  const toolPolicy = getToolPolicy(toolName, policy);

  switch (toolPolicy.enforcement) {
    case 'required':
      if (sandboxAvailable) {
        return 'run-sandboxed';
      }
      return 'deny';

    case 'preferred':
      if (sandboxAvailable) {
        return 'run-sandboxed';
      }
      return 'run-unsandboxed';

    case 'optional':
      if (sandboxAvailable) {
        return 'run-sandboxed';
      }
      return 'run-unsandboxed';

    case 'excluded':
      return 'run-unsandboxed';

    case 'inherit':
      // Treat as 'preferred'
      if (sandboxAvailable) {
        return 'run-sandboxed';
      }
      return 'run-unsandboxed';

    default:
      return 'run-unsandboxed';
  }
}
