// SQL Tool - Real database queries via better-sqlite3

import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { getState } from '../../bootstrap/state';
import { getCacheManager } from '../../services/cache';

// ESM-compatible require for loading better-sqlite3 (native CommonJS module)
const require = createRequire(import.meta.url);

const SqlInputSchema = z.object({
  query: z.string().describe('SQL query to execute'),
  database: z.string().describe('Database connection name or path to SQLite file'),
  params: z.array(z.unknown()).optional().describe('Query parameters (positional ? placeholders)'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

type SqlInput = z.infer<typeof SqlInputSchema>;

const MAX_ROWS = 1000;

// TieredCache for database connections with LRU eviction and cleanup on evict
const dbCache = getCacheManager().getOrCreate<any>('sql-connections', 'tool', {
  maxSize: 20,
  onEvict: (_key, entry) => {
    // Close database connection when evicted from cache
    try {
      if (entry.value && typeof entry.value.close === 'function') {
        entry.value.close();
      }
    } catch {}
  },
});

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  pragma(pragma: string): void;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

function getDb(databasePath: string, readonly: boolean, timeoutMs: number = 30_000): SqliteDatabase {
  const cacheKey = `${databasePath}:${readonly}`;
  const cached = dbCache.get(cacheKey);
  if (cached) return cached;

  try {
    const Database = require('better-sqlite3');
    const db = new Database(databasePath, { readonly, timeout: timeoutMs });
    // WAL mode only for writable connections
    if (!readonly) db.pragma('journal_mode = WAL');
    dbCache.set(cacheKey, db);
    return db;
  } catch (error) {
    throw new Error(`Failed to open database "${databasePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

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

/**
 * Resolve an ad-hoc database path against the sql.allowedPaths whitelist.
 * Returns { path, readonly } if allowed, null if rejected.
 * (S1 hardening: AC-S1.1 — reject :memory: and non-whitelisted paths)
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
  const target = database.startsWith('/') ? database : `${cwd}/${database}`;
  if (!allowed.some(p => target.startsWith(p))) return null;
  return { path: target, readonly: sqlConfig.allowWrite !== true };
}

function isReadOnlyQuery(query: string): boolean {
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

// Pre-compiled regex for error sanitization (single-pass instead of 3 chained replaces)
// Covers .db, .sqlite, .sqlite3, .duckdb, .db3, .s3db extensions and all absolute paths
const SANITIZE_ERROR_REGEX = /\/[^\s]+\.(?:db|sqlite|sqlite3|duckdb|db3|s3db)\b|\/tmp\/[^\s]+|\/[^\s]+\/[^\s]+/gi;

function sanitizeError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // Remove file paths from error messages for security (single regex)
  return msg.replace(SANITIZE_ERROR_REGEX, (match) => {
    if (match.startsWith('/tmp/')) return '[temp]';
    if (/\.(?:db|sqlite|sqlite3|duckdb|db3|s3db)\b/i.test(match)) return '[database]';
    return '[path]';
  });
}

/**
 * WorkerUnavailableError — thrown when worker_threads cannot be initialised,
 * signalling the caller to fall back to direct better-sqlite3 execution.
 */
class WorkerUnavailableError extends Error {
  constructor() {
    super('Worker unavailable');
    this.name = 'WorkerUnavailableError';
  }
}

/**
 * Try to guess the path to the compiled (or source) worker file.
 * In dev (tsx) the .ts file exists; in production the .js file exists.
 */
function resolveWorkerPath(): string {
  const tsPath = fileURLToPath(new URL('worker.ts', import.meta.url));
  const jsPath = fileURLToPath(new URL('worker.js', import.meta.url));
  return existsSync(tsPath) ? tsPath : jsPath;
}

/**
 * Execute a SQL query inside a worker_thread for event-loop isolation
 * and wall-clock timeout support.
 *
 * Returns a normalised result object (type: 'select' | 'write') on
 * success; rejects on timeout, worker error, or query error.
 */
async function executeInWorker(
  params: { query: string; path: string; readonly: boolean; params: unknown[] },
  timeoutMs: number,
): Promise<
  | { type: 'select'; rows: Record<string, unknown>[] }
  | { type: 'write'; changes: number; lastInsertRowid: number | bigint }
> {
  const workerPath = resolveWorkerPath();

  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch {
    // Worker constructor failed — likely an environment without workers
    throw new WorkerUnavailableError();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('SqlTool query timeout'));
    }, timeoutMs);

    worker.on('message', (msg: { type: string; data?: any; error?: string }) => {
      clearTimeout(timer);
      if (msg.type === 'error') {
        reject(new Error(msg.error ?? 'Unknown worker error'));
      } else if (msg.type === 'result') {
        // Normalise to the same shape as executeDirect() so the caller
        // can dispatch on result.type === 'select' | 'write'.
        if ('rows' in msg.data) {
          resolve({ type: 'select', rows: msg.data.rows });
        } else {
          resolve({ type: 'write', changes: msg.data.changes, lastInsertRowid: msg.data.lastInsertRowid });
        }
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    worker.postMessage({
      query: params.query,
      path: params.path,
      readonly: params.readonly,
      params: params.params,
    });
  });
}

/**
 * Execute a SQL query directly (same-process, fallback path).
 * Used when worker_threads is unavailable.
 */
function executeDirect(
  params: { query: string; path: string; readonly: boolean; params: unknown[] },
  timeoutMs: number,
): { type: 'select'; rows: Record<string, unknown>[] } | { type: 'write'; changes: number; lastInsertRowid: number | bigint } {
  const db = getDb(params.path, params.readonly, timeoutMs);
  const stmt = db.prepare(params.query);
  const queryParams = params.params;

  if (isReadOnlyQuery(params.query)) {
    const rows = stmt.all(...queryParams) as Record<string, unknown>[];
    return { type: 'select', rows };
  }
  const result = stmt.run(...queryParams) as {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  return { type: 'write', changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}

/**
 * Execute a SQL query, preferring the worker_threads path with
 * automatic fallback to direct execution.
 */
async function executeQuery(
  params: { query: string; path: string; readonly: boolean; params: unknown[] },
  timeoutMs: number,
): Promise<
  | { type: 'select'; rows: Record<string, unknown>[] }
  | { type: 'write'; changes: number; lastInsertRowid: number | bigint }
> {
  try {
    return await executeInWorker(params, timeoutMs);
  } catch (err) {
    if (err instanceof WorkerUnavailableError) {
      return executeDirect(params, timeoutMs);
    }
    throw err;
  }
}

export const tool = buildTool<SqlInput, string>({
  name: 'Sql',
  description: 'Execute SQL database queries (SQLite via better-sqlite3)',

  inputSchema: SqlInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const state = getState();

      // S1: Block dangerous SQL patterns (ATTACH / PRAGMA writable_schema / multi-statement)
      const danger = rejectDangerousSql(input.query);
      if (danger) {
        return toolError(`Rejected dangerous SQL (${danger})`);
      }

      // Resolve database path and readonly flag
      let dbPath: string;
      let enforceReadonly: boolean;

      const namedConn = state.config?.databaseConnections?.[input.database];

      if (namedConn) {
        // Named connection from config — explicitly configured, trusted path
        if (namedConn.type !== 'sqlite') {
          return toolError(`Database type "${namedConn.type}" is not yet supported. Only SQLite is currently available.`);
        }
        dbPath = namedConn.path || input.database;
        enforceReadonly = namedConn.readonly === true;
        if (!dbPath.startsWith('/')) {
          dbPath = `${context.cwd}/${dbPath}`;
        }
      } else {
        // Ad-hoc path — must be in sql.allowedPaths whitelist (S1: AC-S1.1)
        const allowed = resolveAllowed(state, input.database, context.cwd);
        if (!allowed) {
          return toolError('SqlTool: database not in sql.allowedPaths whitelist (or :memory: rejected). Configure sql.allowedPaths to allow specific database files.');
        }
        dbPath = allowed.path;
        enforceReadonly = allowed.readonly;
      }

      // S1: Enforce readonly — write queries require sql.allowWrite=true (AC-S1.3)
      if (enforceReadonly && !isReadOnlyQuery(input.query)) {
        return toolError(`Write queries require sql.allowWrite=true or connection readonly=false. Blocked query: ${input.query.slice(0, 60)}...`);
      }

      // S1: Pass timeout to better-sqlite3 for busy_timeout enforcement (AC-S1.4)
      const timeoutMs = (input.timeout ?? 30) * 1000;

      // Execute query via worker_threads (with fallback to direct)
      const queryResult = await executeQuery({
        query: input.query,
        path: dbPath,
        readonly: enforceReadonly,
        params: input.params ?? [],
      }, timeoutMs);

      const queryUpper = input.query.trim().toUpperCase();

      if (queryResult.type === 'select') {
        // SELECT / PRAGMA / EXPLAIN — return rows
        const rows = queryResult.rows;

        if (rows.length === 0) {
          return toolResult('Query returned 0 rows.', {
            metadata: { database: input.database, rowCount: 0, queryType: 'SELECT' },
          });
        }

        // Truncate to max rows
        const truncated = rows.length > MAX_ROWS;
        const displayRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

        // Format as table-like output
        const columns = displayRows.length > 0 ? Object.keys(displayRows[0]) : [];
        const header = columns.join(' | ');
        const separator = columns.map(() => '---').join(' | ');
        const body = displayRows.map(row => {
          return columns.map(c => {
            const v = row[c];
            return v === null ? 'NULL' : String(v).slice(0, 200);
          }).join(' | ');
        }).join('\n');

        const result = [header, separator, body].join('\n');
        const suffix = truncated ? `\n\n[Truncated: showing ${MAX_ROWS} of ${rows.length} rows]` : '';

        return toolResult(result + suffix, {
          metadata: {
            database: input.database,
            rowCount: rows.length,
            displayedRows: displayRows.length,
            queryType: 'SELECT',
          },
        });
      } else {
        // INSERT / UPDATE / DELETE / CREATE — execute and return changes
        const info = [
          `Query executed successfully.`,
          `Changes: ${queryResult.changes ?? 0} row(s) affected`,
          queryResult.lastInsertRowid !== undefined ? `Last insert rowid: ${queryResult.lastInsertRowid}` : '',
        ].filter(Boolean).join('\n');

        return toolResult(info, {
          metadata: {
            database: input.database,
            changes: queryResult.changes ?? 0,
            lastInsertRowid: queryResult.lastInsertRowid,
            queryType: queryUpper.split(' ')[0],
          },
        });
      }
    } catch (error) {
      return toolError(`SQL execution failed: ${sanitizeError(error)}`);
    }
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
