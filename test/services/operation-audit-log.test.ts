// Tests for T6 (M1): unified operation audit log.
//
// Covers:
// - redactAuditSummary: single-line collapse + length cap
// - record() pushes to the in-memory ring buffer and redacts summaries
// - ring buffer rolls over at maxEntries (oldest dropped)
// - query() filters by session / tool / time window / error state / limit
// - async persistence appends valid JSON Lines to operations-<date>.jsonl
// - flush() drains pending writes so on-disk order matches record() order
// - persist:false stays in-memory only (no directory created)
// - singleton helpers (get/reset/flush/query) share one trail

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  OperationAuditLog,
  redactAuditSummary,
  getOperationAuditLog,
  resetOperationAuditLog,
  flushOperationAudit,
  queryOperationAudit,
  type OperationAuditEntry,
} from '../../src/services/operation-audit-log';

type RecordInput = Omit<OperationAuditEntry, 'id' | 'ts'> & { ts?: number };

/** Build a minimal valid record payload, overridable per test. */
function makeEntry(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    sessionId: 'sess-1',
    tool: 'FileWrite',
    inputSummary: 'src/foo.ts',
    permissionDecision: 'allow',
    sandboxed: false,
    isError: false,
    durationMs: 5,
    ...overrides,
  };
}

describe('redactAuditSummary', () => {
  it('returns an empty string for undefined/empty input', () => {
    expect(redactAuditSummary(undefined)).toBe('');
    expect(redactAuditSummary('')).toBe('');
  });

  it('collapses whitespace and newlines to a single line', () => {
    expect(redactAuditSummary('  git   commit\n-m  "wip"  ')).toBe('git commit -m "wip"');
  });

  it('caps very long summaries and appends an ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = redactAuditSummary(long);
    expect(out.length).toBe(201); // 200 chars + '…'
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('OperationAuditLog (in-memory)', () => {
  let log: OperationAuditLog;

  beforeEach(() => {
    log = new OperationAuditLog({ persist: false });
  });

  it('records an operation and exposes it via query()', () => {
    const entry = log.record(makeEntry({ tool: 'Bash', inputSummary: 'ls -la' }));

    expect(entry.id).toMatch(/^op_/);
    expect(entry.ts).toBeGreaterThan(0);
    expect(log.size).toBe(1);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0].tool).toBe('Bash');
    expect(log.query()[0].inputSummary).toBe('ls -la');
  });

  it('redacts the input summary on record()', () => {
    const entry = log.record(makeEntry({ inputSummary: 'line1\n  line2\t\tline3' }));
    expect(entry.inputSummary).toBe('line1 line2 line3');
  });

  it('rolls the ring buffer at maxEntries, dropping the oldest', () => {
    const small = new OperationAuditLog({ persist: false, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      small.record(makeEntry({ inputSummary: `op-${i}` }));
    }
    expect(small.size).toBe(3);
    const summaries = small.query().map(e => e.inputSummary);
    expect(summaries).toEqual(['op-2', 'op-3', 'op-4']);
  });

  it('clear() empties the buffer', () => {
    log.record(makeEntry());
    log.record(makeEntry());
    expect(log.size).toBe(2);
    log.clear();
    expect(log.size).toBe(0);
    expect(log.query()).toHaveLength(0);
  });
});

describe('OperationAuditLog.query filters', () => {
  let log: OperationAuditLog;

  beforeEach(() => {
    log = new OperationAuditLog({ persist: false });
    log.record(makeEntry({ sessionId: 'a', tool: 'FileWrite', isError: false, ts: 1000 }));
    log.record(makeEntry({ sessionId: 'a', tool: 'Bash', isError: true, ts: 2000 }));
    log.record(makeEntry({ sessionId: 'b', tool: 'FileWrite', isError: false, ts: 3000 }));
  });

  it('filters by sessionId', () => {
    expect(log.query({ sessionId: 'a' })).toHaveLength(2);
    expect(log.query({ sessionId: 'b' })).toHaveLength(1);
  });

  it('filters by tool', () => {
    expect(log.query({ tool: 'FileWrite' })).toHaveLength(2);
    expect(log.query({ tool: 'Bash' })).toHaveLength(1);
  });

  it('filters by error state', () => {
    expect(log.query({ isError: true })).toHaveLength(1);
    expect(log.query({ isError: false })).toHaveLength(2);
  });

  it('filters by an inclusive time window', () => {
    expect(log.query({ since: 2000 })).toHaveLength(2);
    expect(log.query({ until: 2000 })).toHaveLength(2);
    expect(log.query({ since: 2000, until: 2000 })).toHaveLength(1);
  });

  it('limits to the most recent N results', () => {
    const recent = log.query({ limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent.map(e => e.ts)).toEqual([2000, 3000]);
  });
});

describe('OperationAuditLog persistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'op-audit-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /** Read every persisted entry across all operations-*.jsonl files. */
  function readPersisted(dir: string): OperationAuditEntry[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.startsWith('operations-') && f.endsWith('.jsonl'))
      .flatMap(f =>
        fs
          .readFileSync(path.join(dir, f), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as OperationAuditEntry),
      );
  }

  it('appends records as JSON Lines and flush() drains the queue', async () => {
    const log = new OperationAuditLog({ persistDir: tmpDir });
    log.record(makeEntry({ inputSummary: 'first', ts: 1000 }));
    log.record(makeEntry({ inputSummary: 'second', ts: 1000 }));

    await log.flush();

    const persisted = readPersisted(tmpDir);
    expect(persisted).toHaveLength(2);
    // On-disk order matches record() order (serialized write chain).
    expect(persisted.map(e => e.inputSummary)).toEqual(['first', 'second']);
    expect(persisted[0].id).toMatch(/^op_/);
  });

  it('writes to a per-date file named operations-<date>.jsonl', async () => {
    const log = new OperationAuditLog({ persistDir: tmpDir });
    const ts = Date.parse('2026-07-24T12:00:00Z');
    log.record(makeEntry({ ts }));
    await log.flush();

    const files = fs.readdirSync(tmpDir);
    expect(files).toContain('operations-2026-07-24.jsonl');
  });

  it('does not persist or create a directory when persist:false', async () => {
    const memDir = path.join(tmpDir, 'should-not-exist');
    const log = new OperationAuditLog({ persist: false, persistDir: memDir });
    log.record(makeEntry());
    await log.flush();

    expect(fs.existsSync(memDir)).toBe(false);
    expect(log.size).toBe(1);
  });

  it('persists a redacted, content-free summary only', async () => {
    const log = new OperationAuditLog({ persistDir: tmpDir });
    log.record(makeEntry({ inputSummary: 'secret\nmultiline\nvalue' }));
    await log.flush();

    const persisted = readPersisted(tmpDir);
    expect(persisted[0].inputSummary).toBe('secret multiline value');
  });
});

describe('operation audit singleton helpers', () => {
  afterEach(() => {
    resetOperationAuditLog();
  });

  it('shares one trail across getOperationAuditLog() calls', () => {
    const a = getOperationAuditLog({ persist: false });
    const b = getOperationAuditLog();
    expect(a).toBe(b);

    a.record(makeEntry({ tool: 'Git', inputSummary: 'status' }));
    expect(queryOperationAudit()).toHaveLength(1);
    expect(queryOperationAudit({ tool: 'Git' })).toHaveLength(1);
  });

  it('resetOperationAuditLog() clears state for the next test', () => {
    getOperationAuditLog({ persist: false }).record(makeEntry());
    expect(queryOperationAudit()).toHaveLength(1);
    resetOperationAuditLog();
    expect(queryOperationAudit()).toHaveLength(0);
  });

  it('flushOperationAudit() is safe when no singleton exists', async () => {
    resetOperationAuditLog();
    await expect(flushOperationAudit()).resolves.toBeUndefined();
  });
});
