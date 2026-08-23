// Model-capacity single-source-of-truth guard (audit round3 T16 / round3-spec §4-M2).
//
// After the T16 refactor exactly ONE capacity table remains: capabilities.ts
// (PROVIDER_CAPABILITIES + MODEL_OVERRIDES). The duplicate tables that used to
// live in api/index.ts (PROVIDER_MODELS numeric twin) and inside
// AnthropicClient / OpenAICompatibleClient getModelInfo() were deleted; all
// consumers read getCapabilities().
//
// Because only one table remains, the original "assert PROVIDER_MODELS ∩
// PROVIDER_CAPABILITIES numeric equality" design dissolves by construction.
// This suite implements the sanctioned fallback plus a routing invariant:
//   1. Frozen fixture lock — capabilities.ts values for the entries that
//      historically drifted (deepseek-v4-pro 131_072 vs 128_000, …) are pinned;
//      editing them silently fails here.
//   2. Client-derivation invariant — every client's getModelInfo() numbers must
//      EQUAL the getCapabilities() lookup for the same (provider, model), so a
//      reintroduced local numeric table that diverges fails immediately.
//   3. Registry ∩ capability sanity — for providers present in BOTH
//      PROVIDER_MODELS and PROVIDER_CAPABILITIES, every supported model (and
//      every MODEL_OVERRIDES entry) merges to sane numeric fields.

import { describe, it, expect } from 'vitest';
import {
  PROVIDER_MODELS,
  PROVIDER_CAPABILITIES,
  MODEL_OVERRIDES,
  getCapabilities,
} from './capabilities';
import { AnthropicClient } from './AnthropicClient';
import { OpenAICompatibleClient } from './OpenAICompatibleClient';
import { OllamaClient } from './OllamaClient';

// ── Frozen fixtures: entries involved in the pre-T16 drift ────────────────

const CONTEXT_FIXTURES: Array<{ key: string; maxContextWindow: number }> = [
  // Adjudication (T16): DeepSeek documents "128K"; the rival 131_072 was a
  // later binary reinterpretation (128×1024) in a duplicated client table.
  // Canonical value = 128_000, consistent with every other 128K-class row.
  { key: 'deepseek/deepseek-v4-pro', maxContextWindow: 128_000 },
  { key: 'deepseek/deepseek-v4-flash', maxContextWindow: 128_000 },
  // Absorbed from OpenAICompatibleClient's deleted getModelInfo table (T16).
  { key: 'openai/gpt-4', maxContextWindow: 8_192 },
  { key: 'openai/gpt-3.5-turbo', maxContextWindow: 16_385 },
  { key: 'qwen/qwen-long', maxContextWindow: 1_000_000 },
];

const OUTPUT_FIXTURES: Array<{ key: string; maxOutputTokens: number }> = [
  { key: 'deepseek/deepseek-v4-pro', maxOutputTokens: 8_192 },
  // Absorbed from AnthropicClient's deleted getModelInfo table (T16):
  // claude-3 generation sonnet/haiku cap output at 4096.
  { key: 'anthropic/claude-3-sonnet-20240229', maxOutputTokens: 4_096 },
  { key: 'anthropic/claude-3-haiku-20240307', maxOutputTokens: 4_096 },
];

function splitKey(key: string): { provider: string; model: string } {
  const idx = key.indexOf('/');
  return { provider: key.slice(0, idx), model: key.slice(idx + 1) };
}

// ── 1. Fixture lock on capabilities.ts values ─────────────────────────────

describe('capabilities SSOT: frozen fixture of previously-drifted entries (T16)', () => {
  it.each(CONTEXT_FIXTURES)('$key pins maxContextWindow=$maxContextWindow', ({ key, maxContextWindow }) => {
    const { provider, model } = splitKey(key);
    const caps = getCapabilities(provider, model);
    expect(caps.maxContextWindow).toBe(maxContextWindow);
  });

  it('adjudicates deepseek-v4-pro at 128_000, rejecting the drifted 131_072 binary reading', () => {
    const caps = getCapabilities('deepseek', 'deepseek-v4-pro');
    expect(caps.maxContextWindow).not.toBe(131_072);
    // Provider-level row agrees with the model-level override (they drifted
    // apart from the CLIENT copy only, never internally).
    expect(PROVIDER_CAPABILITIES.deepseek?.maxContextWindow).toBe(128_000);
  });

  it.each(OUTPUT_FIXTURES)('$key pins maxOutputTokens=$maxOutputTokens', ({ key, maxOutputTokens }) => {
    const { provider, model } = splitKey(key);
    const caps = getCapabilities(provider, model);
    expect(caps.maxOutputTokens).toBe(maxOutputTokens);
  });
});

// ── 2. Merge fidelity: overrides actually flow through getCapabilities ────

describe('capabilities SSOT: merge fidelity', () => {
  it('applies every MODEL_OVERRIDES entry on top of its provider row', () => {
    for (const [key, override] of Object.entries(MODEL_OVERRIDES)) {
      const { provider, model } = splitKey(key);
      if (!PROVIDER_CAPABILITIES[provider]) continue; // orphan override would be its own bug
      const merged = getCapabilities(provider, model);
      for (const [field, value] of Object.entries(override)) {
        expect(merged[field as keyof typeof merged]).toBe(value);
      }
    }
  });

  it('keeps numeric fields sane across the PROVIDER_MODELS ∩ PROVIDER_CAPABILITIES intersection', () => {
    let checked = 0;
    for (const provider of Object.keys(PROVIDER_MODELS) as Array<keyof typeof PROVIDER_MODELS>) {
      const providerCaps = PROVIDER_CAPABILITIES[provider];
      if (!providerCaps) continue; // mimo/kimi/step/gemini have no capability row yet (documented default applies)
      for (const model of PROVIDER_MODELS[provider].supported) {
        const caps = getCapabilities(provider, model);
        expect(Number.isInteger(caps.maxContextWindow)).toBe(true);
        expect(caps.maxContextWindow).toBeGreaterThan(0);
        expect(Number.isInteger(caps.maxOutputTokens)).toBe(true);
        expect(caps.maxOutputTokens).toBeGreaterThan(0);
        expect(caps.maxOutputTokens).toBeLessThanOrEqual(caps.maxContextWindow);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ── 3. Client-derivation invariant: no re-hardcoded numeric tables ────────

describe('client getModelInfo derives from capabilities.ts (T16 anti-drift)', () => {
  it('OpenAICompatibleClient tracks getCapabilities per provider-scoped model', () => {
    const cases: Array<{ model: string; provider?: 'openai' | 'qwen' | 'glm' | 'deepseek' | 'mimo' }> = [
      { model: 'gpt-4' }, // absorbed 8K context row
      { model: 'gpt-4o' },
      { model: 'gpt-3.5-turbo' },
      { model: 'deepseek-v4-pro', provider: 'deepseek' }, // the adjudicated entry
      { model: 'qwen-long', provider: 'qwen' },
      { model: 'glm-4-air', provider: 'glm' },
      { model: 'mimo-v2.5-pro', provider: 'mimo' }, // no capability row → documented default
      { model: 'unknown-model-xyz' }, // falls back to provider-level window
    ];
    for (const c of cases) {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: '',
        model: c.model,
        ...(c.provider ? { provider: c.provider } : {}),
      });
      const info = client.getModelInfo();
      const caps = getCapabilities(c.provider ?? 'openai', c.model);
      expect(info.maxTokens).toBe(caps.maxContextWindow);
      expect(info.supportsStreaming).toBe(caps.supportsStreaming);
      expect(info.supportsTools).toBe(caps.supportsToolUse);
    }
  });

  it('OpenAICompatibleClient returns the adjudicated 128_000 for deepseek-v4-pro (never 131_072)', () => {
    const client = new OpenAICompatibleClient({
      apiKey: 'sk-test',
      baseUrl: '',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
    });
    expect(client.getModelInfo().maxTokens).toBe(128_000);
    expect(client.getModelInfo().maxTokens).not.toBe(131_072);
  });

  it('AnthropicClient exposes maxOutputTokens from capabilities (its historical table semantics)', () => {
    const cases: Array<[string, number]> = [
      ['claude-sonnet-4-20250514', 8_192],
      ['claude-3-5-sonnet-20241022', 8_192],
      ['claude-3-opus-20240229', 4_096],
      ['claude-3-sonnet-20240229', 4_096], // absorbed row
      ['claude-3-haiku-20240307', 4_096], // absorbed row
      ['claude-future-model', 8_192], // unknown → provider default
    ];
    for (const [model, expected] of cases) {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(expected);
      const caps = getCapabilities('anthropic', model);
      expect(info.maxTokens).toBe(caps.maxOutputTokens);
      expect(info.supportsStreaming).toBe(caps.supportsStreaming);
      expect(info.supportsTools).toBe(caps.supportsToolUse);
    }
  });

  it('OllamaClient keeps deriving from capabilities (was already migrated)', () => {
    const llama = new OllamaClient({ model: 'llama3' }).getModelInfo();
    expect(llama.maxTokens).toBe(getCapabilities('ollama', 'llama3').maxContextWindow);
    expect(llama.supportsTools).toBe(false);

    const unknown = new OllamaClient({ model: 'unknown-model-xyz' }).getModelInfo();
    expect(unknown.maxTokens).toBe(getCapabilities('ollama').maxContextWindow);
  });
});
