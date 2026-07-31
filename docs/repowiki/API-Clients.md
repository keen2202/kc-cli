# API Clients

11 LLM providers with a unified streaming interface and provider-specific adaptations.

## Provider Matrix

| Provider | Client Class | Default Base URL | Streaming |
|----------|-------------|------------------|-----------|
| anthropic | AnthropicClient | api.anthropic.com | SSE |
| openai | OpenAICompatibleClient | api.openai.com | SSE |
| deepseek | OpenAICompatibleClient | api.deepseek.com | SSE |
| qwen | OpenAICompatibleClient | dashscope.aliyuncs.com | SSE |
| glm | OpenAICompatibleClient | open.bigmodel.cn | SSE |
| mimo | OpenAICompatibleClient | api.xiaomimimo.com | SSE |
| kimi | OpenAICompatibleClient | api.moonshot.cn | SSE |
| step | OpenAICompatibleClient | api.stepfun.com | SSE |
| gemini | OpenAICompatibleClient | generativelanguage.googleapis.com | SSE |
| openai-compatible | OpenAICompatibleClient | (user-specified) | SSE |
| ollama | OllamaClient | localhost:11434 | JSON stream |

## Class Hierarchy

```
BaseApiClient (abstract)
 ├── AnthropicClient         -- Anthropic SSE with stateful content block parser
 ├── OpenAICompatibleClient  -- OpenAI-compatible API (covers 8 providers)
 └── OllamaClient            -- Local Ollama JSON streaming
```

## BaseApiClient

`src/api/BaseApiClient.ts` -- Abstract base providing:

### Core Methods
- `chat(messages, config)` -- Single LLM call, returns `LLMResponse`
- `streamChat(messages, config)` -- Streaming call, returns `AsyncGenerator<LLMStreamEvent>`
- `buildRequestBody(messages, tools, config)` -- Provider-specific request formatting
- `formatMessages(messages)` -- Message format conversion
- `formatTools(tools)` -- Zod schema → JSON Schema conversion
- `handleApiError(error)` -- Error classification and wrapping

### LLMStreamEvent Types

```typescript
type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage_update'; tokens: TokenUsage }
  | { type: 'cache_status'; hit: boolean; tokens: number }
  | { type: 'error'; error: ApiError }
  | { type: 'stream_start'; model: string }
  | { type: 'stream_end' }
  | { type: 'done' }
```

## AnthropicClient

Specialized for Anthropic's SSE streaming format:
- Stateful content block parser (handles partial JSON in tool_use blocks)
- `<thinking>` tag extraction from responses
- Prompt cache status detection (`cache_creation_input_tokens`, `cache_read_input_tokens`)
- Extended thinking support via `thinking` parameter

## OpenAICompatibleClient

Covers 8 providers through a single implementation:
- Provider detection via base URL or explicit config
- Provider-specific header injection (e.g., DashScope `X-DashScope-SSE`)
- `parallel_tool_calls` support for OpenAI
- Response format normalization across providers

## OllamaClient

Local model support:
- JSON streaming (newline-delimited JSON, not SSE)
- Auto model pulling if model not found
- Simplified tool format (no JSON Schema conversion needed)

## Prompt System

`src/api/prompts/`:

### prompt-builder.ts
Builds the system prompt from:
- Static instructions (tool usage rules, safety guidelines)
- Provider-specific adaptations
- Task-specific templates
- Memory context (injected by MemoryHandler)
- Behavioral adaptations (from BehavioralAdapter)

### provider-prompts.ts
Provider-specific prompt templates:
- **Anthropic**: `<thinking>` tags, XML-structured instructions
- **OpenAI**: `parallel_tool_calls` hints, function calling format
- **Qwen/GLM**: Chinese-optimized prompts when applicable
- **Others**: Generic OpenAI-compatible format

### task-prompts.ts
Task-specific templates for:
- Code generation
- Debugging
- Refactoring
- Documentation
- General conversation

## Error Handling

`src/api/protocol.ts` -- `ApiError`:
```typescript
interface ApiError {
  message: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  provider?: string;
  retryable: boolean;
}
```

`KCError.fromApiError()` classifies errors into 20 stable codes:
- `api_rate_limit` -- 429 responses, checks `retry-after` header
- `api_auth_error` -- 401/403 responses
- `api_server_error` -- 5xx responses
- `api_timeout` -- Request timeout
- `api_context_overflow` -- Context window exceeded
- `tool_timeout` -- Tool execution timeout
- `budget_exceeded` -- Token/cost limit hit
