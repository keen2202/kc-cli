// Shared environment variable filtering — SEC-03
//
// Prevents KC_* API keys, secrets, and known-dangerous system variables
// from leaking into child process environments. Used by RunTool, BashTool,
// and TaskCreateTool.

import { logger } from '../../services/logger';

// Base set of system-level dangerous env vars (code injection, privilege escalation)
const BASE_DANGEROUS_ENV_VARS = new Set([
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

// Dynamically discover all KC_* env vars at startup
function getKCEnvVars(): string[] {
  return Object.keys(process.env).filter(k => k.startsWith('KC_'));
}

// Build the full dangerous env vars set (system + KC_* + known secrets)
function buildDangerousEnvVars(): Set<string> {
  const set = new Set(BASE_DANGEROUS_ENV_VARS);
  for (const key of getKCEnvVars()) {
    set.add(key);
  }
  // Defense in depth: block known KC_ keys even if not currently set
  for (const key of ['KC_API_KEY', 'KC_SEARCH_API_KEY', 'KC_IM_FEISHU_APP_SECRET', 'KC_IM_FEISHU_APP_ID']) {
    set.add(key);
  }
  return set;
}

const DANGEROUS_ENV_VARS = buildDangerousEnvVars();

// Allowlist override via KC_ALLOW_ENV_VARS env var (comma-separated)
const ALLOWLISTED_ENV_VARS = new Set(
  (process.env.KC_ALLOW_ENV_VARS || '')
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(Boolean)
);

export function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  const blockedVars: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    // Block any KC_* prefixed key (secret convention) and known dangerous vars
    if ((upperKey.startsWith('KC_') || DANGEROUS_ENV_VARS.has(upperKey)) && !ALLOWLISTED_ENV_VARS.has(upperKey)) {
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

// Build a safe env from process.env, stripping only KC_* secrets.
// System vars (PATH, HOME, etc.) are preserved for normal operation.
// Use when a tool passes no explicit env (would otherwise inherit full parent env).
export function buildSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    // Strip any KC_* prefixed key (secret convention) from child process env
    if (upperKey.startsWith('KC_') && !ALLOWLISTED_ENV_VARS.has(upperKey)) continue;
    safe[key] = value;
  }
  return safe;
}
