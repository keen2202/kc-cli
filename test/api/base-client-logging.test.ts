// LLM request lifecycle logging — round4 §4-O1
//
// A failed request must leave a structured trace (statusCode / durationMs) and
// never leak secrets from upstream error bodies into logs or error messages.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BaseApiClient } from '../../src/api/BaseApiClient';
import type { LLMRequestConfig, LLMResponse, LLMStreamEvent } from '../../src/api/BaseApiClient';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';

class TestClient extends BaseApiClient {
  async chat(): Promise<LLMResponse> {
    return this.withChatErrorHandling(
      'chat',
      { url: `${this.baseUrl}/chat`, body: {} },
      (data) => data as unknown as LLMResponse,
    );
  }

  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    yield* this.withStreamErrorHandling('chat', { url: `${this.baseUrl}/chat`, body: {} }, async function* () {
      yield { type: 'stop' } as LLMStreamEvent;
      void config;
    });
  }

  validateApiKey(): boolean {
    return true;
  }

  getModelInfo() {
    return { provider: 'test', model: this.model, maxTokens: 4096, supportsStreaming: true, supportsTools: true };
  }
}

const SECRET_ECHO = 'HTTP 500: {"error":{"message":"Bad key sk-live-abcdef123456 rejected"}}';

function stubFetchOnce(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
}

describe('O1: LLM request lifecycle logging', () => {
  let spy: LoggerSpy;

  afterEach(() => {
    spy?.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs a structured error with statusCode and durationMs on a 500 (non-streaming)', async () => {
    spy = spyOnLogger('api', ['error']);
    stubFetchOnce(500, SECRET_ECHO);
    const client = new TestClient({ apiKey: 'k', baseUrl: 'https://api.test', model: 'm' });

    await expect(client.chat()).rejects.toThrow();

    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.message).toBe('llm request failed');
    expect(call.data).toMatchObject({
      op: 'chat',
      model: 'm',
      baseUrl: 'https://api.test',
      statusCode: 500,
    });
    expect(typeof call.data?.durationMs).toBe('number');
    expect(call.data?.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('redacts sk- keys echoed back in the upstream error body', async () => {
    spy = spyOnLogger('api', ['error']);
    stubFetchOnce(500, SECRET_ECHO);
    const client = new TestClient({ apiKey: 'k', baseUrl: 'https://api.test', model: 'm' });

    let thrown: unknown;
    await client.chat().catch((e: unknown) => {
      thrown = e;
    });

    const logged = spy.calls.map((c) => c.text).join(' ');
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain('sk-live-abcdef123456');
    expect(String(thrown)).not.toContain('sk-live-abcdef123456');
  });

  it('logs on the streaming error path too, still yielding the error event', async () => {
    spy = spyOnLogger('api', ['error']);
    stubFetchOnce(503, 'unavailable');
    const client = new TestClient({ apiKey: 'k', baseUrl: 'https://api.test', model: 'm' });

    const events: LLMStreamEvent[] = [];
    for await (const event of client.streamChat({ messages: [] })) {
      events.push(event);
    }

    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.data).toMatchObject({ op: 'chat', statusCode: 503 });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not log on success', async () => {
    spy = spyOnLogger('api', ['error', 'warn']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    );
    const client = new TestClient({ apiKey: 'k', baseUrl: 'https://api.test', model: 'm' });

    await client.chat();

    expect(spy.calls.length).toBe(0);
  });
});
