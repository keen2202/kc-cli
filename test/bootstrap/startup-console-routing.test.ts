// T21 / M9a: startup failure-path output goes through the logger — round4 §6-M9a
//
// Bootstrap.compose() requires a full environment (state, config, MCP, plugins),
// so — following the established entry-point pattern (crash-guards.test.ts) —
// these assertions inspect the source to pin the invariant: failure paths call
// logger.*, and bare console.* survives only for deliberate user-facing
// startup banners (verbose status lines, the T05 trust-gate notice).

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('T21: bootstrap failure paths route through logger', () => {
  let source = '';

  it('parses the bootstrap source', async () => {
    source = (await readFile(new URL('../../src/bootstrap/Bootstrap.ts', import.meta.url), 'utf-8'))
      .replace(/\r\n/g, '\n');
    expect(source.length).toBeGreaterThan(1000);
  });

  it('has no bare console.error left on failure paths', () => {
    expect(source).not.toMatch(/console\.error/);
  });

  it('routes known failure messages through logger', () => {
    const flat = source.replace(/\s+/g, ' ');
    expect(flat).toContain('logger.mcp.warn( `MCP server "${serverId}" failed to connect`,');
    expect(flat).toContain('logger.mcp.warn( `Plugin MCP server "${pluginServer.serverId}" failed to connect`,');
    expect(flat).toContain("logger.mcp.error('Suppressed error during MCP init'");
    expect(flat).toContain("logger.plugins.error('Suppressed error during plugin init'");
    expect(flat).toContain("logger.services.warn( 'No Git repository detected");
    expect(flat).toContain('logger.services.error(`IM bridge failed to start');
    expect(flat).toContain('logger.services.warn( `AGP: initialization skipped');
  });

  it('keeps the deliberate user-facing startup banners (not failures)', () => {
    // T05 trust gate: dual-channel by design (logger.mcp.warn alongside).
    expect(source).toContain('console.warn(');
    // verbose status lines stay on stdout for TTY users.
    expect(source).toContain('console.log(chalk.gray(`  MCP: ${serverId} (${mcpTools.length} tools)`))');
  });
});
