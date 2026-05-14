// Mock LLM Client for testing
// Provides preset responses, error injection, and streaming simulation

import type { LLMRequestConfig, LLMResponse, LLMStreamEvent, TokenUsage } from '../../src/api/BaseApiClient';
import type { ToolCall } from '../../src/types/message';

let _mockIdCounter = 0;
function nextMockId(): string {
  return `call_${++_mockIdCounter}`;
}

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
};

export interface MockResponse {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: Partial<TokenUsage>;
  error?: Error;
  delayMs?: number;
}

/**
 * MockLLMClient - a lightweight mock that satisfies the BaseApiClient interface
 * without extending the abstract class (avoids needing to implement protected methods).
 * Cast to BaseApiClient where needed in tests.
 */
export class MockLLMClient {
  apiKey = 'mock-key';
  baseUrl = 'http://localhost:11434';
  model = 'mock-model';

  private responses: MockResponse[] = [];
  private responseIndex = 0;
  private errorScenarios: Map<string, Error> = new Map();
  private callLog: LLMRequestConfig[] = [];

  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  addErrorScenario(scenario: string, error: Error): void {
    this.errorScenarios.set(scenario, error);
  }

  getCallLog(): LLMRequestConfig[] {
    return [...this.callLog];
  }

  reset(): void {
    this.responses = [];
    this.responseIndex = 0;
    this.errorScenarios.clear();
    this.callLog = [];
  }

  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    this.callLog.push(config);

    const errorScenario = this.errorScenarios.get('chat');
    if (errorScenario) throw errorScenario;

    const response = this.getNextResponse();

    if (response.error) throw response.error;

    if (response.delayMs) {
      await new Promise(resolve => setTimeout(resolve, response.delayMs));
    }

    return {
      content: response.content ?? '',
      toolCalls: response.toolCalls,
      usage: { ...DEFAULT_USAGE, ...response.usage },
    };
  }

  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    this.callLog.push(config);

    const errorScenario = this.errorScenarios.get('stream');
    if (errorScenario) {
      yield { type: 'error', error: errorScenario };
      return;
    }

    const response = this.getNextResponse();

    if (response.error) {
      yield { type: 'error', error: response.error };
      return;
    }

    const text = response.content ?? '';
    const chunkSize = 10;
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: 'text_delta', text: text.slice(i, i + chunkSize) };
    }

    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield { type: 'tool_use', toolCall };
      }
    }

    yield {
      type: 'stop',
      usage: { ...DEFAULT_USAGE, ...response.usage },
    };
  }

  validateApiKey(): boolean {
    return this.apiKey !== '';
  }

  getModelInfo() {
    return {
      provider: 'mock',
      model: this.model,
      maxTokens: 4096,
      supportsStreaming: true,
      supportsTools: true,
    };
  }

  private getNextResponse(): MockResponse {
    if (this.responses.length === 0) {
      return { content: '' };
    }

    const response = this.responses[this.responseIndex];
    if (this.responseIndex < this.responses.length - 1) {
      this.responseIndex++;
    }
    return response;
  }
}

// Factory helpers

export function withTextResponse(text: string, usage?: Partial<TokenUsage>): MockLLMClient {
  const client = new MockLLMClient();
  client.setResponses([{ content: text, usage }]);
  return client;
}

export function withToolCallResponse(toolCalls: ToolCall[], text = ''): MockLLMClient {
  const client = new MockLLMClient();
  client.setResponses([{ content: text, toolCalls }]);
  return client;
}

export function withMultiTurnResponse(responses: MockResponse[]): MockLLMClient {
  const client = new MockLLMClient();
  client.setResponses(responses);
  return client;
}

export function withChatError(error: Error): MockLLMClient {
  const client = new MockLLMClient();
  client.addErrorScenario('chat', error);
  return client;
}

export function withStreamError(error: Error): MockLLMClient {
  const client = new MockLLMClient();
  client.addErrorScenario('stream', error);
  return client;
}

export function withToolUseConversation(
  toolName: string,
  toolArgs: Record<string, unknown>,
  finalAnswer: string,
): MockLLMClient {
  return withMultiTurnResponse([
    {
      content: '',
      toolCalls: [{
        id: nextMockId(),
        toolName,
        input: toolArgs,
        status: 'completed',
      }],
    },
    { content: finalAnswer },
  ]);
}
