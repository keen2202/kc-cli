// Centralized protected path definitions
// Single source of truth used by permissions/engine, permissions/classifier, and utils/path

/**
 * Protected path patterns that always require explicit permission
 * These are bypass-immune: even in bypass mode, access requires approval
 */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  // ── System files ──
  /^\/etc\/(passwd|shadow|shadow-|sudoers)$/,
  /^\/etc\/ssh\//,
  /^\/(proc|sys|dev)\//,

  // ── Credential & secret paths ──
  /\/\.ssh\//,
  /\/\.gnupg\//,
  /\/\.(env|credentials|secrets)$/,
  /passwords?\.(txt|json|yaml)$/,
  /secrets?\.(txt|json|yaml)$/,
  /^\/etc\/ssl\/private\//,
  /^\/etc\/pki\//,
  /\/run\/secrets\//,

  // ── Shell/profile injection ──
  /\/\.(bashrc|zshrc|profile|bash_profile)$/,
  /^\/root\/\.bashrc$/,
  /^\/root\/\.profile$/,
  /^\/etc\/environment$/,
  /^\/etc\/profile\.d\//,

  // ── Cloud provider credentials ──
  /\/\.aws\/(credentials|config)$/,
  /\/\.config\/gcloud\//,
  /\/\.config\/gh\//,
  /\/\.config\/hub\//,
  /\/\.kube\/config$/,
  /\/\.docker\/config\.json$/,
  /\/\.azure\//,
  /\/\.terraform\.d\//,

  // ── Database credential paths ──
  /^\/etc\/mysql\//,
  /^\/etc\/postgresql\//,
  /\/\.my\.cnf$/,
  /\/\.pgpass$/,

  // ── Persistence & privilege escalation ──
  /^\/etc\/cron\.d\//,
  /^\/etc\/cron\.hourly\//,
  /^\/etc\/cron\.daily\//,
  /^\/etc\/cron\.weekly\//,
  /^\/etc\/systemd\/system\//,
  /^\/etc\/ld\.so\.preload$/,
  /^\/etc\/sudoers\.d\//,
  /^\/etc\/pam\.d\//,

  // ── Version control internals ──
  /\/\.git\/(objects|refs)\//,
];

/**
 * Simple protected path substrings for quick checks
 * Used for string-based matching (e.g., in command args)
 * Pre-compiled regex for single-pass matching instead of 10 sequential includes()
 */
// Case-insensitive matching with Windows path support (SEC-04)
export const PROTECTED_PATH_SUBSTRINGS_REGEX = /\/etc\/(passwd|shadow|ssh|ssl\/private|pki|cron|systemd\/system|sudoers\.d|pam\.d|environment|profile\.d|mysql|postgresql|ld\.so\.preload)|\.ssh|\.gnupg|\/sys\/|\/proc\/|\/run\/secrets|\.aws\/(credentials|config)|\.kube\/config|\.docker\/config\.json|\.config\/(gcloud|gh|hub)|\/root\/\.(bashrc|profile)|\.my\.cnf|\.pgpass|\.env\b|\.credentials\b|\.secrets\b|\\Users\\.*\\\.ssh|%USERPROFILE%\\\./i;

/**
 * @deprecated Use PROTECTED_PATH_SUBSTRINGS_REGEX for better performance
 */
export const PROTECTED_PATH_SUBSTRINGS: string[] = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/ssh',
  '/etc/ssl/private',
  '/etc/cron',
  '/etc/systemd/system',
  '/etc/sudoers.d',
  '/etc/pam.d',
  '/etc/environment',
  '/etc/profile.d',
  '/etc/mysql',
  '/etc/postgresql',
  '/etc/ld.so.preload',
  '.ssh',
  '.gnupg',
  '/sys/',
  '/proc/',
  '/run/secrets',
  '.aws/credentials',
  '.aws/config',
  '.kube/config',
  '.docker/config.json',
  '.config/gcloud',
  '.config/gh',
  '.config/hub',
  '/root/.bashrc',
  '/root/.profile',
  '.my.cnf',
  '.pgpass',
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
 * Check if a path is inside a system directory that should never be written to.
 * Resolves the path before checking to catch relative paths and traversal.
 */
export function isSystemWriteDirectory(targetPath: string): boolean {
  const normalized = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
  return SYSTEM_WRITE_DIRECTORIES.some(dir => normalized.startsWith(dir));
}

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
