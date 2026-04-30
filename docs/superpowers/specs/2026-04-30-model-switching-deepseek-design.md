# Model Switching + DeepSeek Support

## Summary

Add DeepSeek provider support and a generic `openai-compatible` provider type, with built-in model resolution that auto-selects the provider's default when switching providers.

## Problem

When pointing `KC_API_BASE_URL` to a DeepSeek endpoint, the model name `claude-sonnet-4-20250514` (Anthropic default) is sent to DeepSeek, which rejects it:

```
Error: OpenAI Compatible API error: HTTP 400:
{"error":{"message":"The supported API model names are deepseek-v4-pro
or deepseek-v4-flash, but you passed claude-sonnet-4-20250514."}}
```

Root cause: no `deepseek` provider, and no model-name resolution when switching providers.

## Design

### Provider Type Expansion

Add `deepseek` and `openai-compatible` to `LLMProvider`:

```
openai | qwen | glm | deepseek | openai-compatible | anthropic | ollama
```

Both new providers use the standard `/v1/chat/completions` endpoint via `OpenAICompatibleClient`.

### Provider Model Registry

Each provider declares its own models and a default:

| Provider | Default | Supported Models |
|----------|---------|-----------------|
| anthropic | claude-sonnet-4-20250514 | claude-sonnet-4-20250514, claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, claude-3-opus-20240229 |
| openai | gpt-4o | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo |
| deepseek | deepseek-v4-pro | deepseek-v4-pro, deepseek-v4-flash |
| qwen | qwen-plus | qwen-turbo, qwen-plus, qwen-max, qwen-long |
| glm | glm-4-plus | glm-4, glm-4-plus, glm-4-flash, glm-4-air |
| openai-compatible | (user-specified) | (open-ended) |
| ollama | llama3 | (open-ended) |

### Model Resolution

```
resolveModel(provider, requestedModel):
  1. If provider has no supported list → accept as-is (ollama, openai-compatible)
  2. If model is in provider's supported list → use as-is
  3. Otherwise → warn + use provider default
```

No cross-provider mappings. Switching provider auto-picks that provider's default.

### Files Changed

| File | Change |
|------|--------|
| `src/api/index.ts` | Add providers to type, factory cases, `PROVIDER_MODELS` constant, `resolveModel()` |
| `src/bootstrap/config.ts` | Add `deepseek`/`openai-compatible` to config schema enum |
| `src/api/OpenAICompatibleClient.ts` | Add DeepSeek models to `getModelInfo()` |

### Error Handling

The existing `handleApiError()` in `OpenAICompatibleClient` already catches `model_not_found`/`invalid_model`. With model resolution these become rare, but error messages remain informative.

### Usage

```bash
# DeepSeek via env
export KC_PROVIDER=deepseek
export KC_API_KEY=sk-xxx
export KC_API_BASE_URL=https://api.deepseek.com

# Generic OpenAI-compatible
export KC_PROVIDER=openai-compatible
export KC_API_KEY=sk-xxx
export KC_API_BASE_URL=https://your-custom-api.com
export KC_MODEL=your-model-name
```
