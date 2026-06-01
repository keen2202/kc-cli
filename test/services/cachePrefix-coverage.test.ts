import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CachePrefixService,
  canonicalStringify,
  serializeToolCanonical,
  buildCacheStrategy,
} from '../../src/services/cachePrefix';

describe('cachePrefix - coverage', () => {
  describe('canonicalStringify', () => {
    it('should handle null', () => {
      expect(canonicalStringify(null)).toBe('null');
    });

    it('should handle undefined', () => {
      // JSON.stringify(undefined) returns undefined (not a string)
      expect(canonicalStringify(undefined)).toBeUndefined();
    });

    it('should handle arrays', () => {
      expect(canonicalStringify([1, 2, 3])).toBe('[1,2,3]');
    });

    it('should handle nested objects with sorted keys', () => {
      const result = canonicalStringify({ b: 2, a: 1 });
      expect(result).toBe('{"a":1,"b":2}');
    });

    it('should handle deeply nested structures', () => {
      const result = canonicalStringify({ z: { b: 1, a: 2 }, a: [3, 1, 2] });
      expect(result).toBe('{"a":[3,1,2],"z":{"a":2,"b":1}}');
    });

    it('should handle strings', () => {
      expect(canonicalStringify('hello')).toBe('"hello"');
    });

    it('should handle numbers', () => {
      expect(canonicalStringify(42)).toBe('42');
    });

    it('should handle booleans', () => {
      expect(canonicalStringify(true)).toBe('true');
    });
  });

  describe('serializeToolCanonical', () => {
    it('should serialize a tool definition', () => {
      const tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      };
      const result = serializeToolCanonical(tool as any);
      expect(result.name).toBe('test-tool');
      expect(result.description).toBe('A test tool');
      expect(typeof result.input_schema).toBe('string');
    });

    it('should handle missing schema gracefully', () => {
      const tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: null,
      };
      const result = serializeToolCanonical(tool as any);
      expect(result.name).toBe('test-tool');
    });

    it('should handle schema without properties', () => {
      const tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: { type: 'object' },
      };
      const result = serializeToolCanonical(tool as any);
      expect(result.input_schema).toBeDefined();
    });
  });

  describe('buildCacheStrategy', () => {
    it('should return explicit-breakpoints for anthropic', () => {
      expect(buildCacheStrategy('anthropic')).toBe('explicit-breakpoints');
    });

    it('should return auto-prefix for deepseek', () => {
      expect(buildCacheStrategy('deepseek')).toBe('auto-prefix');
    });

    it('should return prompt-cache for openai', () => {
      expect(buildCacheStrategy('openai')).toBe('prompt-cache');
    });

    it('should return none for unknown providers', () => {
      expect(buildCacheStrategy('unknown')).toBe('none');
    });

    it('should return none for qwen', () => {
      expect(buildCacheStrategy('qwen')).toBe('none');
    });

    it('should return none for glm', () => {
      expect(buildCacheStrategy('glm')).toBe('none');
    });

    it('should return none for ollama', () => {
      expect(buildCacheStrategy('ollama')).toBe('none');
    });

    it('should return none for mimo', () => {
      expect(buildCacheStrategy('mimo')).toBe('none');
    });

    it('should return none for kimi', () => {
      expect(buildCacheStrategy('kimi')).toBe('none');
    });

    it('should return none for step', () => {
      expect(buildCacheStrategy('step')).toBe('none');
    });

    it('should return none for gemini', () => {
      expect(buildCacheStrategy('gemini')).toBe('none');
    });

    it('should return none for openai-compatible', () => {
      expect(buildCacheStrategy('openai-compatible')).toBe('none');
    });
  });

  describe('CachePrefixService', () => {
    let service: CachePrefixService;

    beforeEach(() => {
      service = new CachePrefixService('anthropic', 'explicit-breakpoints');
    });

    it('should freeze prefix once', () => {
      const tools = [{ name: 'tool1', description: 'desc', inputSchema: {} }];
      const result1 = service.freezePrefix('system prompt', tools as any);
      const result2 = service.freezePrefix('different prompt', tools as any);
      expect(result1.fingerprint).toBe(result2.fingerprint);
    });

    it('should get stable system prompt before freeze', () => {
      expect(service.getStableSystemPrompt()).toBe('');
    });

    it('should get stable system prompt after freeze', () => {
      service.freezePrefix('my prompt', []);
      expect(service.getStableSystemPrompt()).toBe('my prompt');
    });

    it('should get stable tool specs before freeze', () => {
      expect(service.getStableToolSpecs()).toBe('');
    });

    it('should get stable tool specs after freeze', () => {
      const tools = [{ name: 't', description: 'd', inputSchema: {} }];
      service.freezePrefix('p', tools as any);
      expect(service.getStableToolSpecs()).toBeTruthy();
    });

    it('should return ephemeral content when both provided', () => {
      const result = service.getEphemeralAugmentations('memory', 'adaptation');
      expect(result).toEqual({ memoryContext: 'memory', levelAdaptation: 'adaptation' });
    });

    it('should return null when both empty', () => {
      const result = service.getEphemeralAugmentations('', '');
      expect(result).toBeNull();
    });

    it('should return ephemeral when only memory provided', () => {
      const result = service.getEphemeralAugmentations('memory', '');
      expect(result).toEqual({ memoryContext: 'memory', levelAdaptation: '' });
    });

    it('should return ephemeral when only adaptation provided', () => {
      const result = service.getEphemeralAugmentations('', 'adapt');
      expect(result).toEqual({ memoryContext: '', levelAdaptation: 'adapt' });
    });

    it('should get cache strategy', () => {
      expect(service.getCacheStrategy()).toBe('explicit-breakpoints');
    });

    it('should report prefix as stable after freeze', () => {
      service.freezePrefix('prompt', []);
      expect(service.isPrefixStable()).toBe(true);
    });

    it('should report prefix as unstable before freeze', () => {
      expect(service.isPrefixStable()).toBe(false);
    });

    it('should get fingerprint after freeze', () => {
      service.freezePrefix('prompt', []);
      expect(service.getFingerprint()).toBeTruthy();
      expect(service.getFingerprint().length).toBe(64); // SHA-256 hex
    });

    it('should get empty fingerprint before freeze', () => {
      expect(service.getFingerprint()).toBe('');
    });

    it('should report frozen state', () => {
      expect(service.isFrozen()).toBe(false);
      service.freezePrefix('prompt', []);
      expect(service.isFrozen()).toBe(true);
    });

    it('should sort tools deterministically', () => {
      const tools = [
        { name: 'z-tool', description: 'z', inputSchema: {} },
        { name: 'a-tool', description: 'a', inputSchema: {} },
      ];
      service.freezePrefix('p', tools as any);
      const specs = service.getStableToolSpecs();
      const aIndex = specs.indexOf('a-tool');
      const zIndex = specs.indexOf('z-tool');
      expect(aIndex).toBeLessThan(zIndex);
    });
  });
});
