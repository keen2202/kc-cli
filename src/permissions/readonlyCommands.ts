import { normalizeCommand, splitSubCommands } from './commandNormalizer';

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
  // Normalize first to prevent pattern-matching bypass via formatting tricks
  const normalized = normalizeCommand(command);
  // Commands with output redirect are NOT read-only (they write to files)
  if (/[|>]/.test(normalized)) return false;
  return READONLY_BASH_PATTERNS.some(p => p.test(normalized));
}

/**
 * Check if a git subcommand is read-only
 */
export function isReadOnlyGitCommand(command: string): boolean {
  const baseCommand = command.split(' ')[0];
  return READONLY_GIT_COMMANDS.has(baseCommand) || READONLY_GIT_COMMANDS.has(command);
}

/**
 * Detect whether a command carries recursive+force removal flags, regardless
 * of how the flags are arranged (combined `-rf`/`-fr`/`-rvf`, separate `-r -f`,
 * or long `--recursive --force`).
 */
function hasRecursiveForceFlags(c: string): boolean {
  // Combined short flags containing both r and f: -rf, -fr, -rvf, -Rf, ...
  if (/(?:^|\s)-\w*[rR]\w*[fF]\w*/.test(c)) return true;
  if (/(?:^|\s)-\w*[fF]\w*[rR]\w*/.test(c)) return true;
  // Separate -r/-R and -f flags
  if (/(?:^|\s)-[rR]\b/.test(c) && /(?:^|\s)-[fF]\b/.test(c)) return true;
  // Long flags
  if (/--recursive\b/i.test(c) && /--force\b/i.test(c)) return true;
  return false;
}

/**
 * Detect dangerous bash commands using bypass-resistant normalization.
 *
 * Defeats obfuscation vectors that plain `DANGEROUS_BASH_PATTERNS` regex misses:
 *   - Trailing/multiple whitespace (via `normalizeCommand`)
 *   - Variable assignments (`a=rm; $a -rf /`) — `rm` still appears literally in the assignment
 *   - Command substitution (`$(echo rm) -rf /`) — keyword still appears literally
 *   - base64 decode piping (`echo ... | base64 -d | sh`) — hidden payload vector
 *   - Pipe-to-shell (`... | sh` / `... | bash`) — executes arbitrary content
 *
 * High-risk primitives are matched regardless of argument arrangement.
 * Existing `DANGEROUS_BASH_PATTERNS` are kept as a fallback so no previously
 * blocked form regresses.
 *
 * @param command Raw or pre-normalized command string
 * @returns true if the command should be treated as dangerous
 */
export function isDangerousBashCommand(command: string): boolean {
  if (!command) return false;
  const normalized = normalizeCommand(command);
  const subs = splitSubCommands(normalized);
  // Check both the full command (cross-sub-command vectors) and each sub-command.
  const candidates = [normalized, ...subs];

  // 1. Pipe-to-shell executes arbitrary content → dangerous.
  if (/\|\s*(?:sh|bash)\b/.test(normalized)) return true;
  // 2. base64 decode is a hidden-payload vector.
  if (/\bbase64\b/.test(normalized) && /(?:-d\b|--decode\b)/.test(normalized)) return true;

  // 3. High-risk primitives regardless of argument form.
  for (const c of candidates) {
    if (/\brm\b/.test(c) && hasRecursiveForceFlags(c)) return true;
    if (/\bmkfs\b/.test(c)) return true;
    if (/\bdd\b/.test(c) && /of=\/dev\//.test(c)) return true;
    if (/\bchmod\b/.test(c) && /\b777\b/.test(c)) return true;
    if (/\bshutdown\b/.test(c)) return true;
    if (/\bFormat\b/.test(c) && /\/Q/i.test(c)) return true;
  }

  // 4. Fallback: existing enumerated patterns (preserves prior coverage).
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}
