import type { LLMProvider } from '../api';

/**
 * Validate an API key for the given provider.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateApiKey(key: string, provider: LLMProvider): string | null {
  if (!key || key.trim().length === 0) {
    return 'API key is empty. Use /key <your-key> to set one, or set KC_API_KEY in your environment.';
  }

  const trimmed = key.trim();

  // Minimum key length (all major providers use keys >= 20 chars)
  if (trimmed.length < 8) {
    return `API key is too short (${trimmed.length} chars). A valid key is typically 20+ characters.`;
  }

  // Provider-specific format checks
  switch (provider) {
    case 'anthropic':
      if (!trimmed.startsWith('sk-ant-')) {
        return 'Invalid Anthropic key format — keys should start with "sk-ant-".';
      }
      break;
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'glm':
    case 'mimo':
    case 'kimi':
    case 'step':
    case 'openai-compatible':
      if (!trimmed.startsWith('sk-') && !trimmed.startsWith('fk-')) {
        return `Invalid ${provider} key format — keys should start with "sk-".`;
      }
      break;
    case 'gemini':
      // Google AI Studio keys are typically alphanumeric strings without a fixed prefix
      if (trimmed.length < 20) {
        return 'Invalid Gemini key — keys should be at least 20 characters.';
      }
      break;
    case 'ollama':
      // Ollama doesn't use API keys
      break;
    default:
      break;
  }

  return null;
}

/**
 * Check if an API key appears to be set (non-empty, reasonable length).
 * Does NOT validate provider-specific format — use validateApiKey for that.
 */
export function hasApiKey(key: string | undefined): boolean {
  return !!(key && key.trim().length >= 8);
}
