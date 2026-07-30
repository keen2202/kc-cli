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

// ── UI ↔ executor authorization bridge ──
// These shared types let the interactive UI approve/deny 'ask' decisions
// without introducing a circular dependency between the UI layer and the
// executor/permission layer.

/** A single file change preview surfaced to the user during authorization. */
export interface FilePatchPreview {
  filePath: string;
  /** Original file content, or null for new files. */
  oldContent: string | null;
  newContent: string;
}

/** A request handed to the UI when a tool needs interactive authorization. */
export interface UIPermissionRequest {
  toolName: string;
  /** Human-readable one-line summary of the tool input. */
  inputSummary?: string;
  /** Full, untruncated operation detail (e.g. the complete command, query or
   *  argument list) shown when the user expands the request to review exactly
   *  what will run before authorizing. */
  details?: string;
  /** Pending file changes, when the tool writes/edits files. */
  diffs?: FilePatchPreview[];
}

/** The user's decision for a {@link UIPermissionRequest}. */
export type UIPermissionDecision = 'allow' | 'allow_always' | 'deny';

/** Handler the UI registers to resolve interactive authorization requests. */
export type UIPermissionRequestHandler = (
  req: UIPermissionRequest,
) => Promise<UIPermissionDecision>;
