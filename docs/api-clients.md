# API Client Extension Guide

## Architecture

All LLM providers implement `BaseApiClient` (src/api/BaseApiClient.ts):

```typescript
abstract class BaseApiClient {
  abstract chat(config: LLMRequestConfig): Promise<LLMResponse>;
  abstract streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent>;
  abstract validateApiKey(): boolean;
  abstract getModelInfo(): ProviderInfo;
}
```

## Adding a New Provider

### 1. Create the client

```typescript
// src/api/MyProviderClient.ts

import { BaseApiClient } from './BaseApiClient';
import type { LLMRequestConfig, LLMResponse, LLMStreamEvent } from './BaseApiClient';

export class MyProviderClient extends BaseApiClient {
  constructor(config: { apiKey: string; baseUrl: string; model: string }) {
    super(config);
  }

  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    // Implement non-streaming request
  }

  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    // Implement streaming request
  }

  validateApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  getModelInfo() {
    return {
      provider: 'myprovider',
      model: this.model,
      maxTokens: 4096,
      supportsStreaming: true,
      supportsTools: true,
    };
  }
}
```

### 2. Register in factory

Add to `src/api/index.ts`:
```typescript
case 'myprovider':
  return new MyProviderClient({ apiKey, baseUrl, model });
```

### 3. Add to config schema

Add `'myprovider'` to the provider enum in `src/bootstrap/config.ts`.

## Prompt Caching (Anthropic)

The AnthropicClient adds `cache_control: { type: "ephemeral" }` to:
- System prompt content block
- Last tool definition

This enables the Anthropic API to cache static content across requests.
