// T17 behavior-invariance pins: PROVIDER_SPECS is now the single source for
// provider identity data (ids, base URLs, display names, key patterns) and the
// capability registry is the single source for cache strategies. These tests
// pin every derived consumer against the LITERAL values that existed before
// the collapse, so any drift in table order, accepted keys, messages, base
// URLs, or strategy mapping fails here rather than silently changing runtime
// behavior.
import { describe, it, expect } from 'vitest';

import {
  PROVIDER_SPECS,
  PROVIDER_IDS,
} from './provider-specs';
import type { LLMProvider } from './capabilities';
import { createAPIClient } from './index';
import { buildCacheStrategy } from '../services/cachePrefix';
import { validateApiKey } from '../utils/api-key';
import { ConfigSchema } from '../bootstrap/config';

/** Historical config.ts:14 z.enum — order preserved verbatim. */
const LEGACY_CONFIG_ENUM = [
  'anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible',
  'qwen', 'glm', 'mimo', 'kimi', 'step', 'gemini',
] as const;

/** Historical api/index.ts PROVIDER_BASE_URLS values. */
const LEGACY_BASE_URLS: Record<string, string> = {
  'openai': 'https://api.openai.com',
  'qwen': 'https://dashscope.aliyuncs.com',
  'glm': 'https://open.bigmodel.cn/api/paas',
  'deepseek': 'https://api.deepseek.com',
  'mimo': 'https://api.xiaomimimo.com',
  'kimi': 'https://api.moonshot.cn',
  'step': 'https://api.stepfun.com',
  'gemini': 'https://generativelanguage.googleapis.com',
  'openai-compatible': '',
  'anthropic': 'https://api.anthropic.com',
  'ollama': 'http://localhost:11434',
};

/** Historical cachePrefix.ts buildCacheStrategy switch. */
function legacyBuildCacheStrategy(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'explicit-breakpoints';
    case 'deepseek': return 'auto-prefix';
    case 'openai': return 'prompt-cache';
    default: return 'none';
  }
}

describe('PROVIDER_SPECS — derived id set', () => {
  it('exposes exactly the historical provider ids in config-enum order', () => {
    expect(PROVIDER_IDS).toEqual([...LEGACY_CONFIG_ENUM]);
    expect(Object.keys(PROVIDER_SPECS)).toEqual([...LEGACY_CONFIG_ENUM]);
  });

  it('ConfigSchema accepts exactly the table ids and nothing else', () => {
    for (const provider of LEGACY_CONFIG_ENUM) {
      expect(ConfigSchema.parse({ provider }).provider).toBe(provider);
    }
    expect(() => ConfigSchema.parse({ provider: 'invalid-provider' })).toThrow();
    expect(() => ConfigSchema.parse({ provider: 'openai ' })).toThrow();
  });

  it('keeps the historical default provider (deepseek)', () => {
    expect(ConfigSchema.parse({}).provider).toBe('deepseek');
  });
});

describe('PROVIDER_SPECS — base URLs feed the client factory unchanged', () => {
  it('table values equal the legacy PROVIDER_BASE_URLS literals', () => {
    for (const [id, url] of Object.entries(LEGACY_BASE_URLS)) {
      expect(PROVIDER_SPECS[id as LLMProvider].baseUrl, id).toBe(url);
    }
  });

  function resolvedBaseUrl(provider: LLMProvider, baseUrl?: string): string {
    const client = createAPIClient({ provider, apiKey: 'sk-test-key-1234', baseUrl, model: 'x' });
    return (client as unknown as { baseUrl: string }).baseUrl;
  }

  it('createAPIClient resolves default base URLs from the table', () => {
    expect(resolvedBaseUrl('openai')).toBe('https://api.openai.com');
    expect(resolvedBaseUrl('anthropic')).toBe('https://api.anthropic.com');
    expect(resolvedBaseUrl('ollama')).toBe('http://localhost:11434');
    expect(resolvedBaseUrl('qwen')).toBe('https://dashscope.aliyuncs.com');
    expect(resolvedBaseUrl('glm')).toBe('https://open.bigmodel.cn/api/paas');
    expect(resolvedBaseUrl('mimo')).toBe('https://api.xiaomimimo.com');
    expect(resolvedBaseUrl('kimi')).toBe('https://api.moonshot.cn');
    expect(resolvedBaseUrl('step')).toBe('https://api.stepfun.com');
    expect(resolvedBaseUrl('deepseek')).toBe('https://api.deepseek.com');
  });

  it('explicit baseUrl still wins over the table; openai-compatible defaults to empty', () => {
    expect(resolvedBaseUrl('openai', 'https://proxy.example.com')).toBe('https://proxy.example.com');
    expect(resolvedBaseUrl('openai-compatible')).toBe('');
  });

  it('rejects unknown providers with the same error shape', () => {
    expect(() => createAPIClient({ provider: 'nope' as LLMProvider, model: 'x' }))
      .toThrow(/^Unknown LLM provider: nope\. Supported: /);
  });
});

describe('validateApiKey — identical outcomes and messages', () => {
  const OK = null;

  it('rejects empty / too-short keys for every provider first', () => {
    for (const provider of LEGACY_CONFIG_ENUM) {
      expect(validateApiKey('', provider)).toBe(
        'API key is empty. Use /key <your-key> to set one, or set KC_API_KEY in your environment.'
      );
      expect(validateApiKey('   ', provider)).toBe(
        'API key is empty. Use /key <your-key> to set one, or set KC_API_KEY in your environment.'
      );
      expect(validateApiKey('short', provider)).toBe(
        'API key is too short (5 chars). A valid key is typically 20+ characters.'
      );
    }
  });

  it('anthropic requires the sk-ant- prefix (historical message)', () => {
    expect(validateApiKey('sk-ant-api03-aaaaaaaaaaaaaaaa', 'anthropic')).toBe(OK);
    expect(validateApiKey('sk-plain-but-long-enough-key', 'anthropic')).toBe(
      'Invalid Anthropic key format — keys should start with "sk-ant-".'
    );
  });

  it('sk-/fk- group accepts both prefixes and rejects others per provider id', () => {
    const group = ['openai', 'deepseek', 'qwen', 'glm', 'mimo', 'kimi', 'step', 'openai-compatible'] as const;
    for (const provider of group) {
      expect(validateApiKey('sk-1234567890abcdef', provider), provider).toBe(OK);
      expect(validateApiKey('fk-1234567890abcdef', provider), provider).toBe(OK);
      expect(validateApiKey('zz-1234567890abcdef', provider), provider).toBe(
        `Invalid ${provider} key format — keys should start with "sk-".`
      );
    }
  });

  it('gemini enforces min length only (historical message)', () => {
    expect(validateApiKey('a'.repeat(20), 'gemini')).toBe(OK);
    expect(validateApiKey('a'.repeat(19), 'gemini')).toBe(
      'Invalid Gemini key — keys should be at least 20 characters.'
    );
  });

  it('ollama never enforces a format; unknown runtime ids pass through', () => {
    expect(validateApiKey('anything-okay', 'ollama')).toBe(OK);
    expect(validateApiKey('anything-okay', 'unknown-provider' as LLMProvider)).toBe(OK);
  });
});

describe('buildCacheStrategy — identical mapping via the capability registry', () => {
  it('matches the legacy switch for all providers and unknown ids', () => {
    const probes = [...LEGACY_CONFIG_ENUM, 'unknown-provider', '', 'ANTHROPIC'];
    for (const provider of probes) {
      expect(buildCacheStrategy(provider), provider).toBe(legacyBuildCacheStrategy(provider));
    }
  });

  it('pins the exact non-none strategies', () => {
    expect(buildCacheStrategy('anthropic')).toBe('explicit-breakpoints');
    expect(buildCacheStrategy('deepseek')).toBe('auto-prefix');
    expect(buildCacheStrategy('openai')).toBe('prompt-cache');
    expect(buildCacheStrategy('qwen')).toBe('none');
    expect(buildCacheStrategy('no-such-provider')).toBe('none');
  });
});
