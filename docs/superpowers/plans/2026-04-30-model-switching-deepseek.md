# Model Switching + DeepSeek Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DeepSeek and generic OpenAI-compatible provider support with built-in model resolution that auto-selects the provider default when switching providers.

**Architecture:** Extend the existing `OpenAICompatibleClient` for both new providers (DeepSeek uses standard `/v1/chat/completions`). Add a `PROVIDER_MODELS` registry mapping each provider to its default model and supported model list. A `resolveModel()` function called inside `createAPIClient()` auto-corrects mismatched model names.

**Tech Stack:** TypeScript, existing codebase (no new dependencies)

---

### File Structure

| File | Responsibility |
|------|---------------|
| `src/api/index.ts` | Provider type, factory, model registry, model resolution |
| `src/bootstrap/config.ts` | Config schema validation (provider enum) |
| `src/api/OpenAICompatibleClient.ts` | DeepSeek model metadata in `getModelInfo()` |

`resolveModel()` lives in `src/api/index.ts` alongside the factory and model registry. It's called inside `createAPIClient()` so callers (`QueryEngine` constructor) don't need to change.

---

### Task 1: Expand LLMProvider type, add model registry, update factory

**Files:**
- Modify: `src/api/index.ts`

All changes in this task go into `src/api/index.ts`. They are grouped into one task because they are interdependent — the registry references `LLMProvider` and the factory references `resolveModel`.

- [ ] **Step 1: Expand LLMProvider type**

Find:
```typescript
export type LLMProvider = 'openai' | 'qwen' | 'glm' | 'anthropic' | 'ollama';
```

Replace with:
```typescript
export type LLMProvider = 'openai' | 'qwen' | 'glm' | 'deepseek' | 'openai-compatible' | 'anthropic' | 'ollama';
```

- [ ] **Step 2: Add ProviderModelInfo interface, PROVIDER_MODELS constant, and resolveModel function**

Insert after the type export and before `createAPIClient`:

```typescript
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
```

- [ ] **Step 3: Update factory cases — all use resolveModel and add deepseek/openai-compatible**

Replace the entire `createAPIClient` function body switch block. Find:
```typescript
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
```

Replace with:
```typescript
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
        provider: 'openai',
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
```

- [ ] **Step 4: Add default base URLs for new providers in getDefaultBaseUrl**

Insert after the `glm` case:
```typescript
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'openai-compatible':
      return '';
```

- [ ] **Step 5: Add API key validation for new providers in validateApiKeyFormat**

Insert after the `glm` case:
```typescript
    case 'deepseek':
      return apiKey.length > 0;
    case 'openai-compatible':
      return true;
```

- [ ] **Step 6: Add display names for new providers in getProviderDisplayName**

Insert cases:
```typescript
    case 'deepseek':
      return 'DeepSeek';
    case 'openai-compatible':
      return 'OpenAI Compatible';
```

- [ ] **Step 7: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS — all new type references satisfied.

---

### Task 2: Update config schema with new providers

**Files:**
- Modify: `src/bootstrap/config.ts`

- [ ] **Step 1: Add deepseek and openai-compatible to provider enum**

Find:
```typescript
provider: z.enum(['anthropic', 'openai', 'ollama', 'google']).default('anthropic'),
```

Replace with:
```typescript
provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible', 'qwen', 'glm']).default('anthropic'),
```

Note: This also adds `qwen` and `glm` which were supported in the API factory but missing from the config schema. Removes `google` which was listed but never implemented.

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS — all references consistent.

---

### Task 3: Add DeepSeek model metadata to OpenAICompatibleClient

**Files:**
- Modify: `src/api/OpenAICompatibleClient.ts`

- [ ] **Step 1: Add DeepSeek model entries to getModelInfo()**

In the `getModelInfo()` method, add to the `modelInfo` record:

```typescript
// DeepSeek models
'deepseek-v4-pro': { maxTokens: 131072 },
'deepseek-v4-flash': { maxTokens: 131072 },
```

The `provider` field in `OpenAICompatibleClient` is currently typed as `'openai' | 'qwen' | 'glm'`. DeepSeek uses the `'openai'` provider value internally since it uses the standard endpoint. The constructor already handles this via the factory.

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS.

---

### Task 4: Integration validation

- [ ] **Step 1: Verify all references to LLMProvider are exhaustive**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 2: Verify model resolution in createAPIClient**

Write a quick inline script to verify `resolveModel` behavior (no test framework needed — just import and check in Node):

```bash
node -e "
const { resolveModel } = require('./src/api/index.ts');
" 2>&1 || echo "Cannot run TS directly — reviewed code paths instead"
```

Alternative: manual verification of the logic:
- `resolveModel('deepseek', 'claude-sonnet-4-20250514')` → warns and returns `'deepseek-v4-pro'`
- `resolveModel('deepseek', 'deepseek-v4-pro')` → returns `'deepseek-v4-pro'` (no warning)
- `resolveModel('openai', 'gpt-4o')` → returns `'gpt-4o'` (no warning)
- `resolveModel('openai-compatible', 'any-model')` → returns `'any-model'` (open-ended)

- [ ] **Step 3: Verify config schema accepts new providers**

```bash
node -e "
const { z } = require('zod');
const s = z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible', 'qwen', 'glm']);
['deepseek', 'openai-compatible', 'qwen', 'glm', 'anthropic'].forEach(p => console.log(p, s.safeParse(p)));
"
```

Expected: Each provider passes validation.

- [ ] **Step 4: Final type check**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/index.ts src/api/OpenAICompatibleClient.ts src/bootstrap/config.ts
git commit -m "feat: add model switching, DeepSeek and generic OpenAI-compatible provider support"
```
