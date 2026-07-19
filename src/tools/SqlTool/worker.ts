// SqlTool worker thread — executes SQLite queries in isolation
// Receives { query, path, readonly, params } via parentPort.on('message')
// Posts { type: 'result', data } or { type: 'error', error } back

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

// ESM-compatible require for loading better-sqlite3 (native CommonJS module)
const require = createRequire(import.meta.url);

const port = parentPort;
if (!port) {
  throw new Error('SqlTool worker must be run as a worker thread');
}

port.on('message', (msg: {
  query: string;
  path: string;
  readonly: boolean;
  params?: unknown[];
}) => {
  try {
    // Load better-sqlite3 (native CommonJS module) via createRequire.
    const Database = require('better-sqlite3');
    const db = new Database(msg.path, { readonly: msg.readonly, timeout: 30_000 });

    try {
      if (!msg.readonly) {
        db.pragma('journal_mode = WAL');
      }

      const stmt = db.prepare(msg.query);
      const params = msg.params ?? [];
      const upper = msg.query.trim().toUpperCase();

      if (
        upper.startsWith('SELECT') ||
        upper.startsWith('PRAGMA') ||
        upper.startsWith('EXPLAIN') ||
        upper.startsWith('SHOW') ||
        upper.startsWith('DESCRIBE')
      ) {
        // Read query — return rows
        const rows = stmt.all(...params) as Record<string, unknown>[];
        port.postMessage({ type: 'result', data: { rows } });
      } else {
        // Write query — return changes info
        const result = stmt.run(...params) as {
          changes: number;
          lastInsertRowid: number | bigint;
        };
        port.postMessage({
          type: 'result',
          data: {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          },
        });
      }
    } finally {
      // PERF-06: Always close the database handle, even on error
      db.close();
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Sanitize file paths from error messages for security
    const sanitized = errorMsg.replace(
      /\/[^\s]+\.(?:db|sqlite)|\/tmp\/[^\s]+/gi,
      '[redacted]',
    );
    port.postMessage({ type: 'error', error: sanitized });
  }
});
