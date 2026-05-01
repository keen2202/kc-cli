// Centralized read-only and low-risk command patterns
// Single source of truth used by BashTool, GitTool, and PermissionClassifier

/**
 * Read-only bash command patterns
 * These commands do not modify the filesystem and are safe to auto-allow
 */
export const READONLY_BASH_PATTERNS: RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^find\b/,
  /^pwd\b/,
  /^whoami\b/,
  /^date\b/,
  /^echo\b/,
  /^which\b/,
  /^type\b/,
  /^uname\b/,
  /^df\b/,
  /^du\b/,
  /^wc\b/,
  /^sort\b/,
  /^uniq\b/,
  /^diff\b/,
];

/**
 * Read-only Git subcommands
 * These commands only read repository state
 */
export const READONLY_GIT_COMMANDS: Set<string> = new Set([
  'status', 'log', 'diff', 'branch', 'remote', 'show',
  'ls-files', 'ls-tree', 'cat-file', 'describe', 'tag',
  'shortlog', 'name-rev', 'rev-parse', 'rev-list',
  'show-ref', 'for-each-ref', 'config --list',
]);

/**
 * Low-risk bash command patterns (classifier use)
 * Slightly broader than read-only, includes some safe mutations
 */
export const LOW_RISK_BASH_PATTERNS: RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^git\s+(status|log|diff|branch)\b/,
  /^find\s+\.\s+-name\b/,
  /^grep\b/,
];

/**
 * Medium-risk bash command patterns (classifier use)
 */
export const MEDIUM_RISK_BASH_PATTERNS: RegExp[] = [
  /^git\s+(commit|push|pull)\b/,
  /^npm\s+(install|run)\b/,
  /^docker\s+(ps|images|logs)\b/,
  /^(mkdir|touch|cp|mv)\b/,
];

/**
 * Dangerous bash command patterns
 * These are always denied regardless of permission mode
 */
export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /\bFormat\b.*\/Q/,
  /\bshutdown\b.*\/r/,
  /\brm\s+-rf\b/,
];

/**
 * Dangerous Git command patterns
 */
export const DANGEROUS_GIT_PATTERNS: RegExp[] = [
  /push\s+--force/,
  /reset\s+--hard/,
  /clean\s+-fd/,
  /filter-branch/,
];

/**
 * Check if a bash command matches any read-only pattern
 */
export function isReadOnlyBashCommand(command: string): boolean {
  // Commands with output redirect are NOT read-only (they write to files)
  if (/[|>]/.test(command)) return false;
  return READONLY_BASH_PATTERNS.some(p => p.test(command));
}

/**
 * Check if a git subcommand is read-only
 */
export function isReadOnlyGitCommand(command: string): boolean {
  const baseCommand = command.split(' ')[0];
  return READONLY_GIT_COMMANDS.has(baseCommand) || READONLY_GIT_COMMANDS.has(command);
}
