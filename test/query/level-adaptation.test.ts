import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getSystemPromptAdaptation,
  getToolHints,
  getAdaptationConfig,
  adaptConversationPacing,
} from '../../src/services/behavioralAdapter';
import { UserProfileService } from '../../src/services/userProfile';
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

describe('Level-Based Adaptation', () => {
  let profileService: UserProfileService;

  beforeEach(() => {
    profileService = new UserProfileService('/tmp/test-settings.json');
  });

  describe('System prompt adaptation by level', () => {
    it('should give beginner full tool descriptions', () => {
      profileService.updateLevel('beginner');
      const prompt = getSystemPromptAdaptation(profileService.getLevel(), tools);

      expect(prompt).toContain('Read');
      expect(prompt).toContain('Read a file');
      expect(prompt).toContain('Edit');
      expect(prompt).toContain('Bash');
    });

    it('should give intermediate tool names only', () => {
      profileService.updateLevel('intermediate');
      const prompt = getSystemPromptAdaptation(profileService.getLevel(), tools);

      expect(prompt).toContain('Read');
      expect(prompt).toContain('Edit');
      expect(prompt).not.toContain('Read a file');
    });

    it('should give advanced minimal prompt', () => {
      profileService.updateLevel('advanced');
      const prompt = getSystemPromptAdaptation(profileService.getLevel(), tools);

      expect(prompt).toBe('');
    });
  });

  describe('Tool hints by level', () => {
    it('should show hints after every tool for beginner', () => {
      profileService.updateLevel('beginner');

      const successHint = getToolHints('Read', profileService.getLevel(), true);
      expect(successHint).not.toBeNull();

      const errorHint = getToolHints('Read', profileService.getLevel(), false);
      expect(errorHint).not.toBeNull();
    });

    it('should show hints only after errors for intermediate', () => {
      profileService.updateLevel('intermediate');

      const successHint = getToolHints('Read', profileService.getLevel(), true);
      expect(successHint).toBeNull();

      const errorHint = getToolHints('Read', profileService.getLevel(), false);
      expect(errorHint).not.toBeNull();
    });

    it('should never show hints for advanced', () => {
      profileService.updateLevel('advanced');

      const successHint = getToolHints('Read', profileService.getLevel(), true);
      expect(successHint).toBeNull();

      const errorHint = getToolHints('Read', profileService.getLevel(), false);
      expect(errorHint).toBeNull();
    });
  });

  describe('Conversation pacing by level', () => {
    it('should give beginner longer responses with explanations', () => {
      profileService.updateLevel('beginner');
      const pacing = adaptConversationPacing(profileService.getLevel());

      expect(pacing.maxResponseLength).toBe(2000);
      expect(pacing.includeExplanations).toBe(true);
      expect(pacing.includeExamples).toBe(true);
    });

    it('should give intermediate medium responses', () => {
      profileService.updateLevel('intermediate');
      const pacing = adaptConversationPacing(profileService.getLevel());

      expect(pacing.maxResponseLength).toBe(1000);
      expect(pacing.includeExplanations).toBe(true);
      expect(pacing.includeExamples).toBe(false);
    });

    it('should give advanced short responses', () => {
      profileService.updateLevel('advanced');
      const pacing = adaptConversationPacing(profileService.getLevel());

      expect(pacing.maxResponseLength).toBe(500);
      expect(pacing.includeExplanations).toBe(false);
      expect(pacing.includeExamples).toBe(false);
    });
  });

  describe('Level persistence', () => {
    it('should persist level across profile instances', () => {
      profileService.updateLevel('intermediate');
      const level = profileService.getLevel();
      expect(level).toBe('intermediate');
    });

    it('should default to beginner', () => {
      expect(profileService.getLevel()).toBe('beginner');
    });
  });

  describe('Adaptation config by level', () => {
    it('should return full config for beginner', () => {
      profileService.updateLevel('beginner');
      const config = getAdaptationConfig(profileService.getLevel());

      expect(config.includeToolDescriptions).toBe(true);
      expect(config.showHintsAfterSuccess).toBe(true);
      expect(config.verbosity).toBe('high');
    });

    it('should return partial config for intermediate', () => {
      profileService.updateLevel('intermediate');
      const config = getAdaptationConfig(profileService.getLevel());

      expect(config.includeToolDescriptions).toBe(false);
      expect(config.showHintsAfterSuccess).toBe(false);
      expect(config.showHintsAfterError).toBe(true);
    });

    it('should return minimal config for advanced', () => {
      profileService.updateLevel('advanced');
      const config = getAdaptationConfig(profileService.getLevel());

      expect(config.includeToolDescriptions).toBe(false);
      expect(config.showHintsAfterSuccess).toBe(false);
      expect(config.showHintsAfterError).toBe(false);
    });
  });
});
