import { describe, it, expect } from 'vitest';
import {
  getSystemPromptAdaptation,
  getToolHints,
  getAdaptationConfig,
  adaptConversationPacing,
} from '../../src/services/behavioralAdapter';
import type { ToolDefinition } from '../../src/types/tools';
import { z } from 'zod';

function makeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({}),
    call: async () => ({ output: '', isError: false }),
  };
}

const tools = [
  makeTool('Read', 'Read a file from the filesystem'),
  makeTool('Edit', 'Edit an existing file'),
  makeTool('Bash', 'Execute a shell command'),
];

describe('BehavioralAdapter', () => {
  describe('getSystemPromptAdaptation', () => {
    it('should include tool descriptions for beginner', () => {
      const prompt = getSystemPromptAdaptation('beginner', tools);
      expect(prompt).toContain('Read');
      expect(prompt).toContain('Read a file');
      expect(prompt).toContain('Edit');
      expect(prompt).toContain('Bash');
    });

    it('should include tool names only for intermediate', () => {
      const prompt = getSystemPromptAdaptation('intermediate', tools);
      expect(prompt).toContain('Read');
      expect(prompt).toContain('Edit');
      expect(prompt).toContain('Bash');
      expect(prompt).not.toContain('Read a file');
    });

    it('should return empty for advanced', () => {
      const prompt = getSystemPromptAdaptation('advanced', tools);
      expect(prompt).toBe('');
    });

    it('should handle empty tools list', () => {
      const prompt = getSystemPromptAdaptation('beginner', []);
      expect(prompt).toBe('');
    });
  });

  describe('getToolHints', () => {
    it('should show hint after success for beginner', () => {
      const hint = getToolHints('Read', 'beginner', true);
      expect(hint).not.toBeNull();
      expect(hint!.hint).toContain('Edit');
    });

    it('should show hint after error for beginner', () => {
      const hint = getToolHints('Bash', 'beginner', false);
      expect(hint).not.toBeNull();
      expect(hint!.hint).toContain('command syntax');
    });

    it('should not show hint after success for intermediate', () => {
      const hint = getToolHints('Read', 'intermediate', true);
      expect(hint).toBeNull();
    });

    it('should show hint after error for intermediate', () => {
      const hint = getToolHints('Read', 'intermediate', false);
      expect(hint).not.toBeNull();
    });

    it('should not show hint for advanced', () => {
      const hint = getToolHints('Read', 'advanced', false);
      expect(hint).toBeNull();
    });

    it('should suggest alternatives after repeated failures', () => {
      const errorHistory = new Map([['Bash', 3]]);
      const hint = getToolHints('Bash', 'beginner', false, errorHistory);
      expect(hint).not.toBeNull();
      expect(hint!.relatedTools).toContain('Read');
      expect(hint!.relatedTools).toContain('Edit');
    });
  });

  describe('getAdaptationConfig', () => {
    it('should return full config for beginner', () => {
      const config = getAdaptationConfig('beginner');
      expect(config.includeToolDescriptions).toBe(true);
      expect(config.includeToolNames).toBe(true);
      expect(config.showHintsAfterSuccess).toBe(true);
      expect(config.showHintsAfterError).toBe(true);
      expect(config.verbosity).toBe('high');
    });

    it('should return partial config for intermediate', () => {
      const config = getAdaptationConfig('intermediate');
      expect(config.includeToolDescriptions).toBe(false);
      expect(config.includeToolNames).toBe(true);
      expect(config.showHintsAfterSuccess).toBe(false);
      expect(config.showHintsAfterError).toBe(true);
      expect(config.verbosity).toBe('medium');
    });

    it('should return minimal config for advanced', () => {
      const config = getAdaptationConfig('advanced');
      expect(config.includeToolDescriptions).toBe(false);
      expect(config.includeToolNames).toBe(false);
      expect(config.showHintsAfterSuccess).toBe(false);
      expect(config.showHintsAfterError).toBe(false);
      expect(config.verbosity).toBe('low');
    });
  });

  describe('adaptConversationPacing', () => {
    it('should return high verbosity for beginner', () => {
      const pacing = adaptConversationPacing('beginner');
      expect(pacing.maxResponseLength).toBe(2000);
      expect(pacing.includeExplanations).toBe(true);
      expect(pacing.includeExamples).toBe(true);
    });

    it('should return medium verbosity for intermediate', () => {
      const pacing = adaptConversationPacing('intermediate');
      expect(pacing.maxResponseLength).toBe(1000);
      expect(pacing.includeExplanations).toBe(true);
      expect(pacing.includeExamples).toBe(false);
    });

    it('should return low verbosity for advanced', () => {
      const pacing = adaptConversationPacing('advanced');
      expect(pacing.maxResponseLength).toBe(500);
      expect(pacing.includeExplanations).toBe(false);
      expect(pacing.includeExamples).toBe(false);
    });
  });
});
