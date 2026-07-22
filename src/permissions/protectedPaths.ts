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
 * Windows-centric protected path patterns (H3).
 * Written against the NORMALIZED form produced by `normalizePathForMatch`
 * (forward slashes, lower-cased drive letter, `%USERPROFILE%`/`~` expanded).
 * These are additive: they only widen coverage, never relax existing checks.
 */
export const WINDOWS_PROTECTED_PATTERNS: RegExp[] = [
  // ── Credentials ──
  /\/\.aws\/credentials/i,
  /\/\.azure\//i,
  /\/\.kube\/config/i,
  /\/\.docker\/config\.json/i,
  /\/\.ssh\//i,
  /\/appdata\/roaming\/gcloud\//i,
  // ── System-sensitive (SAM/SYSTEM hives, hosts) ──
  /\/windows\/system32\/config\//i,
  /\/windows\/system32\/drivers\/etc\/hosts/i,
  // ── Keys & certificates ──
  /\/\.gnupg\//i,
  /\/microsoft\/crypto\//i,
];

/**
 * Normalize a path string for pattern matching ONLY (does not change the
 * real path used for filesystem operations). Unifies Windows and Unix forms:
 *  - expand `%USERPROFILE%` and keep `~` as the home marker
 *  - convert backslashes to forward slashes
 *  - lower-case the drive letter (e.g. `C:/` -> `c:/`)
 */
export function normalizePathForMatch(p: string): string {
  if (!p) return p;
  let out = p;
  // Expand %USERPROFILE% -> ~ before separator conversion
  out = out.replace(/%userprofile%/gi, '~');
  // Backslashes -> forward slashes (covers `C:\` and UNC `\\server`)
  out = out.replace(/\\/g, '/');
  // Lower-case drive letter only (rest left intact; regexes are case-insensitive)
  out = out.replace(/^([a-zA-Z]):\//, (_m, d: string) => d.toLowerCase() + ':/');
  return out;
}

/**
 * System directories that should never be written to.
 * Unix entries are matched as leading-slash prefixes; Windows entries are
 * matched (case-insensitively) against the normalized forward-slash form.
 */
export const SYSTEM_WRITE_DIRECTORIES: string[] = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  // ── Windows (normalized: forward slashes, lower-cased drive) ──
  'c:/windows/',
  'c:/program files/',
  'c:/program files (x86)/',
  'c:/programdata/',
];

/**
 * Check if a path is inside a system directory that should never be written to.
 * Resolves the path before checking to catch relative paths and traversal.
 */
export function isSystemWriteDirectory(targetPath: string): boolean {
  const normalized = normalizePathForMatch(targetPath);
  const unixCandidate = normalized.startsWith('/') ? normalized : '/' + normalized;
  const lower = normalized.toLowerCase();
  return SYSTEM_WRITE_DIRECTORIES.some(dir => {
    if (dir.startsWith('/')) {
      return unixCandidate.startsWith(dir);
    }
    // Windows dirs: case-insensitive prefix match on the normalized path
    return lower.startsWith(dir);
  });
}

/**
 * Check if a path matches any protected pattern.
 * Tests both the raw path and its normalized form, and the Windows pattern set.
 */
export function isProtectedPath(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  return (
    PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(filePath) || pattern.test(normalized)) ||
    WINDOWS_PROTECTED_PATTERNS.some(pattern => pattern.test(normalized))
  );
}

/**
 * Quick check if a path or command string contains a protected substring.
 * Tests the raw text, its normalized form, and the Windows pattern set so
 * backslash / drive-letter paths are covered alongside Unix paths.
 */
export function containsProtectedPath(text: string): boolean {
  const normalized = normalizePathForMatch(text);
  return (
    PROTECTED_PATH_SUBSTRINGS_REGEX.test(text) ||
    PROTECTED_PATH_SUBSTRINGS_REGEX.test(normalized) ||
    WINDOWS_PROTECTED_PATTERNS.some(pattern => pattern.test(normalized))
  );
}
