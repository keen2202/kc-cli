// Prompt builder - composes system prompts from provider templates and capabilities

import type { ProviderCapabilities } from '../capabilities';
import type { PromptTemplate, TaskType } from './types';
import { PROVIDER_PROMPTS } from './provider-prompts';
import type { ToolDefinition } from '../../types/tools';

export interface ConversationContext {
  taskType?: TaskType;
  workspaceContext?: string;
  additionalInstructions?: string;
}

export class PromptBuilder {
  private provider: string;
  private capabilities: ProviderCapabilities;
  private template: PromptTemplate;

  constructor(provider: string, capabilities: ProviderCapabilities) {
    this.provider = provider;
    this.capabilities = capabilities;
    this.template = PROVIDER_PROMPTS[provider] ?? PROVIDER_PROMPTS['default'];
  }

  /**
   * Build the complete system prompt by combining base + provider + task + capability instructions.
   */
  buildSystemPrompt(tools: ToolDefinition[], context: ConversationContext = {}): string {
    const parts: string[] = [];

    // Base provider system prompt
    parts.push(this.template.system);

    // Capability-specific instructions
    if (this.capabilities.supportsThinking) {
      parts.push('Use <thinking> tags for internal reasoning before taking action.');
    }

    if (this.capabilities.supportsExtendedThinking) {
      parts.push('You can use extended thinking for complex problems.');
    }

    if (this.capabilities.supportsParallelToolCalls) {
      parts.push('You may call multiple independent tools in parallel when appropriate.');
    } else {
      parts.push('Call tools one at a time. Wait for each result before making the next call.');
    }

    // Tool instructions
    if (tools.length > 0) {
      parts.push(this.template.toolUse);
      parts.push(this.formatToolList(tools));
    }

    // Task-specific instructions
    if (context.taskType) {
      const taskPrompt = this.getTaskPrompt(context.taskType);
      if (taskPrompt) {
        parts.push(taskPrompt);
      }
    }

    // Workspace context
    if (context.workspaceContext) {
      parts.push(`Workspace context:\n${context.workspaceContext}`);
    }

    // Additional instructions
    if (context.additionalInstructions) {
      parts.push(context.additionalInstructions);
    }

    return parts.join('\n\n');
  }

  /**
   * Get task-specific prompt from the template.
   */
  private getTaskPrompt(taskType: TaskType): string {
    switch (taskType) {
      case 'code-gen':
        return this.template.codeGen;
      case 'debugging':
        return this.template.debugging;
      case 'refactoring':
        return this.template.refactoring;
      case 'documentation':
        return this.template.documentation;
      case 'creative':
        return this.template.reasoning;
      case 'general':
      default:
        return '';
    }
  }

  /**
   * Format the tool list for inclusion in the system prompt.
   */
  private formatToolList(tools: ToolDefinition[]): string {
    const toolDescriptions = tools
      .slice(0, this.capabilities.recommendedMaxTools)
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');

    const extra = tools.length > this.capabilities.recommendedMaxTools
      ? `\n... and ${tools.length - this.capabilities.recommendedMaxTools} more tools`
      : '';

    return `Available tools:\n${toolDescriptions}${extra}`;
  }
}
