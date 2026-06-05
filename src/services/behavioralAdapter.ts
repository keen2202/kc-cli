// Behavioral Adapter - adapts system prompt, tool hints, and conversation pacing based on user level

import type { UserLevel } from './userProfile';
import type { ToolDefinition } from '../tools/protocol';

export interface ToolHint {
  toolName: string;
  hint: string;
  relatedTools?: string[];
}

export interface AdaptationConfig {
  includeToolDescriptions: boolean;
  includeToolNames: boolean;
  showHintsAfterSuccess: boolean;
  showHintsAfterError: boolean;
  verbosity: 'low' | 'medium' | 'high';
}

/**
 * Get system prompt adaptation based on user level
 */
export function getSystemPromptAdaptation(level: UserLevel, tools: ToolDefinition[]): string {
  switch (level) {
    case 'beginner':
      return buildBeginnerPrompt(tools);
    case 'intermediate':
      return buildIntermediatePrompt(tools);
    case 'advanced':
      return '';
  }
}

/**
 * Build beginner prompt with full tool descriptions
 */
function buildBeginnerPrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const toolDescriptions = tools.map(t => `- **${t.name}**: ${t.description}`).join('\n');
  return `\n\n## Available Tools\n${toolDescriptions}\n\nUse these tools to help accomplish tasks. Ask for clarification if unsure.`;
}

/**
 * Build intermediate prompt with tool names only
 */
function buildIntermediatePrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const toolNames = tools.map(t => t.name).join(', ');
  return `\n\n## Available Tools\n${toolNames}`;
}

/**
 * Get tool hints based on context
 */
export function getToolHints(
  toolName: string,
  level: UserLevel,
  success: boolean,
  errorHistory?: Map<string, number>
): ToolHint | null {
  // No hints for advanced users
  if (level === 'advanced') {
    return null;
  }

  // Show hints after errors for intermediate
  if (level === 'intermediate' && success) {
    return null;
  }

  // Show hints after every execution for beginner
  // Show hints after errors for intermediate
  return generateToolHint(toolName, success, errorHistory);
}

/**
 * Generate a contextual tool hint
 */
function generateToolHint(
  toolName: string,
  success: boolean,
  errorHistory?: Map<string, number>
): ToolHint | null {
  // Check if tool has been failing repeatedly
  const failures = errorHistory?.get(toolName) || 0;

  if (failures >= 3) {
    return {
      toolName,
      hint: `The ${toolName} tool has failed ${failures} times. Consider trying a different approach.`,
      relatedTools: getAlternativeTools(toolName),
    };
  }

  if (!success) {
    return {
      toolName,
      hint: getErrorHint(toolName),
      relatedTools: getAlternativeTools(toolName),
    };
  }

  // Success hints for beginners
  return {
    toolName,
    hint: getSuccessHint(toolName),
  };
}

/**
 * Get error hint for a tool
 */
function getErrorHint(toolName: string): string {
  const hints: Record<string, string> = {
    'Bash': 'Check the command syntax and ensure the working directory is correct.',
    'Read': 'Verify the file path exists and you have read permissions.',
    'Write': 'Check the directory exists and you have write permissions.',
    'Edit': 'Ensure the old_string matches exactly, including whitespace.',
    'WebFetch': 'Check the URL is valid and accessible.',
    'Agent': 'The sub-agent may have encountered an error. Check the output for details.',
  };

  return hints[toolName] || `The ${toolName} tool encountered an error. Check the output for details.`;
}

/**
 * Get success hint for a tool
 */
function getSuccessHint(toolName: string): string {
  const hints: Record<string, string> = {
    'Read': 'You can use Edit to make changes to the file.',
    'Edit': 'Run tests to verify the changes work correctly.',
    'Write': 'Run tests to verify the new file works as expected.',
    'Bash': 'Check the command output for any warnings or issues.',
    'Grep': 'Use Read to examine the matching files in detail.',
    'Agent': 'Review the agent\'s findings and apply them to your task.',
  };

  return hints[toolName] || '';
}

/**
 * Get alternative tools for a failing tool
 */
function getAlternativeTools(toolName: string): string[] {
  const alternatives: Record<string, string[]> = {
    'Bash': ['Read', 'Edit', 'Write'],
    'Read': ['Grep', 'Glob'],
    'Write': ['Edit', 'Bash'],
    'Edit': ['Write', 'Bash'],
    'WebFetch': ['WebSearch', 'Bash'],
    'Agent': ['Bash', 'Read'],
  };

  return alternatives[toolName] || [];
}

/**
 * Get adaptation config for a user level
 */
export function getAdaptationConfig(level: UserLevel): AdaptationConfig {
  switch (level) {
    case 'beginner':
      return {
        includeToolDescriptions: true,
        includeToolNames: true,
        showHintsAfterSuccess: true,
        showHintsAfterError: true,
        verbosity: 'high',
      };
    case 'intermediate':
      return {
        includeToolDescriptions: false,
        includeToolNames: true,
        showHintsAfterSuccess: false,
        showHintsAfterError: true,
        verbosity: 'medium',
      };
    case 'advanced':
      return {
        includeToolDescriptions: false,
        includeToolNames: false,
        showHintsAfterSuccess: false,
        showHintsAfterError: false,
        verbosity: 'low',
      };
  }
}

/**
 * Adapt conversation pacing based on user level
 * Returns a modifier for response length and detail
 */
export function adaptConversationPacing(level: UserLevel): {
  maxResponseLength: number;
  includeExplanations: boolean;
  includeExamples: boolean;
} {
  switch (level) {
    case 'beginner':
      return {
        maxResponseLength: 2000,
        includeExplanations: true,
        includeExamples: true,
      };
    case 'intermediate':
      return {
        maxResponseLength: 1000,
        includeExplanations: true,
        includeExamples: false,
      };
    case 'advanced':
      return {
        maxResponseLength: 500,
        includeExplanations: false,
        includeExamples: false,
      };
  }
}
