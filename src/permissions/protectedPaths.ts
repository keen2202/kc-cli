// Centralized protected path definitions
// Single source of truth used by permissions/engine, permissions/classifier, and utils/path

/**
 * Protected path patterns that always require explicit permission
 * These are bypass-immune: even in bypass mode, access requires approval
 */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  // System files
  /^\/etc\/(passwd|shadow|shadow-|sudoers)$/,
  /^\/etc\/ssh\//,
  /^\/(proc|sys|dev)\//,

  // SSH and GPG
  /\/\.ssh\//,
  /\/\.gnupg\//,

  // Shell profiles (prevent injection)
  /\/\.(bashrc|zshrc|profile|bash_profile)$/,

  // Credential files
  /\/\.(env|credentials|secrets)$/,
  /passwords?\.(txt|json|yaml)$/,
  /secrets?\.(txt|json|yaml)$/,

  // Version control internals
  /\/\.git\/(objects|refs)\//,
];

/**
 * Simple protected path substrings for quick checks
 * Used for string-based matching (e.g., in command args)
 */
export const PROTECTED_PATH_SUBSTRINGS: string[] = [
  '/etc/passwd',
  '/etc/shadow',
  '.ssh',
  '.gnupg',
  '/sys/',
  '/proc/',
];

/**
 * System directories that should never be written to
 */
export const SYSTEM_WRITE_DIRECTORIES: string[] = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
];

/**
 * Check if a path matches any protected pattern
 */
export function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Quick check if a path or command string contains a protected substring
 */
export function containsProtectedPath(text: string): boolean {
  return PROTECTED_PATH_SUBSTRINGS.some(p => text.includes(p));
}
