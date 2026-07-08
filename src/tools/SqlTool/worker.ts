// SqlTool worker thread — executes SQLite queries in isolation
// Receives { query, path, readonly, params } via parentPort.on('message')
// Posts { type: 'result', data } or { type: 'error', error } back

import { parentPort } from 'node:worker_threads';

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
    // Dynamic require for better-sqlite3 (native module, CJS).
    // `require` is available here via tsx's ESM require shim (dev) or
    // because the compiled .js is loaded by Node as ESM where
    // --experimental-require-module (Node 22+) provides it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(msg.path, { readonly: msg.readonly, timeout: 30_000 });

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

    db.close();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Sanitize file paths from error messages for security
    const sanitized = msg.replace(
      /\/[^\s]+\.(?:db|sqlite)|\/tmp\/[^\s]+/gi,
      '[redacted]',
    );
    port.postMessage({ type: 'error', error: sanitized });
  }
});
