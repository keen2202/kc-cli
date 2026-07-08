import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { Bootstrap, buildSystemPrompt, type BootstrapOptions } from './Bootstrap';
import { resetState, initializeState } from './state';
import { resetProfile } from './profiler';
import { resetGlobalRegistry } from '../agp/registry';
import { getServiceContainer, setServiceContainer, ServiceContainer } from '../services/ServiceContainer';
import { toolRegistry } from '../tools';
import type { ToolDefinition } from '../tools/protocol';

// ── Minimal mock fixtures ──

function minimalOptions(overrides: Partial<BootstrapOptions> = {}): BootstrapOptions {
  return {
    cwd: '/tmp',
    verbose: false,
    printMode: false,
    bareMode: true, // keep bare to skip MCP/plugin/AGP side effects
    permissionMode: 'default',
    maxTurns: null,
    maxBudgetUsd: null,
    ...overrides,
  };
}

describe('Bootstrap', () => {
  beforeEach(() => {
    // Fresh DI container + state for each test
    setServiceContainer(new ServiceContainer());
    resetState();
    resetProfile();
    resetGlobalRegistry();
  });

  afterEach(() => {
    resetState();
    resetProfile();
    resetGlobalRegistry();
  });

  describe('compose()', () => {
    it('returns a wired BootstrapResult with query engine', async () => {
      const b = new Bootstrap(minimalOptions());
      const result = await b.compose();

      expect(result).toBeDefined();
      expect(result.queryEngine).toBeDefined();
      expect(result.queryEngine).toBeInstanceOf(Object); // duck-type check
      expect(result.config).toBeDefined();
      expect(result.layers).toBeDefined();
      expect(result.provider).toBeDefined();
      expect(result.model).toBeDefined();
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
    });

    it('returns lists of tools', async () => {
      const b = new Bootstrap(minimalOptions());
      const result = await b.compose();

      expect(result.tools.length).toBeGreaterThanOrEqual(0);
      // In bare mode, no built-in tools are registered
    });

    it('does not throw in minimal bare mode', async () => {
      const b = new Bootstrap(minimalOptions({ bareMode: true }));
      await expect(b.compose()).resolves.toBeDefined();
    });

    it('does not throw in non-bare mode either (no MCP/plugin config present)', async () => {
      const b = new Bootstrap(minimalOptions({ bareMode: false }));
      await expect(b.compose()).resolves.toBeDefined();
    });

    it('returns null imBridge when IM is not enabled', async () => {
      const b = new Bootstrap(minimalOptions({ im: false }));
      const result = await b.compose();
      expect(result.imBridge).toBeNull();
    });

    it('returns null mcpManager in bare mode', async () => {
      const b = new Bootstrap(minimalOptions({ bareMode: true }));
      const result = await b.compose();
      expect(result.mcpManager).toBeNull();
    });

    it('config provider and model flow through correctly', async () => {
      const b = new Bootstrap(minimalOptions({
        provider: 'anthropic',
        model: 'claude-3-opus',
      }));
      const result = await b.compose();
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-3-opus');
    });
  });

  describe('buildSystemPrompt', () => {
    beforeEach(() => {
      // buildSystemPrompt calls getState().cwd, so state must be initialized
      initializeState({ cwd: '/tmp' });
    });

    it('returns a string containing tool names', () => {
      const tools: ToolDefinition[] = [
        { name: 'read', description: 'Read files', inputSchema: z.object({}), call: async () => ({ output: '', isError: false }), isReadOnly: () => true, isConcurrencySafe: () => true },
        { name: 'write', description: 'Write files', inputSchema: z.object({}), call: async () => ({ output: '', isError: false }), isReadOnly: () => false, isConcurrencySafe: () => false },
      ];
      const prompt = buildSystemPrompt(tools);
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('read');
      expect(prompt).toContain('write');
    });

    it('returns a string with the KC-CLI header', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).toContain('KC-CLI');
    });
  });
});
