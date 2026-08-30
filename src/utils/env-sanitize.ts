// Shared environment sanitization — SEC-03
//
// Canonical implementation of the child-process environment filter. It lives
// under `src/utils/` so non-tool layers (the local shell executor, MCP
// transports) can reuse it without a reverse dependency on `src/tools/`.
//
// Contract: whatever `buildSafeEnv()` returns is a COMPLETE child environment.
// Never spread `process.env` underneath it — doing so re-introduces every
// secret the filter just stripped (see round4 §2-S1/S2).

import { logger } from '../services/logger';

/** Variables a child process legitimately needs in order to function. */
const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'NODE_ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

/**
 * Prefixes rejected from caller-supplied values even when explicitly passed.
 * Last line of defence: a caller that forwards an untrusted config (MCP
 * `env`, `Run` tool `env`) must not be able to re-inject host secrets.
 */
const ENV_DENY_PREFIX = ['KC_', 'ANTHROPIC_', 'OPENAI_', 'AWS_SECRET', 'GITHUB_TOKEN'];

/**
 * Code-injection / privilege-escalation vectors. Applied to caller-supplied
 * values so an explicit `env` cannot be used to preload libraries or hijack
 * interpreter startup. (Host-supplied values never reach this set: the host
 * side is governed by `ENV_ALLOWLIST`.)
 */
const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5LIB',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
  'PATH',
  'HOME',
  'SHELL',
  'BASH_ENV',
  'PROMPT_COMMAND',
  'IFS',
  'CDPATH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'ANSIBLE_CONFIG',
  'DOCKER_HOST',
  'KUBECONFIG',
]);

/**
 * Escape hatch: `KC_ALLOW_ENV_VARS=a,b,c` re-admits specific host variables
 * that the allowlist omits. Read on every call so tests and late configuration
 * changes take effect.
 */
function getAllowlistedEnvVars(): Set<string> {
  return new Set(
    (process.env.KC_ALLOW_ENV_VARS ?? '')
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
  );
}

/** True when a caller-supplied key must never reach a child process. */
function isRejectedOverride(key: string, allowlisted: Set<string>): boolean {
  const upperKey = key.toUpperCase();
  if (allowlisted.has(upperKey)) return false;
  if (ENV_DENY_PREFIX.some((p) => upperKey.startsWith(p.toUpperCase()))) return true;
  return DANGEROUS_ENV_VARS.has(upperKey);
}

/**
 * Build a minimal, secret-free environment for a child process.
 *
 * @param overrides Caller-declared variables layered on top of the allowlist.
 *                  Rejected silently-but-visibly when they match
 *                  `ENV_DENY_PREFIX` or `DANGEROUS_ENV_VARS` (logged).
 */
export function buildSafeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const allowlisted = getAllowlistedEnvVars();
  const out: Record<string, string> = {};

  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }

  for (const key of allowlisted) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }

  const blockedVars: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (isRejectedOverride(key, allowlisted)) {
      blockedVars.push(key);
      continue;
    }
    out[key] = value;
  }

  if (blockedVars.length > 0) {
    logger.tools.warn('Blocked dangerous/secret environment variables', { blockedVars });
  }

  return out;
}

/**
 * Strip KC_* secrets and known-dangerous variables from a caller-supplied
 * record. Unlike `buildSafeEnv` this does not add anything from the host —
 * use it when filtering a record that is meant to stay self-contained.
 */
export function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const allowlisted = getAllowlistedEnvVars();
  const filtered: Record<string, string> = {};
  const blockedVars: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (isRejectedOverride(key, allowlisted)) {
      blockedVars.push(key);
      continue;
    }
    filtered[key] = value;
  }

  if (blockedVars.length > 0) {
    logger.tools.warn('Blocked dangerous/secret environment variables', { blockedVars });
  }

  return filtered;
}
