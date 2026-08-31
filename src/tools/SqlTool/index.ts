// SQL Tool - Lightweight entry: schema + metadata + permission scan + delegating call.
// Heavy runtime (better-sqlite3, worker_threads, connection cache) is deferred to impl.ts
// and loaded on first Sql invocation via dynamic import.

import { z } from 'zod';
import { buildTool } from '../../Tool';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { getState } from '../../bootstrap/state';

const SqlInputSchema = z.object({
  query: z.string().describe('SQL query to execute'),
  database: z.string().describe('Database connection name or path to SQLite file'),
  params: z.array(z.unknown()).optional().describe('Query parameters (positional ? placeholders)'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

export type SqlInput = z.infer<typeof SqlInputSchema>;

/**
 * Strip SQL comments and string literals before danger scanning to avoid
 * false positives on keywords appearing inside literals or comments
 * (e.g. `SELECT '; DROP TABLE x'` or `SELECT * FROM log WHERE msg = 'ATTACH failed'`).
 * Replaces string content with empty quotes so detection never fires on literals.
 */
function stripSqlNoise(query: string): string {
  return query
    .replace(/--[^\n]*/g, ' ')                 // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')         // block comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")       // single-quoted literals
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');       // double-quoted literals
}

/**
 * Detect dangerous SQL patterns that bypass single-statement readonly protections.
 * Returns a reason string if dangerous, null if safe.
 * (S1 hardening: AC-S1.2 — block ATTACH / PRAGMA writable_schema / multi-statement)
 */
export function rejectDangerousSql(query: string): string | null {
  const norm = stripSqlNoise(query).trim();
  // Multi-statement: semicolon followed by another SQL keyword (case-insensitive)
  if (/;[\s\S]*(select|insert|update|delete|drop|attach|pragma|create|alter|truncate)/i.test(norm)) {
    return 'multi-statement';
  }
  if (/\battach\b/i.test(norm)) return 'ATTACH';
  if (/\bpragma\s+writable_schema\b/i.test(norm)) return 'PRAGMA writable_schema';
  return null;
}

export function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.startsWith('select') ||
    normalized.startsWith('show') ||
    normalized.startsWith('describe') ||
    normalized.startsWith('explain') ||
    normalized.startsWith('pragma')
  );
}

function isDestructiveQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.startsWith('delete') ||
    normalized.startsWith('drop') ||
    normalized.startsWith('truncate') ||
    normalized.startsWith('alter')
  );
}

/**
 * Best-effort realpath: returns the fully resolved path, or null when the
 * path does not exist (or cannot be resolved). Used by resolveAllowed for
 * symlink escape protection — a not-yet-created database file is acceptable.
 */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * True when `p` contains a literal '..' path segment (either separator),
 * before any normalization.
 */
function hasDotDotSegment(p: string): boolean {
  return p.split(/[\\/]/).includes('..');
}

/**
 * Boundary-safe containment check: `candidate` lies within `base` only when it
 * equals base or extends it across a real path separator (C2 hardening — plain
 * prefix matching admitted siblings like `/data/dbs-backup` for base `/data/dbs`).
 */
function isWithin(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * Resolve an ad-hoc database path against the sql.allowedPaths whitelist.
 * Returns { path, readonly } if allowed, null if rejected.
 * (S1 hardening: AC-S1.1 — reject :memory: and non-whitelisted paths)
 * (C2 hardening: normalize via path.resolve, fail-closed on '..' segments,
 * segment-boundary whitelist matching, realpath symlink escape protection)
 */
export function resolveAllowed(
  state: ReturnType<typeof getState>,
  database: string,
  cwd: string,
): { path: string; readonly: boolean } | null {
  const sqlConfig = state.config?.sql;
  if (!sqlConfig?.allowedPaths?.length) return null; // No whitelist → deny all ad-hoc
  const allowed = sqlConfig.allowedPaths;
  // :memory: bypasses filesystem isolation — always reject for ad-hoc use
  if (database === ':memory:') return null;
  // Fail-closed on the raw input: any '..' segment means traversal and is
  // rejected outright, even if normalization would collapse it back inside
  // the whitelist (e.g. /data/dbs/../dbs/x.db).
  if (hasDotDotSegment(database)) return null;
  // Normalize before comparing: absolute inputs kept as-is, relative joined with cwd
  const target = path.resolve(database.startsWith('/') ? database : `${cwd}/${database}`);
  // Defense-in-depth per spec sketch: reject '..' segments that survive normalization
  if (target.split(path.sep).includes('..')) return null;
  // Boundary matching: an entry matches only at a path-segment boundary
  const bases = allowed.map(p => path.resolve(p));
  const isAllowed = bases.some(base => isWithin(target, base));
  if (!isAllowed) return null;
  // Realpath escape protection (symlink defense): when the target exists, its
  // resolved location must still fall under one of the whitelist entries'
  // resolved locations. Both sides are real-pathed where possible so a
  // whitelisted directory reached through a symlinked parent still matches,
  // while a symlink pointing outside the whitelist is rejected. A missing
  // target (database file not created yet) skips this check — steps above
  // already bound it to the whitelist.
  const realTarget = tryRealpath(target);
  if (realTarget !== null) {
    const escaped = !bases.some(base => isWithin(realTarget, tryRealpath(base) ?? base));
    if (escaped) return null;
  }
  return { path: target, readonly: sqlConfig.allowWrite !== true };
}

export const tool = buildTool<SqlInput, string>({
  name: 'Sql',
  description: 'Execute SQL database queries (SQLite via better-sqlite3)',

  inputSchema: SqlInputSchema,

  call: async (input, context, onProgress) => {
    const { executeSql } = await import('./impl.js');
    return executeSql(input, context, onProgress);
  },

  checkPermissions: (input): PermissionResult => {
    if (isReadOnlyQuery(input.query)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Read-only SQL query' },
      };
    }

    if (isDestructiveQuery(input.query)) {
      return {
        behavior: 'ask',
        message: `Destructive SQL: ${input.query.slice(0, 100)}...`,
      };
    }

    return {
      behavior: 'ask',
      message: `Execute SQL: ${input.query.slice(0, 100)}...`,
    };
  },

  isReadOnly: (input) => isReadOnlyQuery(input.query),
  isConcurrencySafe: () => true,
  isDestructive: (input) => isDestructiveQuery(input.query),

  prompt: () => 'Execute SQL queries. SELECT/PRAGMA/EXPLAIN are auto-allowed. Uses SQLite via better-sqlite3.',

  getToolUseSummary: (input) => `SQL: ${input.query.slice(0, 80)}...`,
  getActivityDescription: (input) => `Querying database: ${input.database}`,
});
