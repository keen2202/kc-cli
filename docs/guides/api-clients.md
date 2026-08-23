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

Add one row to `PROVIDER_SPECS` in `src/api/provider-specs.ts`:

```typescript
'myprovider': {
  baseUrl: 'https://api.myprovider.com',
  displayName: 'MyProvider',
  keyPattern: { kind: 'prefix', prefixes: ['sk-'] },
},
```

The factory (`src/api/index.ts`) reads the base URL from this table; its
`switch` only picks the client **class** (Anthropic / OpenAI-compatible /
Ollama), so no factory edit is needed unless you wrote a brand-new class.

### 3. Config schema — nothing to do

The provider `z.enum` in `src/bootstrap/config.ts`, the API-key format checks
in `src/utils/api-key.ts`, and the id union type are all **derived** from
`PROVIDER_SPECS`. Adding the row above is the whole registration.

## Adding a Provider Touches Exactly One Place

Since audit round3 T17, every per-provider identity datum lives in a single
table — [`PROVIDER_SPECS`](../../src/api/provider-specs.ts) — and everything
else derives from it:

| Consumer | What it derives | How |
|---|---|---|
| `ProviderId` / `LLMProvider` type | the id union | `keyof typeof PROVIDER_SPECS` |
| `bootstrap/config.ts` | accepted `provider` values | `z.enum(PROVIDER_IDS)` |
| `utils/api-key.ts` | API-key format validation | `spec.keyPattern` (`prefix` / `minLength` / `none`) |
| `api/index.ts` factory | default base URL | `PROVIDER_SPECS[provider].baseUrl` |
| display-name lookups | human-readable name | `spec.displayName` |

So the minimal new-provider diff is **one table row** (plus a client class
only if the wire protocol is genuinely new):

```diff
--- a/src/api/provider-specs.ts
+++ b/src/api/provider-specs.ts
@@
 export const PROVIDER_SPECS = {
+  'myprovider': {
+    baseUrl: 'https://api.myprovider.com',
+    displayName: 'MyProvider',
+    keyPattern: { kind: 'prefix', prefixes: ['sk-mp-'], messageLabel: 'MyProvider' },
+  },
   'anthropic': { ... },
```

That single row makes `'myprovider'` a valid `KC_PROVIDER`, config-file value,
and `LLMProvider`; enables `/key` format checking against `sk-mp-…`; routes
requests to `https://api.myprovider.com`; and needs **zero** edits in
`config.ts`, `api-key.ts`, or `index.ts`.

Two scope notes:

- **Models & capacity numbers** (context window, caching strategy, defaults)
  are not identity data — they stay single-sourced in
  [`capabilities.ts`](../../src/api/capabilities.ts) (`PROVIDER_MODELS`,
  `PROVIDER_CAPABILITIES`, guarded by `capabilities-consistency.test.ts`).
  Add rows there only if your provider needs non-default capabilities;
  unlisted providers fall back to sensible defaults (including cache
  strategy `'none'`, which is why `buildCacheStrategy` has no provider
  switch anymore).
- Keep row order stable: `PROVIDER_IDS` preserves it, and it feeds config
  validation error messages.

## Prompt Caching (Anthropic)

The AnthropicClient adds `cache_control: { type: "ephemeral" }` to:
- System prompt content block
- Last tool definition

This enables the Anthropic API to cache static content across requests.
