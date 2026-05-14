// Dynamic parameter tuning based on provider capabilities and task type

import type { ProviderCapabilities } from './capabilities';
import type { TaskType } from './prompts/types';

export interface TunedParams {
  max_tokens: number;
  temperature: number;
  top_p?: number;
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
}

export class ParamTuner {
  /**
   * Compute optimal API parameters based on provider capabilities and task context.
   */
  tune(
    capabilities: ProviderCapabilities,
    taskType: TaskType,
    conversationLength: number,
    availableTokens: number,
  ): TunedParams {
    const params: TunedParams = {
      max_tokens: Math.min(capabilities.maxOutputTokens, availableTokens),
      temperature: capabilities.recommendedTemperature,
    };

    // Task-specific temperature adjustments
    switch (taskType) {
      case 'code-gen':
      case 'debugging':
        // Low temperature for precise code generation
        params.temperature = Math.min(params.temperature, 0.2);
        break;

      case 'refactoring':
        // Slightly higher for creative restructuring
        params.temperature = Math.min(params.temperature, 0.4);
        break;

      case 'documentation':
        // Moderate temperature for natural language
        params.temperature = Math.min(params.temperature, 0.5);
        break;

      case 'creative':
        // Higher temperature for creative tasks
        params.temperature = Math.max(params.temperature, 0.7);
        break;

      case 'general':
      default:
        // Use provider default
        break;
    }

    // Parallel tool calls
    if (!capabilities.supportsParallelToolCalls) {
      params.parallel_tool_calls = false;
      params.tool_choice = 'auto';
    }

    // For long conversations, reduce max_tokens to leave room for context
    if (conversationLength > 50) {
      params.max_tokens = Math.min(params.max_tokens, Math.floor(availableTokens * 0.5));
    }

    // Ensure max_tokens is at least 1024 for reasonable output
    params.max_tokens = Math.max(params.max_tokens, 1024);

    // Top-p: use 1.0 for most providers, or omit
    if (capabilities.supportsStructuredOutput) {
      params.top_p = 1.0;
    }

    return params;
  }

  /**
   * Compute the optimal max_tokens given context constraints.
   */
  computeMaxTokens(
    capabilities: ProviderCapabilities,
    contextTokens: number,
    reservedOutput?: number,
  ): number {
    const maxOutput = reservedOutput ?? capabilities.maxOutputTokens;
    const availableFromContext = capabilities.maxContextWindow - contextTokens;
    return Math.min(maxOutput, Math.max(availableFromContext, 1024));
  }
}
