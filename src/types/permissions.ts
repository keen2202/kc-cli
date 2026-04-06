// Permission types for the security system

export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'passthrough';

export type PermissionMode =
  | 'default'           // Standard interactive mode
  | 'bypassPermissions' // Skip all permission checks
  | 'dontAsk'           // Convert 'ask' to 'deny'
  | 'plan'              // Plan mode, read-only allowed
  | 'acceptEdits'       // Accept all edits, ask for others
  | 'auto';             // Use classifier for auto-decision

export interface PermissionAllowDecision {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  decisionReason: {
    type: string;
    reason: string;
  };
}

export interface PermissionDenyDecision {
  behavior: 'deny';
  message: string;
  decisionReason?: {
    type: string;
    reason: string;
  };
}

export interface PermissionAskDecision {
  behavior: 'ask';
  message: string;
  decisionReason?: {
    type: string;
    reason: string;
  };
}

export interface PermissionPassthrough {
  behavior: 'passthrough';
  message: string;
}

export type PermissionResult =
  | PermissionAllowDecision
  | PermissionDenyDecision
  | PermissionAskDecision
  | PermissionPassthrough;

export interface PermissionRule {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
}

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string; // e.g., "ls:*", "git commit:*"
}

export type PermissionRuleSource =
  | 'policySettings'    // Admin-enforced policies
  | 'flagSettings'      // Workspace-level settings
  | 'projectSettings'   // Project-level settings.json
  | 'userSettings'      // User-level settings.json
  | 'localSettings'     // Local settings.json
  | 'cliArg'            // CLI argument
  | 'session';          // Session-level rules

export interface PermissionContext {
  mode: PermissionMode;
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
  alwaysDenyRules: PermissionRule[];
  alwaysAskRules: PermissionRule[];
  alwaysAllowRules: PermissionRule[];
  bypassPermissions: boolean;
}
