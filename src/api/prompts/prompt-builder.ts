// Prompt builder - composes system prompts from provider templates and capabilities

import type { ProviderCapabilities } from '../capabilities';
import type { PromptTemplate, TaskType } from './types';
import { PROVIDER_PROMPTS } from './provider-prompts';
import type { ToolDefinition } from '../../tools/protocol';
import { buildStaticSurfaceManifest, composeStaticSurfaces } from './instruction-surfaces';

export interface ConversationContext {
  taskType?: TaskType;
  workspaceContext?: string;
  additionalInstructions?: string;
  /** Language-specific build/test command info */
  languageInfo?: {
    language: string;
    buildCommands: string[];
    testCommands: string[];
    lintCommands: string[];
  };
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
   *
   * T1 (harness-evolution H1): internally reorganized as a declarative
   * instruction-surface manifest. Output remains byte-equivalent to the
   * legacy inline composition (guarded by equivalence tests).
   */
  buildSystemPrompt(tools: ToolDefinition[], context: ConversationContext = {}): string {
    const surfaces = buildStaticSurfaceManifest(this.template, this.capabilities, tools, context);
    return composeStaticSurfaces(surfaces);
  }
}
