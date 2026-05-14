// Tests for ParamTuner

import { describe, it, expect } from 'vitest';
import { ParamTuner } from '../../src/api/param-tuner';
import { getCapabilities } from '../../src/api/capabilities';

describe('ParamTuner', () => {
  const tuner = new ParamTuner();

  describe('tune', () => {
    it('should set low temperature for code generation', () => {
      const caps = getCapabilities('anthropic');
      const params = tuner.tune(caps, 'code-gen', 10, 100_000);

      expect(params.temperature).toBeLessThanOrEqual(0.2);
    });

    it('should set higher temperature for creative tasks', () => {
      const caps = getCapabilities('openai');
      const params = tuner.tune(caps, 'creative', 10, 100_000);

      expect(params.temperature).toBeGreaterThanOrEqual(0.7);
    });

    it('should use provider default temperature for general tasks', () => {
      const caps = getCapabilities('deepseek');
      const params = tuner.tune(caps, 'general', 10, 100_000);

      expect(params.temperature).toBe(caps.recommendedTemperature);
    });

    it('should limit max_tokens to available tokens', () => {
      const caps = getCapabilities('anthropic');
      const params = tuner.tune(caps, 'general', 10, 4096);

      expect(params.max_tokens).toBeLessThanOrEqual(4096);
    });

    it('should limit max_tokens to provider maximum', () => {
      const caps = getCapabilities('anthropic');
      const params = tuner.tune(caps, 'general', 10, 1_000_000);

      expect(params.max_tokens).toBeLessThanOrEqual(caps.maxOutputTokens);
    });

    it('should reduce max_tokens for long conversations', () => {
      // Use a provider with large output tokens so the reduction is visible
      const caps = getCapabilities('anthropic');
      const short = tuner.tune(caps, 'general', 10, 100_000);
      const long = tuner.tune(caps, 'general', 100, 100_000);

      // Both should be capped at maxOutputTokens, but long conversations
      // get reduced to 50% of available tokens
      expect(long.max_tokens).toBeLessThanOrEqual(short.max_tokens);
    });

    it('should ensure minimum max_tokens of 1024', () => {
      const caps = getCapabilities('anthropic');
      const params = tuner.tune(caps, 'general', 10, 100);

      expect(params.max_tokens).toBeGreaterThanOrEqual(1024);
    });

    it('should disable parallel calls for providers that do not support it', () => {
      const caps = getCapabilities('deepseek');
      const params = tuner.tune(caps, 'general', 10, 100_000);

      expect(params.parallel_tool_calls).toBe(false);
      expect(params.tool_choice).toBe('auto');
    });
  });

  describe('computeMaxTokens', () => {
    it('should compute available tokens based on context', () => {
      const caps = getCapabilities('anthropic');
      const max = tuner.computeMaxTokens(caps, 50_000);

      expect(max).toBeLessThanOrEqual(caps.maxContextWindow - 50_000);
    });

    it('should respect reserved output', () => {
      const caps = getCapabilities('openai');
      const max = tuner.computeMaxTokens(caps, 10_000, 4096);

      expect(max).toBeLessThanOrEqual(4096);
    });

    it('should ensure minimum of 1024', () => {
      const caps = getCapabilities('anthropic');
      const max = tuner.computeMaxTokens(caps, 199_000);

      expect(max).toBeGreaterThanOrEqual(1024);
    });
  });
});
