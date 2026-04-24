// API Client Factory and Index
// Creates appropriate client based on provider configuration

export { BaseApiClient } from './BaseApiClient';
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

export type LLMProvider = 'openai' | 'qwen' | 'glm' | 'anthropic' | 'ollama';

export interface APIClientFactoryConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
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
        model,
        provider: 'openai',
      });

    case 'qwen':
      if (!apiKey) {
        throw new Error('Qwen (DashScope) API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://dashscope.aliyuncs.com',
        model,
        provider: 'qwen',
      });

    case 'glm':
      if (!apiKey) {
        throw new Error('GLM (Zhipu AI) API key is required');
      }
      return new OpenAICompatibleClient({
        apiKey,
        baseUrl: baseUrl || 'https://open.bigmodel.cn/api/paas',
        model,
        provider: 'glm',
      });

    case 'anthropic':
      if (!apiKey) {
        throw new Error('Anthropic API key is required');
      }
      return new AnthropicClient({
        apiKey,
        baseUrl: baseUrl || 'https://api.anthropic.com',
        model,
      });

    case 'ollama':
      return new OllamaClient({
        baseUrl: baseUrl || 'http://localhost:11434',
        model,
      });

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Supported: openai, qwen, glm, anthropic, ollama`);
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
    case 'anthropic':
      return 'Anthropic';
    case 'ollama':
      return 'Ollama (本地)';
    default:
      return provider;
  }
}
