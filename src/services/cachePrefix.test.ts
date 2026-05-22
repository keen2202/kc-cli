// Tests for CachePrefixService — byte-stable prefix caching

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CachePrefixService,
  canonicalStringify,
  serializeToolCanonical,
  buildCacheStrategy,
} from './cachePrefix';
import type { ToolDefinition } from '../types/tools';
import type { CacheStrategy } from '../api/capabilities';

// Helper: create a minimal ToolDefinition for tests
function makeTool(name: string, description: string, properties: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
    },
    execute: async () => ({ output: '', isError: false }),
    isEnabled: () => true,
    isConcurrencySafe: true,
    isReadOnly: () => true,
  } as unknown as ToolDefinition;
}

describe('canonicalStringify', () => {
  it('produces identical output for identical input across 1000 iterations', () => {
    const input = { z: 1, a: { b: 2, c: [3, 1, 2] }, m: null };
    const first = canonicalStringify(input);
    for (let i = 0; i < 1000; i++) {
      expect(canonicalStringify(input)).toBe(first);
    }
  });

  it('sorts object keys recursively', () => {
    const result = canonicalStringify({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys', () => {
    const result = canonicalStringify({ b: { z: 1, a: 2 } });
    expect(result).toBe('{"b":{"a":2,"z":1}}');
  });

  it('handles arrays without sorting', () => {
    const result = canonicalStringify([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles null and undefined', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(undefined)).toBe(undefined);
  });

  it('handles strings and numbers', () => {
    expect(canonicalStringify('hello')).toBe('"hello"');
    expect(canonicalStringify(42)).toBe('42');
  });

  it('same logical content with different key order produces identical output', () => {
    const a = { z: 1, a: 2, m: { c: 3, b: 4 } };
    const b = { a: 2, m: { b: 4, c: 3 }, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });
});

describe('serializeToolCanonical', () => {
  it('produces deterministic output regardless of property order', () => {
    const tool1 = makeTool('bash', 'Run a command', { command: { type: 'string' }, timeout: { type: 'number' } });
    const tool2 = makeTool('bash', 'Run a command', { timeout: { type: 'number' }, command: { type: 'string' } });

    const s1 = JSON.stringify(serializeToolCanonical(tool1));
    const s2 = JSON.stringify(serializeToolCanonical(tool2));
    expect(s1).toBe(s2);
  });

  it('includes name, description, and input_schema', () => {
    const tool = makeTool('read', 'Read a file');
    const result = serializeToolCanonical(tool);
    expect(result.name).toBe('read');
    expect(result.description).toBe('Read a file');
    expect(typeof result.input_schema).toBe('string');
  });
});

describe('buildCacheStrategy', () => {
  it('returns explicit-breakpoints for anthropic', () => {
    expect(buildCacheStrategy('anthropic')).toBe('explicit-breakpoints');
  });

  it('returns auto-prefix for deepseek', () => {
    expect(buildCacheStrategy('deepseek')).toBe('auto-prefix');
  });

  it('returns prompt-cache for openai', () => {
    expect(buildCacheStrategy('openai')).toBe('prompt-cache');
  });

  it('returns none for qwen, glm, ollama', () => {
    expect(buildCacheStrategy('qwen')).toBe('none');
    expect(buildCacheStrategy('glm')).toBe('none');
    expect(buildCacheStrategy('ollama')).toBe('none');
  });

  it('returns none for unknown providers', () => {
    expect(buildCacheStrategy('unknown')).toBe('none');
  });
});

describe('CachePrefixService', () => {
  let service: CachePrefixService;

  beforeEach(() => {
    service = new CachePrefixService('anthropic', 'explicit-breakpoints');
  });

  describe('freezePrefix', () => {
    it('returns the same frozen prefix on repeated calls', () => {
      const tools = [makeTool('bash', 'Run command')];
      const p1 = service.freezePrefix('System prompt', tools);
      const p2 = service.freezePrefix('Different prompt', tools); // no-op
      expect(p1).toBe(p2);
      expect(p1.systemPrompt).toBe('System prompt');
    });

    it('produces identical fingerprint for identical input', () => {
      const tools = [makeTool('bash', 'Run command')];
      const s1 = new CachePrefixService('deepseek', 'auto-prefix');
      const s2 = new CachePrefixService('deepseek', 'auto-prefix');

      const p1 = s1.freezePrefix('Same prompt', tools);
      const p2 = s2.freezePrefix('Same prompt', tools);
      expect(p1.fingerprint).toBe(p2.fingerprint);
    });

    it('produces different fingerprint for different input', () => {
      const tools = [makeTool('bash', 'Run command')];
      const s1 = new CachePrefixService('deepseek', 'auto-prefix');
      const s2 = new CachePrefixService('deepseek', 'auto-prefix');

      const p1 = s1.freezePrefix('Prompt A', tools);
      const p2 = s2.freezePrefix('Prompt B', tools);
      expect(p1.fingerprint).not.toBe(p2.fingerprint);
    });

    it('sorts tools by name for deterministic ordering', () => {
      const toolsA = [makeTool('z-tool', 'Z'), makeTool('a-tool', 'A')];
      const toolsB = [makeTool('a-tool', 'A'), makeTool('z-tool', 'Z')];

      const s1 = new CachePrefixService('deepseek', 'auto-prefix');
      const s2 = new CachePrefixService('deepseek', 'auto-prefix');

      const p1 = s1.freezePrefix('prompt', toolsA);
      const p2 = s2.freezePrefix('prompt', toolsB);
      expect(p1.fingerprint).toBe(p2.fingerprint);
    });
  });

  describe('getStableSystemPrompt', () => {
    it('returns frozen system prompt', () => {
      service.freezePrefix('My system prompt', []);
      expect(service.getStableSystemPrompt()).toBe('My system prompt');
    });

    it('returns empty string before freeze', () => {
      expect(service.getStableSystemPrompt()).toBe('');
    });
  });

  describe('getEphemeralAugmentations', () => {
    it('returns null when both are empty', () => {
      expect(service.getEphemeralAugmentations('', '')).toBeNull();
    });

    it('returns content when memory is provided', () => {
      const result = service.getEphemeralAugmentations('memory context', '');
      expect(result).toEqual({ memoryContext: 'memory context', levelAdaptation: '' });
    });

    it('returns content when adaptation is provided', () => {
      const result = service.getEphemeralAugmentations('', 'level adaptation');
      expect(result).toEqual({ memoryContext: '', levelAdaptation: 'level adaptation' });
    });

    it('returns both when both are provided', () => {
      const result = service.getEphemeralAugmentations('mem', 'adapt');
      expect(result).toEqual({ memoryContext: 'mem', levelAdaptation: 'adapt' });
    });
  });

  describe('isPrefixStable', () => {
    it('returns false before freeze', () => {
      expect(service.isPrefixStable()).toBe(false);
    });

    it('returns true after freeze (prefix matches itself)', () => {
      service.freezePrefix('prompt', []);
      expect(service.isPrefixStable()).toBe(true);
    });
  });

  describe('isFrozen', () => {
    it('returns false before freeze', () => {
      expect(service.isFrozen()).toBe(false);
    });

    it('returns true after freeze', () => {
      service.freezePrefix('prompt', []);
      expect(service.isFrozen()).toBe(true);
    });
  });

  describe('getCacheStrategy', () => {
    it('returns the strategy passed to constructor', () => {
      expect(service.getCacheStrategy()).toBe('explicit-breakpoints');
    });

    it('returns auto-prefix for deepseek service', () => {
      const ds = new CachePrefixService('deepseek', 'auto-prefix');
      expect(ds.getCacheStrategy()).toBe('auto-prefix');
    });
  });

  describe('getFingerprint', () => {
    it('returns empty string before freeze', () => {
      expect(service.getFingerprint()).toBe('');
    });

    it('returns non-empty hex string after freeze', () => {
      service.freezePrefix('prompt', []);
      const fp = service.getFingerprint();
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('prefix stability across turns', () => {
    it('fingerprint does not change when only ephemeral content changes', () => {
      const tools = [makeTool('bash', 'Run')];
      service.freezePrefix('Base system prompt', tools);
      const fp1 = service.getFingerprint();

      // Simulate getting ephemeral content (memory changes each turn)
      service.getEphemeralAugmentations('new memory context', 'beginner adaptation');

      // Fingerprint should not change
      expect(service.getFingerprint()).toBe(fp1);
      expect(service.isPrefixStable()).toBe(true);
    });
  });
});
