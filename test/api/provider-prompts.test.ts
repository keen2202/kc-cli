// Tests for provider-specific prompt templates

import { describe, it, expect } from 'vitest';
import { PROVIDER_PROMPTS } from '../../src/api/prompts/provider-prompts';

describe('ProviderPrompts', () => {
  describe('PROVIDER_PROMPTS', () => {
    it('should define prompts for all 7 providers/defaults', () => {
      expect(PROVIDER_PROMPTS['anthropic']).toBeDefined();
      expect(PROVIDER_PROMPTS['openai']).toBeDefined();
      expect(PROVIDER_PROMPTS['deepseek']).toBeDefined();
      expect(PROVIDER_PROMPTS['qwen']).toBeDefined();
      expect(PROVIDER_PROMPTS['glm']).toBeDefined();
      expect(PROVIDER_PROMPTS['ollama']).toBeDefined();
      expect(PROVIDER_PROMPTS['default']).toBeDefined();
    });

    it('each prompt template should have all required fields', () => {
      const requiredFields = ['system', 'toolUse', 'codeGen', 'debugging', 'refactoring', 'documentation', 'reasoning'];
      for (const [provider, prompt] of Object.entries(PROVIDER_PROMPTS)) {
        for (const field of requiredFields) {
          expect((prompt as any)[field], `${provider} missing field: ${field}`).toBeDefined();
          expect(typeof (prompt as any)[field]).toBe('string');
          expect((prompt as any)[field].length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('anthropic prompt', () => {
    it('should mention thinking tags', () => {
      expect(PROVIDER_PROMPTS['anthropic'].system).toContain('<thinking>');
    });

    it('should emphasize type annotations', () => {
      expect(PROVIDER_PROMPTS['anthropic'].codeGen).toContain('type annotations');
    });

    it('should include systematic debugging steps', () => {
      expect(PROVIDER_PROMPTS['anthropic'].debugging).toContain('Reproduce');
    });
  });

  describe('openai prompt', () => {
    it('should mention clean code', () => {
      expect(PROVIDER_PROMPTS['openai'].system).toContain('clean');
    });

    it('should reference sequential tool execution', () => {
      expect(PROVIDER_PROMPTS['openai'].toolUse).toContain('sequentially');
    });
  });

  describe('deepseek prompt', () => {
    it('should be in Chinese', () => {
      expect(PROVIDER_PROMPTS['deepseek'].system).toContain('专业');
    });

    it('should mention TypeScript', () => {
      expect(PROVIDER_PROMPTS['deepseek'].codeGen).toContain('TypeScript');
    });

    it('should have Chinese debugging instructions', () => {
      expect(PROVIDER_PROMPTS['deepseek'].debugging).toContain('复现');
    });
  });

  describe('qwen prompt', () => {
    it('should be in Chinese', () => {
      expect(PROVIDER_PROMPTS['qwen'].system).toContain('中文');
    });

    it('should mention TypeScript', () => {
      expect(PROVIDER_PROMPTS['qwen'].codeGen).toContain('TypeScript');
    });
  });

  describe('glm prompt', () => {
    it('should be in Chinese', () => {
      expect(PROVIDER_PROMPTS['glm'].system).toContain('中文');
    });

    it('should mention type annotations', () => {
      expect(PROVIDER_PROMPTS['glm'].codeGen).toContain('类型注解');
    });
  });

  describe('ollama prompt', () => {
    it('should be concise', () => {
      const systemLen = PROVIDER_PROMPTS['ollama'].system.length;
      const anthropicLen = PROVIDER_PROMPTS['anthropic'].system.length;
      expect(systemLen).toBeLessThan(anthropicLen);
    });

    it('should emphasize simplicity', () => {
      expect(PROVIDER_PROMPTS['ollama'].codeGen).toContain('simple');
    });
  });

  describe('default prompt', () => {
    it('should be generic and helpful', () => {
      expect(PROVIDER_PROMPTS['default'].system).toContain('software engineering');
    });

    it('should mention testing', () => {
      expect(PROVIDER_PROMPTS['default'].codeGen).toContain('test');
    });
  });
});
