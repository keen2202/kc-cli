import type { ApiKeyPattern, LLMProvider } from '../api/provider-specs';
import { PROVIDER_SPECS } from '../api/provider-specs';

/**
 * Validate an API key for the given provider.
 * Returns null if valid, or an error message string if invalid.
 *
 * Provider-specific format rules are read from the PROVIDER_SPECS table (T17);
 * this function only applies them. The rejection messages are historical
 * strings — do not reword them (tests and users match on them verbatim).
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

  // Unknown-at-runtime ids (JS callers): no format enforced, same as before.
  const pattern: ApiKeyPattern = PROVIDER_SPECS[provider]?.keyPattern ?? { kind: 'none' };

  // Provider-specific format checks
  switch (pattern.kind) {
    case 'prefix': {
      if (!pattern.prefixes.some(prefix => trimmed.startsWith(prefix))) {
        const label = pattern.messageLabel ?? provider;
        return `Invalid ${label} key format — keys should start with "${pattern.prefixes[0]}".`;
      }
      break;
    }
    case 'minLength': {
      if (trimmed.length < pattern.minLength) {
        const label = pattern.messageLabel ?? provider;
        return `Invalid ${label} key — keys should be at least ${pattern.minLength} characters.`;
      }
      break;
    }
    case 'none':
      // No API-key format enforced for this provider
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
