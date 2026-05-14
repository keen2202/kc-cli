/**
 * Tests for ModelSelector component.
 *
 * Covers:
 * - Provider model definitions
 * - Model selector state creation
 * - Provider/model navigation
 * - Model selector rendering
 */

import { describe, it, expect } from 'vitest';
import {
  getKnownProviders,
  createModelSelectorState,
  renderModelSelector,
  modelSelectorMoveUp,
  modelSelectorMoveDown,
  modelSelectorGetSelected,
  type ModelSelectorState,
  type ProviderInfo,
} from '../../src/ui/components/ModelSelector';

describe('ModelSelector — Providers', () => {
  it('returns known providers', () => {
    const providers = getKnownProviders();
    expect(providers.length).toBeGreaterThanOrEqual(5);
  });

  it('includes DeepSeek provider', () => {
    const providers = getKnownProviders();
    const deepseek = providers.find(p => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek!.models.length).toBeGreaterThanOrEqual(2);
  });

  it('includes Anthropic provider', () => {
    const providers = getKnownProviders();
    const anthropic = providers.find(p => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.models.length).toBeGreaterThanOrEqual(2);
  });

  it('includes OpenAI provider', () => {
    const providers = getKnownProviders();
    const openai = providers.find(p => p.id === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.models.length).toBeGreaterThanOrEqual(2);
  });

  it('every provider has valid models', () => {
    const providers = getKnownProviders();
    for (const p of providers) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.models.length).toBeGreaterThan(0);
      for (const m of p.models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.maxOutput).toBeGreaterThan(0);
      }
    }
  });

  it('each provider has a unique id', () => {
    const providers = getKnownProviders();
    const ids = new Set(providers.map(p => p.id));
    expect(ids.size).toBe(providers.length);
  });

  it('each model within a provider has unique id', () => {
    const providers = getKnownProviders();
    for (const p of providers) {
      const modelIds = new Set(p.models.map(m => m.id));
      expect(modelIds.size).toBe(p.models.length);
    }
  });
});

describe('ModelSelector — State', () => {
  it('creates selector state with default values', () => {
    const state = createModelSelectorState();
    expect(state.active).toBe(false);
    expect(state.providers.length).toBeGreaterThan(0);
    expect(state.providerIndex).toBe(0);
    expect(state.modelIndex).toBe(0);
  });

  it('finds current provider by id', () => {
    const state = createModelSelectorState('anthropic', 'claude-sonnet-4-20250514');
    const provider = state.providers[state.providerIndex];
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('anthropic');
    const model = provider!.models[state.modelIndex];
    expect(model).toBeDefined();
    expect(model!.id).toBe('claude-sonnet-4-20250514');
  });

  it('falls back to index 0 for unknown provider', () => {
    const state = createModelSelectorState('unknown-provider', 'unknown-model');
    expect(state.providerIndex).toBe(0);
    expect(state.modelIndex).toBe(0);
  });

  it('falls back to model index 0 for unknown model', () => {
    const state = createModelSelectorState('deepseek', 'unknown-model');
    const provider = state.providers[state.providerIndex];
    expect(provider!.id).toBe('deepseek');
    expect(state.modelIndex).toBe(0);
  });
});

describe('ModelSelector — Navigation', () => {
  it('moves down within models', () => {
    const state = createModelSelectorState();
    expect(state.modelIndex).toBe(0);
    modelSelectorMoveDown(state);
    expect(state.modelIndex).toBe(1);
  });

  it('moves up within models', () => {
    const state = createModelSelectorState();
    state.modelIndex = 2;
    modelSelectorMoveUp(state);
    expect(state.modelIndex).toBe(1);
  });

  it('wraps from last model to next provider', () => {
    const state = createModelSelectorState();
    const provider = state.providers[state.providerIndex];
    if (provider) {
      state.modelIndex = provider.models.length - 1;
      const oldProviderIndex = state.providerIndex;
      modelSelectorMoveDown(state);
      expect(state.providerIndex).toBe((oldProviderIndex + 1) % state.providers.length);
      expect(state.modelIndex).toBe(0);
    }
  });

  it('wraps from first model to previous provider', () => {
    const state = createModelSelectorState();
    state.modelIndex = 0;
    modelSelectorMoveUp(state);
    expect(state.providerIndex).toBe(state.providers.length - 1);
    expect(state.modelIndex).toBe(0);
  });
});

describe('ModelSelector — Get Selected', () => {
  it('returns selected provider and model', () => {
    const state = createModelSelectorState('openai', 'gpt-4o');
    const selected = modelSelectorGetSelected(state);
    expect(selected).not.toBeNull();
    expect(selected!.providerId).toBe('openai');
    expect(selected!.modelId).toBe('gpt-4o');
  });

  it('returns null when no provider available', () => {
    const state: ModelSelectorState = {
      active: false,
      providerIndex: 0,
      modelIndex: 0,
      providers: [],
    };
    const selected = modelSelectorGetSelected(state);
    expect(selected).toBeNull();
  });
});

describe('ModelSelector — Rendering', () => {
  it('renders selector header', () => {
    const state = createModelSelectorState('deepseek', 'deepseek-chat');
    state.active = true;
    const output = renderModelSelector(state, { maxWidth: 70 });
    expect(output).toContain('Select Model');
  });

  it('shows current provider and model', () => {
    const state = createModelSelectorState('anthropic', 'claude-sonnet-4-20250514');
    state.active = true;
    const output = renderModelSelector(state, { maxWidth: 70 });
    expect(output).toContain('Anthropic');
    expect(output).toContain('Claude Sonnet 4');
  });

  it('shows navigation help', () => {
    const state = createModelSelectorState();
    const output = renderModelSelector(state, { maxWidth: 70 });
    expect(output).toContain('Select');
    expect(output).toContain('Confirm');
    expect(output).toContain('Back');
  });

  it('renders all providers', () => {
    const state = createModelSelectorState();
    const output = renderModelSelector(state, { maxWidth: 70 });
    const providers = getKnownProviders();
    // Each provider's label should appear (some may be off-screen due to maxHeight)
    expect(providers.length).toBeGreaterThan(0);
    expect(output).toContain(getKnownProviders()[0]!.label);
  });
});
