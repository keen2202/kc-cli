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
