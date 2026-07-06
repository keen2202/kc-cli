// Tests for SqlTool S1 hardening: readonly-by-default, path whitelist, block ATTACH/multi-statement

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
