// Tests for provider capabilities

import { describe, it, expect } from 'vitest';
import {
  getCapabilities,
  hasCapability,
  getMaxContextWindow,
  PROVIDER_CAPABILITIES,
} from '../../src/api/capabilities';

describe('ProviderCapabilities', () => {
  describe('PROVIDER_CAPABILITIES', () => {
    it('should define capabilities for all 6 providers', () => {
      expect(PROVIDER_CAPABILITIES['anthropic']).toBeDefined();
      expect(PROVIDER_CAPABILITIES['openai']).toBeDefined();
      expect(PROVIDER_CAPABILITIES['deepseek']).toBeDefined();
      expect(PROVIDER_CAPABILITIES['qwen']).toBeDefined();
      expect(PROVIDER_CAPABILITIES['glm']).toBeDefined();
      expect(PROVIDER_CAPABILITIES['ollama']).toBeDefined();
    });

    it('anthropic should support thinking and extended thinking', () => {
      const caps = PROVIDER_CAPABILITIES['anthropic'];
      expect(caps.supportsThinking).toBe(true);
      expect(caps.supportsExtendedThinking).toBe(true);
    });

    it('openai should support structured output', () => {
      const caps = PROVIDER_CAPABILITIES['openai'];
      expect(caps.supportsStructuredOutput).toBe(true);
      expect(caps.supportsJsonMode).toBe(true);
    });

    it('ollama should have smaller context window', () => {
      const caps = PROVIDER_CAPABILITIES['ollama'];
      expect(caps.maxContextWindow).toBeLessThan(100_000);
    });
  });

  describe('getCapabilities', () => {
    it('should return provider capabilities for known provider', () => {
      const caps = getCapabilities('anthropic');
      expect(caps.maxContextWindow).toBe(200_000);
      expect(caps.supportsToolUse).toBe(true);
    });

    it('should apply model-specific overrides', () => {
      const caps = getCapabilities('anthropic', 'claude-sonnet-4-20250514');
      expect(caps.maxContextWindow).toBe(200_000);
      expect(caps.supportsExtendedThinking).toBe(true);
    });

    it('should return default capabilities for unknown provider', () => {
      const caps = getCapabilities('unknown-provider');
      expect(caps.maxContextWindow).toBe(128_000);
      expect(caps.supportsToolUse).toBe(false);
    });

    it('should handle ollama model overrides', () => {
      const llama = getCapabilities('ollama', 'llama3');
      expect(llama.maxContextWindow).toBe(8_192);

      const qwen = getCapabilities('ollama', 'qwen2');
      expect(qwen.maxContextWindow).toBe(32_000);
      expect(qwen.supportsToolUse).toBe(true);
    });
  });

  describe('hasCapability', () => {
    it('should return true for supported capabilities', () => {
      expect(hasCapability('anthropic', 'supportsToolUse')).toBe(true);
      expect(hasCapability('openai', 'supportsStructuredOutput')).toBe(true);
    });

    it('should return false for unsupported capabilities', () => {
      expect(hasCapability('ollama', 'supportsToolUse')).toBe(false);
      expect(hasCapability('deepseek', 'supportsExtendedThinking')).toBe(false);
    });

    it('should handle unknown provider gracefully', () => {
      expect(hasCapability('unknown', 'supportsToolUse')).toBe(false);
    });
  });

  describe('getMaxContextWindow', () => {
    it('should return correct context window for providers', () => {
      expect(getMaxContextWindow('anthropic')).toBe(200_000);
      expect(getMaxContextWindow('openai')).toBe(128_000);
      expect(getMaxContextWindow('ollama')).toBe(32_000);
    });

    it('should apply model overrides', () => {
      expect(getMaxContextWindow('openai', 'gpt-3.5-turbo')).toBe(16_385);
      expect(getMaxContextWindow('openai', 'gpt-4o')).toBe(128_000);
    });
  });
});
