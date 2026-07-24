/**
 * T6 (M1): Unified operation audit log.
 *
 * Persists a compact, append-only audit trail of high-risk tool executions
 * (file writes/edits/restores, command and network tools) so a completed
 * session can be reconstructed after the fact: which tool ran, on what
 * (summary only), the permission decision, whether it was sandboxed,
 * success/failure, duration, and any backup snapshot produced.
 *
 * Design mirrors `agp/audit-log.ts` (ring buffer + persistence) with three
 * deliberate differences for the tool hot path:
 *   - Entries are appended as JSON Lines to a per-date file
 *     (`.kc-cli/audit/operations-<date>.jsonl`) rather than rewriting a blob.
 *   - Disk writes are async and serialized (fire-and-forget); the tool path is
 *     never blocked. `flush()` drains the queue for graceful shutdown.
 *   - Only summaries/metadata are recorded — never file contents — and the
 *     input summary is redacted (single line, length-capped) so sensitive
 *     payloads in protected paths are not persisted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getState } from '../bootstrap/state';

export interface OperationAuditEntry {
  /** Unique entry ID. */
  id: string;
  /** Timestamp (ms epoch). */
  ts: number;
  /** Session ID the operation ran under. */
  sessionId: string;
  /** Tool name (FileWrite, Bash, …). */
  tool: string;
  /** Redacted, length-capped summary of the operation target (never content). */
  inputSummary: string;
  /** Permission gate outcome for this operation. */
  permissionDecision: 'allow' | 'deny' | 'ask';
  /** Whether the operation ran inside a sandbox. */
  sandboxed: boolean;
  /** Whether the operation reported an error. */
  isError: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Backup snapshot produced by the operation (T2), if any. */
  backupPath?: string;
  /** Whether the operation timed out. */
  timedOut?: boolean;
}

export interface OperationAuditFilter {
  sessionId?: string;
  tool?: string;
  /** Inclusive lower bound on timestamp. */
  since?: number;
  /** Inclusive upper bound on timestamp. */
  until?: number;
  /** Filter by error state. */
  isError?: boolean;
  /** Keep only the most recent N results. */
  limit?: number;
}

const MAX_SUMMARY_LEN = 200;

/**
 * Redact an input summary: collapse to a single whitespace-normalized line and
 * cap the length so no large or multi-line payload can leak into the audit log.
 */
export function redactAuditSummary(raw: string | undefined): string {
  if (!raw) return '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SUMMARY_LEN ? oneLine.slice(0, MAX_SUMMARY_LEN) + '…' : oneLine;
}

let auditCounter = 0;
function generateId(): string {
  return `op_${Date.now().toString(36)}_${(auditCounter++).toString(36)}`;
}

function dateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

export class OperationAuditLog {
  private entries: OperationAuditEntry[] = [];
  private maxEntries: number;
  private persistEnabled: boolean;
  private explicitPersistDir?: string;
  private resolvedPersistDir?: string | null;
  /** Serializes async appends so on-disk order matches record() order. */
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;
  private beforeExitRegistered = false;

  constructor(options?: { maxEntries?: number; persistDir?: string; persist?: boolean }) {
    this.maxEntries = options?.maxEntries ?? 5000;
    this.explicitPersistDir = options?.persistDir;
    this.persistEnabled = options?.persist ?? true;
  }

  /**
   * Record an operation. Pushes to the in-memory ring buffer synchronously and
   * enqueues an async disk append (never awaited on the caller's path).
   */
  record(entry: Omit<OperationAuditEntry, 'id' | 'ts'> & { ts?: number }): OperationAuditEntry {
    const full: OperationAuditEntry = {
      ...entry,
      inputSummary: redactAuditSummary(entry.inputSummary),
      id: generateId(),
      ts: entry.ts ?? Date.now(),
    };

    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    if (this.persistEnabled) {
      const dir = this.resolvePersistDir();
      if (dir) {
        this.enqueueAppend(dir, full);
        this.ensureBeforeExitFlush();
      }
    }

    return full;
  }

  /**
   * Resolve the persistence directory. An explicit dir (tests / callers) wins;
   * otherwise derive `.kc-cli/audit/` from the active workspace. Cached (null
   * means "no workspace available" — stay in-memory only).
   */
  private resolvePersistDir(): string | null {
    if (this.explicitPersistDir) return this.explicitPersistDir;
    if (this.resolvedPersistDir !== undefined) return this.resolvedPersistDir;
    try {
      this.resolvedPersistDir = path.join(getState().cwd, '.kc-cli', 'audit');
    } catch {
      this.resolvedPersistDir = null; // state not initialized (e.g. some tests)
    }
    return this.resolvedPersistDir;
  }

  private enqueueAppend(dir: string, entry: OperationAuditEntry): void {
    const file = path.join(dir, `operations-${dateStamp(entry.ts)}.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirEnsured) {
          await fs.promises.mkdir(dir, { recursive: true });
          this.dirEnsured = true;
        }
        await fs.promises.appendFile(file, line, 'utf-8');
      })
      .catch(() => {
        // Persistence is best-effort — audit disk I/O must never crash a tool.
      });
  }

  private ensureBeforeExitFlush(): void {
    if (this.beforeExitRegistered) return;
    this.beforeExitRegistered = true;
    // Best-effort flush on graceful shutdown (mirrors CacheManager's idiom).
    process.once('beforeExit', () => {
      void this.flush();
    });
  }

  /** Await all pending async appends (graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Query buffered entries by session / tool / time / error state. */
  query(filter: OperationAuditFilter = {}): OperationAuditEntry[] {
    let results = this.entries;
    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.tool) results = results.filter(e => e.tool === filter.tool);
    if (filter.isError !== undefined) results = results.filter(e => e.isError === filter.isError);
    if (filter.since !== undefined) results = results.filter(e => e.ts >= filter.since!);
    if (filter.until !== undefined) results = results.filter(e => e.ts <= filter.until!);
    if (filter.limit !== undefined) results = results.slice(-filter.limit);
    return results;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

// ─── Process-wide singleton ────────────────────────────────────────────────

let globalOperationAuditLog: OperationAuditLog | null = null;

/**
 * Get (or lazily create) the process-wide operation audit log. All
 * ToolExecutor instances (including sub-agents) share one audit trail.
 */
export function getOperationAuditLog(options?: {
  persistDir?: string;
  persist?: boolean;
  maxEntries?: number;
}): OperationAuditLog {
  if (!globalOperationAuditLog) {
    globalOperationAuditLog = new OperationAuditLog(options);
  }
  return globalOperationAuditLog;
}

/** Reset the singleton (test isolation). */
export function resetOperationAuditLog(): void {
  globalOperationAuditLog?.clear();
  globalOperationAuditLog = null;
}

/** Drain pending appends of the singleton (explicit graceful-shutdown hook). */
export async function flushOperationAudit(): Promise<void> {
  await globalOperationAuditLog?.flush();
}

/** Query the singleton audit log (programmatic `audit query`). */
export function queryOperationAudit(filter?: OperationAuditFilter): OperationAuditEntry[] {
  return globalOperationAuditLog?.query(filter) ?? [];
}
