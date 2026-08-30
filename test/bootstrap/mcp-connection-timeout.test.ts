// T23 (P2): MCP connection timeout is configurable and background — round4 §5-P2

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ConfigSchema } from '../../src/bootstrap/config';

describe('T23: mcp.connectionTimeoutMs', () => {
  it('defaults to 10s (was a hardcoded 30s on the critical path)', () => {
    const config = ConfigSchema.parse({});
    expect(config.mcp.connectionTimeoutMs).toBe(10_000);
  });

  it('can be overridden per deployment', () => {
    const config = ConfigSchema.parse({ mcp: { connectionTimeoutMs: 60_000 } });
    expect(config.mcp.connectionTimeoutMs).toBe(60_000);
  });

  it('rejects non-positive or oversized values', () => {
    expect(() => ConfigSchema.parse({ mcp: { connectionTimeoutMs: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ mcp: { connectionTimeoutMs: -5 } })).toThrow();
    expect(() => ConfigSchema.parse({ mcp: { connectionTimeoutMs: 999_999 } })).toThrow();
  });

  it('bootstrap schedules MCP connects in the background (not awaited in compose)', async () => {
    // compose() requires the full runtime; the invariant "UI renders before
    // MCP connects complete" is pinned at the source level: the connection
    // promises are dispatched with `void` and only the summary is chained.
    const source = (await readFile(new URL('../../src/bootstrap/Bootstrap.ts', import.meta.url), 'utf-8'))
      .replace(/\r\n/g, '\n');
    expect(source).toContain('void Promise.allSettled(connectionPromises).then');
    // The old blocking await must be gone.
    expect(source).not.toContain('const results = await Promise.allSettled(connectionPromises)');
    // Timeout comes from config, not a hardcoded constant.
    expect(source).toContain('config.mcp?.connectionTimeoutMs ?? 10_000');
  });
});
