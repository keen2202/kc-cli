// Tests for SqlTool S1 hardening: readonly-by-default, path whitelist, block ATTACH/multi-statement
// and P2 worker_threads isolation with wall-clock timeout

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Hoisted mock for worker_threads so tests can control Worker behaviour ──
const { workerMock } = vi.hoisted(() => {
  // Shared mutable state that each test can arrange
  const mockWorker = {
    on: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn(),
    _handlers: new Map<string, (...args: any[]) => void>(),
    _receiveMessage(data: any) {
      mockWorker._handlers.get('message')?.(data);
    },
    _receiveError(err: Error) {
      mockWorker._handlers.get('error')?.(err);
    },
    _receiveExit(code: number) {
      mockWorker._handlers.get('exit')?.(code);
    },
  };
  mockWorker.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
    mockWorker._handlers.set(event, handler);
  });

  // Must use `function` keyword (not arrow) so `new Worker()` works:
  // vitest / Node rejects arrow-based mocks for constructor calls.
  const Worker = vi.fn(function workerFactory() {
    return mockWorker;
  });

  return {
    workerMock: {
      Worker,
      mockWorker,
      reset() {
        mockWorker._handlers.clear();
        vi.clearAllMocks();
        Worker.mockClear();
        // Re-bind the factory after clearAllMocks resets implementation
        Worker.mockImplementation(function workerFactory() {
          return mockWorker;
        });
      },
    },
  };
});

vi.mock('node:worker_threads', () => ({
  Worker: workerMock.Worker,
}));

// Mock cache manager to avoid real cache side effects
vi.mock('../../services/cache', () => ({
  getCacheManager: () => ({
    getOrCreate: () => ({ get: () => undefined, set: () => {} }),
  }),
}));

// Mock state module for config injection
vi.mock('../../bootstrap/state', () => ({
  getState: vi.fn(),
}));

import { tool, rejectDangerousSql, resolveAllowed } from './index';
import { getState } from '../../bootstrap/state';

function mockState(config: any = null) {
  vi.mocked(getState).mockReturnValue({
    cwd: '/test',
    config,
  } as any);
}

const baseCtx = () => ({ cwd: '/test' } as any);

describe('[S1] rejectDangerousSql — AC-S1.2', () => {
  it('blocks ATTACH', () => {
    expect(rejectDangerousSql("ATTACH '/etc/passwd' AS x")).toBe('ATTACH');
  });

  it('blocks PRAGMA writable_schema', () => {
    expect(rejectDangerousSql('PRAGMA writable_schema = 1')).toBe('PRAGMA writable_schema');
  });

  it('blocks multi-statement injection', () => {
    expect(rejectDangerousSql('SELECT 1; DROP TABLE users')).toBe('multi-statement');
  });

  it('blocks ATTACH via multi-statement', () => {
    const r = rejectDangerousSql("SELECT 1; ATTACH '/etc/x' AS y");
    expect(r).toMatch(/ATTACH|multi-statement/);
  });

  it('allows safe single SELECT', () => {
    expect(rejectDangerousSql('SELECT * FROM users')).toBeNull();
  });

  it('allows safe SELECT with trailing semicolon', () => {
    expect(rejectDangerousSql('SELECT 1;')).toBeNull();
  });

  it('allows safe PRAGMA (not writable_schema)', () => {
    expect(rejectDangerousSql('PRAGMA journal_mode')).toBeNull();
  });

  it('does not false-positive on keywords inside string literals', () => {
    expect(rejectDangerousSql("SELECT '; DROP TABLE x'")).toBeNull();
    expect(rejectDangerousSql("SELECT * FROM log WHERE msg = 'ATTACH failed'")).toBeNull();
    expect(rejectDangerousSql("SELECT '-- ATTACH DATABASE'")).toBeNull();
  });
});

describe('[S1] resolveAllowed — AC-S1.1', () => {
  it('rejects :memory:', () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    expect(resolveAllowed(getState(), ':memory:', '/test')).toBeNull();
  });

  it('rejects non-whitelisted path', () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/etc/passwd.db', '/test')).toBeNull();
  });

  it('rejects all when whitelist is empty', () => {
    mockState({ sql: { allowedPaths: [], allowWrite: false } });
    expect(resolveAllowed(getState(), '/tmp/test.db', '/test')).toBeNull();
  });

  it('rejects all when sql config is null (default-deny)', () => {
    mockState(null);
    expect(resolveAllowed(getState(), '/tmp/test.db', '/test')).toBeNull();
  });

  it('allows whitelisted absolute path', () => {
    mockState({ sql: { allowedPaths: ['/tmp/'], allowWrite: false } });
    const r = resolveAllowed(getState(), '/tmp/ok.db', '/test');
    expect(r).toEqual({ path: '/tmp/ok.db', readonly: true });
  });

  it('allows whitelisted relative path (resolved via cwd)', () => {
    mockState({ sql: { allowedPaths: ['/test/data/'], allowWrite: false } });
    const r = resolveAllowed(getState(), 'data/app.db', '/test');
    expect(r).toEqual({ path: '/test/data/app.db', readonly: true });
  });

  it('returns readonly=false when allowWrite is true', () => {
    mockState({ sql: { allowedPaths: ['/tmp/'], allowWrite: true } });
    const r = resolveAllowed(getState(), '/tmp/ok.db', '/test');
    expect(r).toEqual({ path: '/tmp/ok.db', readonly: false });
  });
});

describe('[C2] resolveAllowed traversal hardening', () => {
  it('rejects sibling directory sharing the whitelist prefix (/data/dbs-backup)', () => {
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/data/dbs-backup/x.db', '/test')).toBeNull();
  });

  it('rejects input containing a ".." segment (fail-closed)', () => {
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/data/dbs/../x.db', '/test')).toBeNull();
  });

  it('rejects ".." even when normalization would land inside the whitelist', () => {
    // /data/dbs/../dbs/x.db normalizes to /data/dbs/x.db (inside), but the raw
    // input carries a '..' segment and must fail closed regardless.
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/data/dbs/../dbs/x.db', '/test')).toBeNull();
  });

  it('rejects relative-path traversal joined via cwd (../ escape)', () => {
    mockState({ sql: { allowedPaths: ['/test/data'], allowWrite: false } });
    expect(resolveAllowed(getState(), '../escape.db', '/test/data')).toBeNull();
  });

  it('allows a target equal to the whitelist entry itself (exact boundary)', () => {
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/data/dbs', '/test')).toEqual({
      path: '/data/dbs',
      readonly: true,
    });
  });

  it('allows a nested path under the whitelist boundary', () => {
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    expect(resolveAllowed(getState(), '/data/dbs/sub/app.db', '/test')).toEqual({
      path: '/data/dbs/sub/app.db',
      readonly: true,
    });
  });

  it('rejects a symlink inside the whitelist pointing outside (real fs)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sqltool-c2-'));
    try {
      const inside = join(tmp, 'dbs');
      const outside = join(tmp, 'outside');
      mkdirSync(inside);
      mkdirSync(outside);
      const secret = join(outside, 'secret.db');
      writeFileSync(secret, 'not a real database');
      symlinkSync(secret, join(inside, 'leak.db'));

      mockState({ sql: { allowedPaths: [inside], allowWrite: false } });
      expect(resolveAllowed(getState(), join(inside, 'leak.db'), '/test')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still allows a real file directly inside the whitelist (real fs)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sqltool-c2-'));
    try {
      const inside = join(tmp, 'dbs');
      mkdirSync(inside);
      const legit = join(inside, 'app.db');
      writeFileSync(legit, 'not a real database');

      mockState({ sql: { allowedPaths: [inside], allowWrite: false } });
      expect(resolveAllowed(getState(), legit, '/test')).toEqual({
        path: legit,
        readonly: true,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows an internal symlink whose target stays inside the whitelist (real fs)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sqltool-c2-'));
    try {
      const inside = join(tmp, 'dbs');
      mkdirSync(inside);
      const real = join(inside, 'real.db');
      writeFileSync(real, 'not a real database');
      symlinkSync(real, join(inside, 'alias.db'));

      mockState({ sql: { allowedPaths: [inside], allowWrite: false } });
      expect(resolveAllowed(getState(), join(inside, 'alias.db'), '/test')).toEqual({
        path: join(inside, 'alias.db'),
        readonly: true,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('[S1] tool.call rejection paths — AC-S1.1/S1.2/S1.3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects :memory: via call (AC-S1.1)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call({ query: 'SELECT 1', database: ':memory:', timeout: 30 }, baseCtx());
    expect(r.isError).toBe(true);
    expect(r.message).toContain('whitelist');
  });

  it('rejects non-whitelisted path via call (AC-S1.1)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call(
      { query: 'SELECT 1', database: '/etc/passwd.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
  });

  it('rejects traversal database path via call (AC-C2)', async () => {
    mockState({ sql: { allowedPaths: ['/data/dbs'], allowWrite: false } });
    for (const database of ['/data/dbs-backup/x.db', '/data/dbs/../x.db']) {
      const r = await tool.call(
        { query: 'SELECT 1', database, timeout: 30 },
        baseCtx(),
      );
      expect(r.isError).toBe(true);
    }
  });

  it('blocks ATTACH via call (AC-S1.2)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call(
      { query: "ATTACH '/etc/passwd' AS x", database: '/tmp/ok.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.message).toContain('ATTACH');
  });

  it('blocks multi-statement via call (AC-S1.2)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call(
      { query: 'SELECT 1; DROP TABLE users', database: '/tmp/ok.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.message).toContain('multi-statement');
  });

  it('rejects INSERT when allowWrite=false (AC-S1.3)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call(
      { query: 'INSERT INTO t VALUES (1)', database: '/tmp/ok.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.message).toContain('allowWrite');
  });

  it('rejects DELETE when allowWrite=false (AC-S1.3)', async () => {
    mockState({ sql: { allowedPaths: ['/tmp/ok.db'], allowWrite: false } });
    const r = await tool.call(
      { query: 'DELETE FROM t', database: '/tmp/ok.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.message).toContain('allowWrite');
  });

  it('rejects all ad-hoc when no whitelist (AC-S1.1 default-deny)', async () => {
    mockState(null);
    const r = await tool.call(
      { query: 'SELECT 1', database: '/tmp/test.db', timeout: 30 },
      baseCtx(),
    );
    expect(r.isError).toBe(true);
  });
});

// ── P2: worker_threads execution with wall-clock timeout ──────────────

describe('[P2] worker_threads execution', () => {
  beforeEach(() => {
    workerMock.reset();
  });

  // Named connection so security checks pass and the query reaches the worker
  const namedConnState = () => ({
    databaseConnections: {
      testdb: { type: 'sqlite', path: '/tmp/test.db', readonly: false },
    },
  });

  it('returns SELECT results from worker (AC-P2.1)', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT 1 AS val', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({
      type: 'result',
      data: { rows: [{ val: 1 }] },
    });

    const r = await promise;
    expect(r.isError).toBe(false);
    expect(r.output).toContain('val');
    expect(r.output).toContain('1');
  });

  it('returns write query result from worker (AC-P2.1)', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'INSERT INTO t VALUES (1)', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({
      type: 'result',
      data: { changes: 1, lastInsertRowid: 42 },
    });

    const r = await promise;
    expect(r.isError).toBe(false);
    expect(r.output).toContain('Changes: 1');
    expect(r.output).toContain('rowid: 42');
  });

  it('returns empty SELECT results from worker', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT * FROM empty', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({
      type: 'result',
      data: { rows: [] },
    });

    const r = await promise;
    expect(r.isError).toBe(false);
    expect(r.output).toContain('0 rows');
  });

  it('triggers timeout when worker does not respond (AC-P2.1/AC-P2.2)', async () => {
    mockState(namedConnState());

    // Very short timeout (10ms) so the test completes quickly; the mock worker
    // never posts a message, so the timer fires and terminates the worker.
    const r = await tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 0.01 },
      baseCtx(),
    );

    expect(r.isError).toBe(true);
    expect(r.message).toContain('timeout');
  });

  // ── R8 (round4): the worker promise must always settle ──────────────────
  // An unrecognised message type (or a `result` with no payload) used to fall
  // through every branch. The timeout had already been cleared, so the promise
  // never settled and the caller hung until the watchdog fired — if any.

  it('rejects on an unknown worker message type instead of hanging', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({ type: 'unknown' });

    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.message).toContain('Unexpected worker message type');
  });

  it('rejects on a result message with no data instead of throwing a TypeError', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({ type: 'result' });

    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.message).toContain('no data');
  });

  it('settles both malformed cases without leaking the query timeout', async () => {
    // The timeout timer is cleared on the first message, so neither case may
    // leave a pending timer that would later reject an already-settled promise.
    mockState(namedConnState());

    const first = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );
    workerMock.mockWorker._receiveMessage({ type: 'nope' });
    await expect(first).resolves.toMatchObject({ isError: true });

    workerMock.reset();
    mockState(namedConnState());

    const second = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );
    workerMock.mockWorker._receiveMessage({ type: 'result' });
    await expect(second).resolves.toMatchObject({ isError: true });
  });

  // ── R8 (round4): the worker promise must always settle ──────────────────
  // An unrecognised message type (or a `result` with no payload) used to fall
  // through every branch. The timeout had already been cleared, so the promise
  // never settled and the caller hung until the watchdog fired — if any.

  it('rejects on an unknown worker message type instead of hanging', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({ type: 'unknown' });

    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.message).toContain('Unexpected worker message type');
  });

  it('rejects on a result message with no data instead of throwing a TypeError', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({ type: 'result' });

    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.message).toContain('no data');
  });

  it('settles both malformed cases without leaking the query timeout', async () => {
    // The timeout timer is cleared on the first message, so neither case may
    // leave a pending timer that would later reject an already-settled promise.
    mockState(namedConnState());

    const first = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );
    workerMock.mockWorker._receiveMessage({ type: 'nope' });
    await expect(first).resolves.toMatchObject({ isError: true });

    workerMock.reset();
    mockState(namedConnState());

    const second = tool.call(
      { query: 'SELECT 1', database: 'testdb', timeout: 30 },
      baseCtx(),
    );
    workerMock.mockWorker._receiveMessage({ type: 'result' });
    await expect(second).resolves.toMatchObject({ isError: true });
  });

  it('propagates error from worker', async () => {
    mockState(namedConnState());

    const promise = tool.call(
      { query: 'SELECT invalid', database: 'testdb', timeout: 30 },
      baseCtx(),
    );

    workerMock.mockWorker._receiveMessage({
      type: 'error',
      error: 'no such table: invalid',
    });

    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.message).toContain('no such table');
  });
});
