// API Client Factory and Index
// Creates appropriate client based on provider configuration

export { BaseApiClient, ApiError } from './BaseApiClient';
export type {
  LLMStreamEvent,
  TokenUsage,
  LLMRequestConfig,
  LLMResponse,
} from './BaseApiClient';

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

export type LLMProvider = 'openai' | 'qwen' | 'glm' | 'deepseek' | 'openai-compatible' | 'anthropic' | 'ollama';

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
    supported: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
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
      if (!apiKey) {
        throw new Error('OpenAI API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://api.openai.com',
        model: resolveModel('openai', model),
        provider: 'openai',
      });

    case 'qwen':
      if (!apiKey) {
        throw new Error('Qwen (DashScope) API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://dashscope.aliyuncs.com',
        model: resolveModel('qwen', model),
        provider: 'qwen',
      });

    case 'glm':
      if (!apiKey) {
        throw new Error('GLM (Zhipu AI) API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://open.bigmodel.cn/api/paas',
        model: resolveModel('glm', model),
        provider: 'glm',
      });

    case 'deepseek':
      if (!apiKey) {
        throw new Error('DeepSeek API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://api.deepseek.com',
        model: resolveModel('deepseek', model),
        provider: 'deepseek',
      });

    case 'openai-compatible':
      return new OpenAICompatibleClient({
        apiKey: apiKey || '',
        baseUrl: baseUrl || '',
        model: resolveModel('openai-compatible', model),
        provider: 'openai',
      });

    case 'anthropic':
      if (!apiKey) {
        throw new Error('Anthropic API key is required');
      }
      return new AnthropicClient({
        apiKey,
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
