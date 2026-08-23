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

// ── Provider / model registry (single source of truth, audit round3 T16) ────
//
// This module is the ONLY place that declares provider/model capacity data.
// The duplicates that used to live in api/index.ts (PROVIDER_MODELS table)
// and in AnthropicClient/OpenAICompatibleClient getModelInfo() hardcoded
// tables were removed and now read from here. Do not reintroduce local
// copies — extend the tables below instead (guarded by
// capabilities-consistency.test.ts).

/**
 * Providers understood by the API client factory.
 * Derived from the PROVIDER_SPECS table (T17) — the id set is owned there;
 * this alias keeps the historical name used across the codebase.
 */
import type { ProviderId } from './provider-specs';
export type LLMProvider = ProviderId;

export interface ProviderModelInfo {
  default: string;
  supported: string[];
}

/**
 * Default/supported model names per provider (identity data, not capacity).
 * Capacity numbers live in PROVIDER_CAPABILITIES + MODEL_OVERRIDES below.
 */
export const PROVIDER_MODELS: Record<LLMProvider, ProviderModelInfo> = {
  'anthropic': {
    default: 'claude-sonnet-4-20250514',
    supported: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229', 'mimo-v2.5-pro'],
  },
  'openai': {
    default: 'gpt-4o',
    supported: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  'deepseek': {
    default: 'deepseek-v4-pro',
    supported: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  'qwen': {
    default: 'qwen-plus',
    supported: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long'],
  },
  'glm': {
    default: 'glm-4-plus',
    supported: ['glm-4', 'glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },
  'mimo': {
    default: 'mimo-v2.5-pro',
    supported: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash'],
  },
  'kimi': {
    default: 'kimi-k2.6',
    supported: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2', 'kimi-k2-thinking', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  'step': {
    default: 'step-3.7-flash',
    supported: ['step-3.7-flash', 'step-3.5-flash', 'step-2-16k', 'step-1-8k', 'step-1-32k', 'step-1-128k'],
  },
  'gemini': {
    default: 'gemini-2.5-pro',
    supported: [
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'gemini-2.0-flash', 'gemini-2.0-flash-lite',
      'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
    ],
  },
  'openai-compatible': {
    default: '',
    supported: [],
  },
  'ollama': {
    default: 'llama3',
    supported: [],
  },
};

/**
 * Resolve a requested model name against a provider's supported list,
 * falling back to the provider default with a console warning.
 */
export function resolveModel(provider: LLMProvider, requestedModel: string): string {
  const info = PROVIDER_MODELS[provider];
  if (!info) return requestedModel;

  // Open-ended providers accept any model
  if (info.supported.length === 0) {
    return requestedModel || info.default;
  }

  // Model is valid for this provider
  if (info.supported.includes(requestedModel)) {
    return requestedModel;
  }

  // Fall back to provider default
  if (requestedModel !== info.default) {
    console.warn(`Model '${requestedModel}' not supported by ${provider}, using '${info.default}'`);
  }
  return info.default;
}

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
 * Exported for the T16 consistency test (capabilities-consistency.test.ts),
 * which walks PROVIDER_MODELS ∩ MODEL_OVERRIDES to guard against drift.
 */
export const MODEL_OVERRIDES: Record<string, Partial<ProviderCapabilities>> = {
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
  // Absorbed from AnthropicClient's duplicate getModelInfo table (T16):
  // claude-3 generation sonnet/haiku cap output at 4096 (vs 8192 for 3.5+).
  'anthropic/claude-3-sonnet-20240229': {
    maxContextWindow: 200_000,
    maxOutputTokens: 4_096,
    supportsExtendedThinking: false,
  },
  'anthropic/claude-3-haiku-20240307': {
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
  // Absorbed from OpenAICompatibleClient's duplicate getModelInfo table (T16):
  // classic gpt-4 has an 8K context, distinct from gpt-4-turbo/4o at 128K.
  'openai/gpt-4': {
    maxContextWindow: 8_192,
    maxOutputTokens: 8_192,
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
  // Adjudication (audit round3 T16): maxContextWindow is canonical at
  // 128_000. The 131_072 value that lived in OpenAICompatibleClient.getModelInfo
  // was a binary reinterpretation (128×1024) of DeepSeek's documented "128K"
  // context length, added ad hoc (commit ccac398) after this table existed
  // (commit ff52cc5). Every other 128K-class row in this table uses decimal
  // 128_000, so the lone binary multiple was the drift. Do not change without
  // updating capabilities-consistency.test.ts.
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
  // Absorbed from OpenAICompatibleClient's duplicate getModelInfo table (T16);
  // qwen-long is a long-context retrieval model, distinct from the 128K rows.
  'qwen/qwen-long': {
    maxContextWindow: 1_000_000,
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
 * Get the max context window for a provider/model.
 */
export function getMaxContextWindow(provider: string, model?: string): number {
  return getCapabilities(provider, model).maxContextWindow;
}
