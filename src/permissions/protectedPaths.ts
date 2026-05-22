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

  // Cloud provider credentials
  /\/\.aws\/(credentials|config)$/,
  /\/\.config\/gcloud\//,
  /\/\.kube\/config$/,
  /\/\.docker\/config\.json$/,
  /\/\.azure\//,
  /\/\.terraform\.d\//,

  // Version control internals
  /\/\.git\/(objects|refs)\//,
];

/**
 * Simple protected path substrings for quick checks
 * Used for string-based matching (e.g., in command args)
 * Pre-compiled regex for single-pass matching instead of 10 sequential includes()
 */
export const PROTECTED_PATH_SUBSTRINGS_REGEX = /\/etc\/passwd|\/etc\/shadow|\.ssh|\.gnupg|\/sys\/|\/proc\/|\.aws\/credentials|\.kube\/config|\.docker\/config\.json|\.config\/gcloud/;

/**
 * @deprecated Use PROTECTED_PATH_SUBSTRINGS_REGEX for better performance
 */
export const PROTECTED_PATH_SUBSTRINGS: string[] = [
  '/etc/passwd',
  '/etc/shadow',
  '.ssh',
  '.gnupg',
  '/sys/',
  '/proc/',
  '.aws/credentials',
  '.kube/config',
  '.docker/config.json',
  '.config/gcloud',
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
 * Uses single regex test instead of 10 sequential includes() calls
 */
export function containsProtectedPath(text: string): boolean {
  return PROTECTED_PATH_SUBSTRINGS_REGEX.test(text);
}
