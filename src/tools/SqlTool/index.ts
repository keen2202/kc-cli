// SQL Tool - Real database queries via better-sqlite3

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { getState } from '../../bootstrap/state';
import { getCacheManager } from '../../services/cache';

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

function getDb(databasePath: string): SqliteDatabase {
  const cached = dbCache.get(databasePath);
  if (cached) return cached;

  try {
    const Database = require('better-sqlite3');
    const db = new Database(databasePath, { readonly: false });
    db.pragma('journal_mode = WAL');
    dbCache.set(databasePath, db);
    return db;
  } catch (error) {
    throw new Error(`Failed to open database "${databasePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
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
const SANITIZE_ERROR_REGEX = /\/[^\s]+\.(?:db|sqlite)|\/tmp\/[^\s]+/gi;

function sanitizeError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // Remove file paths from error messages for security (single regex)
  return msg.replace(SANITIZE_ERROR_REGEX, (match) =>
    match.startsWith('/tmp/') ? '[temp]' : '[database]'
  );
}

export const tool = buildTool<SqlInput, string>({
  name: 'Sql',
  description: 'Execute SQL database queries (SQLite via better-sqlite3)',

  inputSchema: SqlInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // Resolve named connection from config
      let dbPath: string;
      let enforceReadonly = false;

      const state = getState();
      const namedConn = state.config?.databaseConnections?.[input.database];

      if (namedConn) {
        if (namedConn.type !== 'sqlite') {
          return toolError(`Database type "${namedConn.type}" is not yet supported. Only SQLite is currently available.`);
        }
        dbPath = namedConn.path || input.database;
        enforceReadonly = namedConn.readonly === true;
        if (!dbPath.startsWith('/')) {
          dbPath = `${context.cwd}/${dbPath}`;
        }
      } else {
        dbPath = input.database === ':memory:'
          ? ':memory:'
          : input.database.startsWith('/')
            ? input.database
            : `${context.cwd}/${input.database}`;
      }

      // Enforce read-only mode for connections marked as readonly
      if (enforceReadonly && !isReadOnlyQuery(input.query)) {
        return toolError(`Connection "${input.database}" is configured as read-only. Only SELECT queries are allowed.`);
      }

      const db = getDb(dbPath);

      const queryUpper = input.query.trim().toUpperCase();

      if (isReadOnlyQuery(input.query)) {
        // SELECT / PRAGMA / EXPLAIN — return rows
        const params = input.params || [];
        const stmt = db.prepare(input.query);

        let rows: unknown[];
        try {
          rows = stmt.all(...params);
        } catch (e) {
          return toolError(`Query error: ${sanitizeError(e)}`);
        }

        if (rows.length === 0) {
          return toolResult('Query returned 0 rows.', {
            metadata: { database: input.database, rowCount: 0, queryType: 'SELECT' },
          });
        }

        // Truncate to max rows
        const truncated = rows.length > MAX_ROWS;
        const displayRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

        // Format as table-like output
        const columns = displayRows.length > 0 ? Object.keys(displayRows[0] as Record<string, unknown>) : [];
        const header = columns.join(' | ');
        const separator = columns.map(() => '---').join(' | ');
        const body = displayRows.map(row => {
          const r = row as Record<string, unknown>;
          return columns.map(c => {
            const v = r[c];
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
        const params = input.params || [];
        const stmt = db.prepare(input.query);

        let result: { changes: number; lastInsertRowid: number | bigint };
        try {
          result = stmt.run(...params);
        } catch (e) {
          return toolError(`Query error: ${sanitizeError(e)}`);
        }

        const info = [
          `Query executed successfully.`,
          `Changes: ${result.changes ?? 0} row(s) affected`,
          result.lastInsertRowid !== undefined ? `Last insert rowid: ${result.lastInsertRowid}` : '',
        ].filter(Boolean).join('\n');

        return toolResult(info, {
          metadata: {
            database: input.database,
            changes: result.changes ?? 0,
            lastInsertRowid: result.lastInsertRowid,
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
