// Tests for PromptBuilder

import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../../src/api/prompts/prompt-builder';
import { getCapabilities } from '../../../src/api/capabilities';

describe('PromptBuilder', () => {
  describe('buildSystemPrompt', () => {
    it('should include provider base prompt', () => {
      const caps = getCapabilities('anthropic');
      const builder = new PromptBuilder('anthropic', caps);

      const prompt = builder.buildSystemPrompt([]);
      expect(prompt).toContain('meticulous software engineer');
    });

    it('should include thinking instructions for anthropic', () => {
      const caps = getCapabilities('anthropic');
      const builder = new PromptBuilder('anthropic', caps);

      const prompt = builder.buildSystemPrompt([]);
      expect(prompt).toContain('<thinking>');
    });

    it('should include parallel tool instructions when supported', () => {
      const caps = getCapabilities('anthropic');
      const builder = new PromptBuilder('anthropic', caps);

      const prompt = builder.buildSystemPrompt([]);
      expect(prompt).toContain('parallel');
    });

    it('should include sequential tool instructions when parallel not supported', () => {
      const caps = getCapabilities('ollama');
      const builder = new PromptBuilder('ollama', caps);

      const prompt = builder.buildSystemPrompt([]);
      expect(prompt).toContain('one at a time');
    });

    it('should format tool list', () => {
      const caps = getCapabilities('openai');
      const builder = new PromptBuilder('openai', caps);

      const tools = [
        { name: 'Bash', description: 'Run shell commands', inputSchema: {} },
        { name: 'Read', description: 'Read files', inputSchema: {} },
      ];

      const prompt = builder.buildSystemPrompt(tools);
      expect(prompt).toContain('Bash');
      expect(prompt).toContain('Read');
    });

    it('should include task-specific instructions', () => {
      const caps = getCapabilities('openai');
      const builder = new PromptBuilder('openai', caps);

      const prompt = builder.buildSystemPrompt([], { taskType: 'debugging' });
      expect(prompt).toContain('debug');
    });

    it('should include workspace context', () => {
      const caps = getCapabilities('openai');
      const builder = new PromptBuilder('openai', caps);

      const prompt = builder.buildSystemPrompt([], {
        workspaceContext: 'This is a TypeScript project using Vitest.',
      });
      expect(prompt).toContain('TypeScript project');
    });

    it('should use default prompt for unknown provider', () => {
      const caps = getCapabilities('unknown');
      const builder = new PromptBuilder('unknown', caps);

      const prompt = builder.buildSystemPrompt([]);
      expect(prompt).toContain('software engineering assistant');
    });

    it('should limit tools to recommended max', () => {
      const caps = getCapabilities('ollama'); // recommendedMaxTools = 5
      const builder = new PromptBuilder('ollama', caps);

      const tools = Array.from({ length: 10 }, (_, i) => ({
        name: `Tool${i}`,
        description: `Tool ${i} description`,
        inputSchema: {},
      }));

      const prompt = builder.buildSystemPrompt(tools);
      expect(prompt).toContain('5 more tools');
    });
  });
});
