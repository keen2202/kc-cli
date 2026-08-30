// Shared constants used across the codebase

/** Default max buffer size for process output (10MB) */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** Large max buffer size for heavy tools like DeployTool, RunTool (50MB) */
export const LARGE_MAX_BUFFER = 50 * 1024 * 1024;

/** Default tool execution timeout in milliseconds (30 seconds) */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Extended tool execution timeout in milliseconds (60 seconds) */
export const EXTENDED_TOOL_TIMEOUT_MS = 60_000;

/** Agent-level tool execution timeout in milliseconds (5 minutes) */
export const AGENT_TOOL_TIMEOUT_MS = 300_000;

/**
 * Source-file extensions tracked when extracting file paths from model output
 * (H2). Language-agnostic superset covering common ecosystems. Used to build
 * the extraction regexes in the query engine so new languages are picked up in
 * one place.
 */
export const TRACKED_SOURCE_EXTENSIONS: readonly string[] = [
  // Web / JS / TS
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  // Python / Ruby / PHP
  'py', 'rb', 'php',
  // Systems
  'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'kt', 'scala', 'java',
  // Shell / SQL
  'sh', 'bash', 'zsh', 'sql',
  // Config / markup
  'yaml', 'yml', 'toml', 'json', 'xml', 'html', 'css', 'scss',
  // Docs
  'md',
];

/**
 * Build a RegExp that matches file paths ending in a tracked source extension.
 * Supports both `/` and `\` separators. The character class excludes
 * whitespace and quotes so the shortest sensible path is captured.
 */
export function buildSourcePathRegex(): RegExp {
  const alt = TRACKED_SOURCE_EXTENSIONS.join('|');
  return new RegExp(`[\\w./\\\\-]+\\.(?:${alt})\\b`, 'g');
}

/** M9d: sandbox backend timeouts (probe/docker/monitor) — single shared values. */
export const SANDBOX_PROBE_TIMEOUT_MS = 10_000;
export const SANDBOX_DOCKER_CHECK_TIMEOUT_MS = 5_000;
export const SANDBOX_MONITOR_SNAPSHOT_TIMEOUT_MS = 5_000;
export const SANDBOX_MONITOR_POLL_TIMEOUT_MS = 2_000;
