// T33 (M8): one error-rule table for all providers + shared readonly allow — round4 §6-M8

import { describe, it, expect } from 'vitest';
import { BaseApiClient } from '../../src/api/BaseApiClient';
import type { LLMResponse, LLMStreamEvent } from '../../src/api/BaseApiClient';
import { ApiError } from '../../src/api/protocol';
import { readonlyAllow, toolFailure } from '../../src/Tool';
import type { ToolDefinition } from '../../src/tools/protocol';
import { buildTool } from '../../src/Tool';

class TestClient extends BaseApiClient {
  async chat(): Promise<LLMResponse> {
    throw new Error('not used');
  }
  async *streamChat(): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'stop' } as LLMStreamEvent;
  }
  validateApiKey(): boolean {
    return true;
  }
  getModelInfo() {
    return { provider: 'test', model: this.model, maxTokens: 4096, supportsStreaming: true, supportsTools: true };
  }
  public classify(error: unknown, context = 'ctx'): never {
    return this.handleApiError(error, context);
  }
}

class AnthropicishClient extends TestClient {
  protected errorRules(): Array<{ match: RegExp | string[]; status?: number; message: string }> {
    return [
      { match: /overloaded_error/, status: 529, message: 'Anthropic API is currently overloaded, please try again' },
      ...super.errorRules(),
    ];
  }
}

function expectApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a throw');
}

describe('T33: shared provider error rules', () => {
  const client = new TestClient({ apiKey: 'k', baseUrl: 'https://x', model: 'm1' });

  it('classifies 429 via both `rate limit` and `rate_limit` spellings', () => {
    expect(expectApiError(() => client.classify(new Error('HTTP 429: rate limit exceeded'))).statusCode).toBe(429);
    expect(expectApiError(() => client.classify(new Error('HTTP 429: rate_limit exceeded'))).statusCode).toBe(429);
  });

  it('classifies 401 (key/Unauthorized), 403 (Forbidden), 404 (model) uniformly', () => {
    expect(expectApiError(() => client.classify(new Error('invalid_api_key provided'))).statusCode).toBe(401);
    expect(expectApiError(() => client.classify(new Error('Unauthorized'))).statusCode).toBe(401);
    expect(expectApiError(() => client.classify(new Error('HTTP 403 Forbidden'))).statusCode).toBe(403);
    expect(expectApiError(() => client.classify(new Error('model_not_found: m1'))).statusCode).toBe(404);
  });

  it('keeps provider-specific rules ahead of the shared table', () => {
    const anthropic = new AnthropicishClient({ apiKey: 'k', baseUrl: 'https://x', model: 'm1' });
    const err = expectApiError(() => anthropic.classify(new Error('overloaded_error from upstream')));
    expect(err.statusCode).toBe(529);
    expect(err.message).toContain('overloaded');
  });

  it('falls back to the redacted generic wrap when no rule matches', () => {
    const err = expectApiError(() => client.classify(new Error('mystery sk-live-secret123 failure')));
    expect(err.statusCode).toBeUndefined();
    expect(err.message).toContain('[REDACTED]');
  });
});

describe('T33: shared readonly allow + toolFailure helpers', () => {
  it('readonlyAllow produces the unified allow shape (updatedInput: {} everywhere)', () => {
    const decision = readonlyAllow('File search is read-only');
    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'readonly', reason: 'File search is read-only' },
    });
  });

  it('a buildTool-defined readonly tool can return the shared decision', async () => {
    const tool = buildTool({
      name: 'FakeReadOnly',
      description: 'd',
      inputSchema: {},
      isReadOnly: () => true,
      checkPermissions: () => readonlyAllow('read-only by design'),
      call: async () => ({ toolCallId: 'x', output: 'ok', isError: false }),
    } as unknown as ToolDefinition);
    const decision = await (tool as unknown as {
      checkPermissions: (input: unknown, ctx: unknown) => Promise<{ behavior: string }>;
    }).checkPermissions({}, {});
    expect(decision.behavior).toBe('allow');
  });

  it('toolFailure renders error-like plain objects (object-message contract)', () => {
    expect(toolFailure('X', { message: 'boom' }).message).toBe('X failed: boom');
  });
});
