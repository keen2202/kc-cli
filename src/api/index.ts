import { logger } from '../services/logger';
// API Client Factory and Index
// Creates appropriate client based on provider configuration

export { BaseApiClient, ApiError } from './BaseApiClient';
export type {
  LLMStreamEvent,
  TokenUsage,
  LLMRequestConfig,
  LLMResponse,
} from './BaseApiClient';

export { CachePrefixService, buildCacheStrategy, canonicalStringify } from '../services/cachePrefix';
export type { FrozenPrefix, EphemeralContent, CacheStrategy as CacheStrategyType } from '../services/cachePrefix';

export { OpenAICompatibleClient } from './OpenAICompatibleClient';
export type { OpenAICompatibleConfig } from './OpenAICompatibleClient';

export { AnthropicClient } from './AnthropicClient';
export type { AnthropicConfig } from './AnthropicClient';

export { OllamaClient } from './OllamaClient';
export type { OllamaConfig } from './OllamaClient';

import { BaseApiClient, LLMRequestConfig } from './BaseApiClient';
import { OpenAICompatibleClient } from './OpenAICompatibleClient';
import { AnthropicClient } from './AnthropicClient';
import { OllamaClient } from './OllamaClient';
// Single source of truth for provider/model capacity + registry data (T16).
export type { LLMProvider, ProviderModelInfo } from './capabilities';
export { PROVIDER_MODELS, resolveModel } from './capabilities';
import { resolveModel } from './capabilities';
import type { LLMProvider } from './capabilities';
import { PROVIDER_SPECS } from './provider-specs';

export interface APIClientFactoryConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

/**
 * Create an LLM API client based on provider configuration.
 * Factory function that abstracts away provider-specific initialization.
 *
 * Provider identity data (default base URLs, key patterns) comes from the
 * PROVIDER_SPECS table (T17) — the explicit switch below only selects the
 * client CLASS, which is genuinely per-provider logic.
 */
export function createAPIClient(config: APIClientFactoryConfig): BaseApiClient {
  const { provider, apiKey, baseUrl, model } = config;

  if (!(provider in PROVIDER_SPECS)) {
    throw new Error(`Unknown LLM provider: ${provider}. Supported: ${Object.keys(PROVIDER_SPECS).join(', ')}`);
  }

  const resolvedBaseUrl = baseUrl || PROVIDER_SPECS[provider].baseUrl;
  const resolvedModel = resolveModel(provider, model);

  switch (provider) {
    case 'anthropic':
      return new AnthropicClient({
        apiKey: apiKey || '',
        baseUrl: resolvedBaseUrl,
        model: resolvedModel,
      });

    case 'ollama':
      return new OllamaClient({
        baseUrl: resolvedBaseUrl,
        model: resolvedModel,
      });

    default:
      // All remaining providers speak the OpenAI-compatible wire protocol.
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: resolvedBaseUrl,
        model: resolvedModel,
        provider: provider === 'openai-compatible' ? 'openai' : provider,
      });
  }
}

