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

export type LLMProvider = 'openai' | 'qwen' | 'glm' | 'deepseek' | 'mimo' | 'kimi' | 'step' | 'gemini' | 'openai-compatible' | 'anthropic' | 'ollama';

export interface APIClientFactoryConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface ProviderModelInfo {
  default: string;
  supported: string[];
}

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
 * Create an LLM API client based on provider configuration.
 * Factory function that abstracts away provider-specific initialization.
 */
export function createAPIClient(config: APIClientFactoryConfig): BaseApiClient {
  const { provider, apiKey, baseUrl, model } = config;

  switch (provider) {
    case 'openai':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.openai.com',
        model: resolveModel('openai', model),
        provider: 'openai',
      });

    case 'qwen':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://dashscope.aliyuncs.com',
        model: resolveModel('qwen', model),
        provider: 'qwen',
      });

    case 'glm':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://open.bigmodel.cn/api/paas',
        model: resolveModel('glm', model),
        provider: 'glm',
      });

    case 'deepseek':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.deepseek.com',
        model: resolveModel('deepseek', model),
        provider: 'deepseek',
      });

    case 'mimo':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.xiaomimimo.com',
        model: resolveModel('mimo', model),
        provider: 'mimo',
      });

    case 'kimi':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.moonshot.cn',
        model: resolveModel('kimi', model),
        provider: 'kimi',
      });

    case 'step':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.stepfun.com',
        model: resolveModel('step', model),
        provider: 'step',
      });

    case 'gemini':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://generativelanguage.googleapis.com',
        model: resolveModel('gemini', model),
        provider: 'gemini',
      });

    case 'openai-compatible':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || '',
        model: resolveModel('openai-compatible', model),
        provider: 'openai',
      });

    case 'anthropic':
      return new AnthropicClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || 'https://api.anthropic.com',
        model: resolveModel('anthropic', model),
      });

    case 'ollama':
      return new OllamaClient({
        baseUrl: baseUrl || 'http://localhost:11434',
        model: resolveModel('ollama', model),
      });

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Supported: openai, qwen, glm, deepseek, openai-compatible, anthropic, ollama`);
  }
}

/**
 * Get default base URL for a provider
 */
export function getDefaultBaseUrl(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com';
    case 'glm':
      return 'https://open.bigmodel.cn/api/paas';
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'mimo':
      return 'https://api.xiaomimimo.com';
    case 'kimi':
      return 'https://api.moonshot.cn';
    case 'step':
      return 'https://api.stepfun.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'openai-compatible':
      return '';
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'ollama':
      return 'http://localhost:11434';
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Validate API key format for a provider
 */
export function validateApiKeyFormat(provider: LLMProvider, apiKey: string): boolean {
  switch (provider) {
    case 'openai':
      return apiKey.startsWith('sk-');
    case 'qwen':
      // DashScope keys don't have a specific prefix
      return apiKey.length > 0;
    case 'glm':
      // Zhipu AI keys don't have a specific prefix
      return apiKey.length > 0;
    case 'deepseek':
      return apiKey.length > 0;
    case 'mimo':
    case 'kimi':
    case 'step':
    case 'gemini':
      return apiKey.length > 0;
    case 'openai-compatible':
      return true;
    case 'anthropic':
      return apiKey.startsWith('sk-ant-');
    case 'ollama':
      return true; // No API key required
    default:
      return false;
  }
}

/**
 * Get provider display name
 */
export function getProviderDisplayName(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'qwen':
      return 'Qwen (通义千问)';
    case 'glm':
      return 'GLM (智谱AI)';
    case 'deepseek':
      return 'DeepSeek';
    case 'mimo':
      return 'MiMo (小米)';
    case 'kimi':
      return 'Kimi (月之暗面)';
    case 'step':
      return 'Step (阶跃星辰)';
    case 'gemini':
      return 'Gemini (Google)';
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'anthropic':
      return 'Anthropic';
    case 'ollama':
      return 'Ollama (本地)';
    default:
      return provider;
  }
}
