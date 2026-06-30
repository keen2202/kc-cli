// Provider capability detection system
// Defines and queries the capabilities of each LLM provider and model.

import { getCacheManager } from '../services/cache';

/**
 * Provider-specific prompt caching strategy.
 * - 'explicit-breakpoints': Uses cache_control markers (Anthropic)
 * - 'auto-prefix': Relies on byte-stable prefix for automatic caching (DeepSeek)
 * - 'prompt-cache': Uses provider-specific opt-in param (OpenAI prompt_cache)
 * - 'none': No caching optimization
 */
export type CacheStrategy = 'explicit-breakpoints' | 'auto-prefix' | 'prompt-cache' | 'none';

export interface ProviderCapabilities {
  // Context limits
  maxContextWindow: number;
  maxOutputTokens: number;

  // Tool use
  supportsToolUse: boolean;
  supportsParallelToolCalls: boolean;
  supportsForcedToolUse: boolean; // tool_choice=required

  // Reasoning
  supportsThinking: boolean; // Claude thinking blocks
  supportsExtendedThinking: boolean;
  supportsChainOfThought: boolean;

  // Output control
  supportsStructuredOutput: boolean;
  supportsJsonMode: boolean;
  supportsFunctionCalling: boolean;

  // Streaming
  supportsStreaming: boolean;
  supportsStreamingToolCalls: boolean;

  // Token encoding
  tokenEncoding: 'cl100k_base' | 'o200k_base' | 'tiktoken' | 'custom';

  // Recommended defaults
  recommendedTemperature: number;
  recommendedMaxTools: number; // Max tools per request

  // Prompt caching strategy
  prefixCachingStrategy: CacheStrategy;
}

/**
 * Default capabilities for unknown providers.
 */
const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContextWindow: 128_000,
  maxOutputTokens: 4_096,
  supportsToolUse: false,
  supportsParallelToolCalls: false,
  supportsForcedToolUse: false,
  supportsThinking: false,
  supportsExtendedThinking: false,
  supportsChainOfThought: false,
  supportsStructuredOutput: false,
  supportsJsonMode: false,
  supportsFunctionCalling: false,
  supportsStreaming: true,
  supportsStreamingToolCalls: false,
  tokenEncoding: 'cl100k_base',
  recommendedTemperature: 0.7,
  recommendedMaxTools: 10,
  prefixCachingStrategy: 'none',
};

/**
 * Provider-level capabilities. Model-specific overrides can be applied on top.
 */
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  anthropic: {
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsToolUse: true,
    supportsParallelToolCalls: true,
    supportsForcedToolUse: true,
    supportsThinking: true,
    supportsExtendedThinking: true,
    supportsChainOfThought: false,
    supportsStructuredOutput: false,
    supportsJsonMode: false,
    supportsFunctionCalling: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'custom',
    recommendedTemperature: 0,
    recommendedMaxTools: 20,
    prefixCachingStrategy: 'explicit-breakpoints',
  },

  openai: {
    maxContextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsToolUse: true,
    supportsParallelToolCalls: true,
    supportsForcedToolUse: true,
    supportsThinking: false,
    supportsExtendedThinking: false,
    supportsChainOfThought: false,
    supportsStructuredOutput: true,
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'o200k_base',
    recommendedTemperature: 0.7,
    recommendedMaxTools: 20,
    prefixCachingStrategy: 'prompt-cache',
  },

  deepseek: {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsToolUse: true,
    supportsParallelToolCalls: false,
    supportsForcedToolUse: false,
    supportsThinking: false,
    supportsExtendedThinking: false,
    supportsChainOfThought: true,
    supportsStructuredOutput: false,
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'cl100k_base',
    recommendedTemperature: 0.3,
    recommendedMaxTools: 15,
    prefixCachingStrategy: 'auto-prefix',
  },

  qwen: {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsToolUse: true,
    supportsParallelToolCalls: true,
    supportsForcedToolUse: false,
    supportsThinking: false,
    supportsExtendedThinking: false,
    supportsChainOfThought: false,
    supportsStructuredOutput: false,
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'cl100k_base',
    recommendedTemperature: 0.7,
    recommendedMaxTools: 15,
    prefixCachingStrategy: 'none',
  },

  glm: {
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsToolUse: true,
    supportsParallelToolCalls: false,
    supportsForcedToolUse: false,
    supportsThinking: false,
    supportsExtendedThinking: false,
    supportsChainOfThought: false,
    supportsStructuredOutput: false,
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    tokenEncoding: 'cl100k_base',
    recommendedTemperature: 0.7,
    recommendedMaxTools: 10,
    prefixCachingStrategy: 'none',
  },

  ollama: {
    maxContextWindow: 32_000,
    maxOutputTokens: 4_096,
    supportsToolUse: false,
    supportsParallelToolCalls: false,
    supportsForcedToolUse: false,
    supportsThinking: false,
    supportsExtendedThinking: false,
    supportsChainOfThought: false,
    supportsStructuredOutput: false,
    supportsJsonMode: true,
    supportsFunctionCalling: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: false,
    tokenEncoding: 'cl100k_base',
    recommendedTemperature: 0.8,
    recommendedMaxTools: 5,
    prefixCachingStrategy: 'none',
  },
};

/**
 * Model-specific capability overrides.
 * Key format: "provider/model"
 */
const MODEL_OVERRIDES: Record<string, Partial<ProviderCapabilities>> = {
  // Anthropic models
  'anthropic/claude-sonnet-4-20250514': {
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsExtendedThinking: true,
  },
  'anthropic/claude-3-5-sonnet-20241022': {
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsExtendedThinking: false,
  },
  'anthropic/claude-3-5-haiku-20241022': {
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsExtendedThinking: false,
  },
  'anthropic/claude-3-opus-20240229': {
    maxContextWindow: 200_000,
    maxOutputTokens: 4_096,
    supportsExtendedThinking: false,
  },

  // OpenAI models
  'openai/gpt-4o': {
    maxContextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStructuredOutput: true,
  },
  'openai/gpt-4o-mini': {
    maxContextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsStructuredOutput: true,
  },
  'openai/gpt-4-turbo': {
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsStructuredOutput: false,
  },
  'openai/gpt-3.5-turbo': {
    maxContextWindow: 16_385,
    maxOutputTokens: 4_096,
    supportsStructuredOutput: false,
  },

  // DeepSeek models
  'deepseek/deepseek-v4-pro': {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
  },
  'deepseek/deepseek-v4-flash': {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
  },

  // Qwen models
  'qwen/qwen-max': {
    maxContextWindow: 32_000,
    maxOutputTokens: 8_192,
  },
  'qwen/qwen-plus': {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
  },
  'qwen/qwen-turbo': {
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
  },

  // GLM models
  'glm/glm-4-plus': {
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
  },
  'glm/glm-4-flash': {
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
  },

  // Ollama models — tool support and context window are model-dependent
  'ollama/llama3': {
    maxContextWindow: 8_192,
    supportsToolUse: false,
  },
  'ollama/llama3.1': {
    maxContextWindow: 128_000,
    supportsToolUse: true,
  },
  'ollama/llama3.2': {
    maxContextWindow: 128_000,
    supportsToolUse: true,
  },
  'ollama/llama3.3': {
    maxContextWindow: 128_000,
    supportsToolUse: true,
  },
  'ollama/mistral': {
    maxContextWindow: 8_192,
    supportsToolUse: false,
  },
  'ollama/mixtral': {
    maxContextWindow: 32_768,
    supportsToolUse: true,
  },
  'ollama/qwen2': {
    maxContextWindow: 32_000,
    supportsToolUse: true,
  },
  'ollama/qwen2.5': {
    maxContextWindow: 128_000,
    supportsToolUse: true,
  },
  'ollama/gemma2': {
    maxContextWindow: 8_192,
    supportsToolUse: false,
  },
  'ollama/phi3': {
    maxContextWindow: 128_000,
    supportsToolUse: false,
  },
  'ollama/deepseek-coder': {
    maxContextWindow: 16_384,
    supportsToolUse: true,
  },
  'ollama/codellama': {
    maxContextWindow: 100_000,
    supportsToolUse: true,
  },
};

// TieredCache for merged capabilities with hit rate tracking
const capabilitiesCache = getCacheManager().getOrCreate<ProviderCapabilities>(
  'provider-capabilities', 'capability', { maxSize: 100 }
);

/**
 * Get capabilities for a provider, with optional model-specific overrides.
 * Caches merged results for repeated lookups.
 */
export function getCapabilities(provider: string, model?: string): ProviderCapabilities {
  const base = PROVIDER_CAPABILITIES[provider] ?? DEFAULT_CAPABILITIES;

  if (!model) return base;

  const cacheKey = `${provider}/${model}`;
  const cached = capabilitiesCache.get(cacheKey);
  if (cached) return cached;

  const override = MODEL_OVERRIDES[cacheKey];
  if (!override) return base;

  const merged = { ...base, ...override };
  capabilitiesCache.set(cacheKey, merged);
  return merged;
}

/**
 * Check if a provider supports a specific capability.
 */
export function hasCapability(provider: string, capability: keyof ProviderCapabilities, model?: string): boolean {
  const caps = getCapabilities(provider, model);
  const value = caps[capability];
  return typeof value === 'boolean' ? value : false;
}

/**
 * Get the recommended temperature for a provider/model.
 */
export function getRecommendedTemperature(provider: string, model?: string): number {
  return getCapabilities(provider, model).recommendedTemperature;
}

/**
 * Get the max context window for a provider/model.
 */
export function getMaxContextWindow(provider: string, model?: string): number {
  return getCapabilities(provider, model).maxContextWindow;
}

/**
 * Get the prompt caching strategy for a provider/model.
 */
export function getCachingStrategy(provider: string, model?: string): CacheStrategy {
  return getCapabilities(provider, model).prefixCachingStrategy;
}
