// MCP schema validation + project trust gate — round4 §2-S6

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => files.has(String(p))),
    promises: {
      ...actual.promises,
      readFile: vi.fn(async (p: unknown) => {
        const content = files.get(String(p));
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
        }
        return content;
      }),
    },
    readFileSync: vi.fn((p: unknown) => {
      const content = files.get(String(p));
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
      }
      return content;
    }),
    writeFileSync: vi.fn((p: unknown, data: unknown) => {
      files.set(String(p), String(data));
    }),
    mkdirSync: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn(() => HOME) };
});

const HOME = path.join(os.tmpdir(), 'kc-mcp-trust-home');
const PROJECT = path.join(os.tmpdir(), 'kc-mcp-trust-project');

const USER_CONFIG = path.join(HOME, '.kc-cli', 'mcp.json');
const PROJECT_CONFIG = path.join(PROJECT, '.mcp.json');
const TRUST_FILE = path.join(HOME, '.kc-cli', 'mcp-trust.json');

import { loadMCPConfig } from '../../src/mcp/config-loader';
import { MCPServerConfigSchema } from '../../src/mcp/schema';
import { evaluateTrust, trustServer, isTrusted } from '../../src/mcp/trust-store';

function writeConfig(target: string, json: unknown): void {
  files.set(target, typeof json === 'string' ? json : JSON.stringify(json));
}

describe('MCPServerConfigSchema', () => {
  it('accepts a well-formed stdio server', () => {
    expect(MCPServerConfigSchema.safeParse({ type: 'stdio', command: 'srv' }).success).toBe(true);
  });

  it('accepts a well-formed http server', () => {
    expect(
      MCPServerConfigSchema.safeParse({ type: 'http', url: 'https://example.com/mcp' }).success,
    ).toBe(true);
  });

  it('rejects a non-string command', () => {
    // The audit's motivating case: `command: 123` used to reach spawn() and
    // blow up deep inside child_process.
    expect(MCPServerConfigSchema.safeParse({ type: 'stdio', command: 123 }).success).toBe(false);
  });

  it('rejects a stdio server with no command', () => {
    expect(MCPServerConfigSchema.safeParse({ type: 'stdio' }).success).toBe(false);
  });

  it('rejects an http server with no url', () => {
    expect(MCPServerConfigSchema.safeParse({ type: 'http' }).success).toBe(false);
  });

  it('rejects an unknown transport type', () => {
    expect(MCPServerConfigSchema.safeParse({ type: 'grpc', command: 'srv' }).success).toBe(false);
  });
});

describe('loadMCPConfig schema enforcement', () => {
  beforeEach(() => {
    files.clear();
  });

  it('drops a server whose command is not a string', async () => {
    writeConfig(PROJECT_CONFIG, {
      mcpServers: { bad: { type: 'stdio', command: 123 }, good: { type: 'stdio', command: 'ok' } },
    });

    const result = await loadMCPConfig(PROJECT);

    expect(result.servers).not.toHaveProperty('bad');
    expect(result.servers).toHaveProperty('good');
    expect(result.rejected.map((r) => r.name)).toContain('bad');
  });

  it('drops a stdio server without a command and reports why', async () => {
    writeConfig(PROJECT_CONFIG, { mcpServers: { 'no-cmd': { type: 'stdio' } } });

    const result = await loadMCPConfig(PROJECT);

    expect(result.servers).toEqual({});
    expect(result.rejected[0]?.name).toBe('no-cmd');
    expect(result.rejected[0]?.reason).toMatch(/command/i);
  });

  it('returns no servers for malformed JSON', async () => {
    writeConfig(PROJECT_CONFIG, 'not valid json{{{');

    const result = await loadMCPConfig(PROJECT);

    expect(result.servers).toEqual({});
  });

  it('records which file each server came from', async () => {
    writeConfig(USER_CONFIG, { mcpServers: { 'user-srv': { type: 'stdio', command: 'u' } } });
    writeConfig(PROJECT_CONFIG, { mcpServers: { 'proj-srv': { type: 'stdio', command: 'p' } } });

    const result = await loadMCPConfig(PROJECT);

    expect(result.origins['user-srv']).toBe('user');
    expect(result.origins['proj-srv']).toBe('project');
  });
});

describe('project trust gate', () => {
  beforeEach(() => {
    files.clear();
  });

  it('leaves every untrusted project server pending in non-interactive mode', () => {
    const decision = evaluateTrust(['a', 'b'], PROJECT, { interactive: false });

    expect(decision.pending).toEqual(['a', 'b']);
    expect(Object.keys(decision.approved)).toHaveLength(0);
  });

  it('does not prompt at all when non-interactive', () => {
    const prompt = vi.fn(() => true);
    evaluateTrust(['a'], PROJECT, { interactive: false, prompt });

    expect(prompt).not.toHaveBeenCalled();
  });

  it('approves a server once the trust store records it', () => {
    expect(isTrusted(PROJECT, 'a')).toBe(false);
    trustServer(PROJECT, 'a');
    expect(isTrusted(PROJECT, 'a')).toBe(true);

    const decision = evaluateTrust(['a'], PROJECT, { interactive: false });
    expect(Object.keys(decision.approved)).toEqual(['a']);
    expect(decision.pending).toEqual([]);
  });

  it('scopes trust to the project directory', () => {
    trustServer(PROJECT, 'a');
    const otherProject = path.join(os.tmpdir(), 'kc-mcp-trust-other');

    expect(isTrusted(otherProject, 'a')).toBe(false);
    expect(evaluateTrust(['a'], otherProject, { interactive: false }).pending).toEqual(['a']);
  });

  it('persists the decision to the trust file', () => {
    trustServer(PROJECT, 'persisted');

    expect(files.has(TRUST_FILE)).toBe(true);
    expect(files.get(TRUST_FILE)).toContain('persisted');
  });

  it('approves interactively when the user answers yes, and remembers it', () => {
    const prompt = vi.fn(() => true);
    const first = evaluateTrust(['interactive-srv'], PROJECT, { interactive: true, prompt });
    expect(first.pending).toEqual([]);
    expect(prompt).toHaveBeenCalledWith('interactive-srv');

    // Second run must not ask again.
    const promptAgain = vi.fn(() => true);
    const second = evaluateTrust(['interactive-srv'], PROJECT, {
      interactive: true,
      prompt: promptAgain,
    });
    expect(promptAgain).not.toHaveBeenCalled();
    expect(Object.keys(second.approved)).toEqual(['interactive-srv']);
  });

  it('keeps a server pending when the user answers no', () => {
    const decision = evaluateTrust(['nope'], PROJECT, { interactive: true, prompt: () => false });

    expect(decision.pending).toEqual(['nope']);
  });

  it('does not gate user-global servers', async () => {
    // The gate is driven by `origins`, so a user-global server never reaches
    // evaluateTrust at all — this pins that contract.
    writeConfig(USER_CONFIG, { mcpServers: { 'user-srv': { type: 'stdio', command: 'u' } } });

    const result = await loadMCPConfig(PROJECT);
    const gated = Object.entries(result.origins)
      .filter(([, origin]) => origin === 'project')
      .map(([name]) => name);

    expect(gated).toEqual([]);
    expect(result.servers).toHaveProperty('user-srv');
  });
});
