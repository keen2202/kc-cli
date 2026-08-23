// Provider identity spec — single source of truth (audit round3 T17 / round3-spec §4-M3).
//
// This module is the ONE place that declares a provider's *identity* data:
//   - its id (the object key ⇒ the ProviderId union is derived from this table)
//   - its default base URL
//   - its human-readable display name
//   - its API-key format pattern (used by utils/api-key.ts)
//
// Adding a provider = adding one row here. Everything else derives:
//   ProviderId union      → keyof typeof PROVIDER_SPECS        (this file, re-exported via api/capabilities)
//   config z.enum         → PROVIDER_IDS                       (bootstrap/config.ts)
//   key-format validation → spec.keyPattern                    (utils/api-key.ts)
//   base URL resolution   → PROVIDER_SPECS[provider].baseUrl   (api/index.ts factory)
//
// Scope boundary (T16 contract): capacity data (context windows, caching
// strategy, models) stays in capabilities.ts — do not copy it here.
//
// Deliberately import-free: bootstrap/config.ts evaluates extremely early at
// boot and must not drag services/cache (a capabilities.ts transitive) into
// module-eval order; services/cachePrefix.ts also reads provider identity from
// here without cycle risk.

/**
 * API-key acceptance pattern for a provider.
 * - `prefix`    : key must start with one of `prefixes`
 * - `minLength` : key must be at least `minLength` chars (no fixed prefix)
 * - `none`      : provider does not use API keys (or no format enforced)
 *
 * `messageLabel` overrides the provider name quoted in the rejection message;
 * it defaults to the raw provider id (historical behavior: messages read e.g.
 * "Invalid openai key format" but "Invalid Anthropic key format").
 */
export type ApiKeyPattern =
  | { readonly kind: 'prefix'; readonly prefixes: readonly [string, ...string[]]; readonly messageLabel?: string }
  | { readonly kind: 'minLength'; readonly minLength: number; readonly messageLabel?: string }
  | { readonly kind: 'none' };

/** Identity data for one LLM provider. */
export interface ProviderSpec {
  /** Default API base URL (empty string = caller must supply one). */
  readonly baseUrl: string;
  /** Human-readable name for UI/docs. */
  readonly displayName: string;
  /** API-key format rule enforced by validateApiKey(). */
  readonly keyPattern: ApiKeyPattern;
}

/**
 * The provider spec table. Row order is load-bearing: PROVIDER_IDS preserves it,
 * so keep new rows in the historical enum order used by config validation
 * error messages ('anthropic', 'openai', 'ollama', ...).
 */
export const PROVIDER_SPECS = {
  'anthropic': {
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Anthropic',
    keyPattern: { kind: 'prefix', prefixes: ['sk-ant-'], messageLabel: 'Anthropic' },
  },
  'openai': {
    baseUrl: 'https://api.openai.com',
    displayName: 'OpenAI',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'ollama': {
    baseUrl: 'http://localhost:11434',
    displayName: 'Ollama',
    // Ollama doesn't use API keys
    keyPattern: { kind: 'none' },
  },
  'deepseek': {
    baseUrl: 'https://api.deepseek.com',
    displayName: 'DeepSeek',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'openai-compatible': {
    baseUrl: '',
    displayName: 'OpenAI-Compatible',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'qwen': {
    baseUrl: 'https://dashscope.aliyuncs.com',
    displayName: 'Qwen',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'glm': {
    baseUrl: 'https://open.bigmodel.cn/api/paas',
    displayName: 'GLM',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'mimo': {
    baseUrl: 'https://api.xiaomimimo.com',
    displayName: 'MiMo',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'kimi': {
    baseUrl: 'https://api.moonshot.cn',
    displayName: 'Kimi',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'step': {
    baseUrl: 'https://api.stepfun.com',
    displayName: 'Step',
    keyPattern: { kind: 'prefix', prefixes: ['sk-', 'fk-'] },
  },
  'gemini': {
    baseUrl: 'https://generativelanguage.googleapis.com',
    displayName: 'Gemini',
    // Google AI Studio keys are typically alphanumeric strings without a fixed prefix
    keyPattern: { kind: 'minLength', minLength: 20, messageLabel: 'Gemini' },
  },
} as const satisfies Record<string, ProviderSpec>;

/** Provider id union — derived, never hand-written. */
export type ProviderId = keyof typeof PROVIDER_SPECS;

/**
 * Historical alias for ProviderId (pre-T17 name; kept stable because
 * utils/, state/, acp/, bootstrap/ import `LLMProvider` from the api barrel).
 */
export type LLMProvider = ProviderId;

/**
 * Provider ids as a tuple, in table order. Consumed by z.enum() in
 * bootstrap/config.ts so the config schema accepts exactly this set.
 */
export const PROVIDER_IDS: [ProviderId, ...ProviderId[]] = Object.keys(
  PROVIDER_SPECS
) as [ProviderId, ...ProviderId[]];
