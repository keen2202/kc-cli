// Tests for QueryEngine → MemoryIntegration wiring of the hybrid LLM
// extraction tier (memory-llm-extraction-hardening follow-up).
//
// The QueryEngine constructor default-injects its own API client and budget
// enforcer into MemoryIntegration so the LLM extraction tier can actually
// fire when `llmExtraction.enabled` is on. These tests pin that behaviour:
//   1. default injection — enabled tier fires through the engine's API client
//      via the isolated path (no tools, temperature 0, own abort signal)
//   2. explicit llmClient in config.memory wins over the default injection
//   3. default config (tier disabled) → zero LLM calls
//   4. the injected budget enforcer is SHARED — a tiny session budget gates
//      the extraction tier (GR6)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () {}),
    chat: mockChat,
  })),
  BaseApiClient: class {},
  ApiError: class ApiError extends Error {},
}));

// The QueryEngine constructor builds a ToolExecutor, which instantiates a
// SandboxManager. Mock the sandbox layer so tests never require a real backend.
vi.mock('../../src/services/sandbox', () => {
  class MockSandboxManager {
    isAvailable = vi.fn(() => false);
    wrapCommand = vi.fn((cmd: string) => cmd);
    getBackendName = vi.fn(() => 'noop');
    shouldSandboxTool = vi.fn(() => 'run-unsandboxed');
  }
  return { SandboxManager: MockSandboxManager };
});

import type { LLMProvider } from '../../src/api';
import { initializeState } from '../../src/bootstrap/state';
import { QueryEngine } from '../../src/query/QueryEngine';
import { resetExtractionState } from '../../src/services/memoryExtraction';
import { resetTelemetry } from '../../src/memory/telemetry';
import type { ChatMessage } from '../../src/query/protocol';

const LLM_OUTPUT = [
  '---',
  'name: Keep Config Simple',
  'description: User asked to keep the config simple and documented',
  'type: feedback',
  '---',
  'The user corrected the approach: keep the configuration simple and documented.',
].join('\n');

function feedbackMessage(): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content: 'remember to always keep the config simple and documented',
    timestamp: 1000,
  };
}

function createEngine(memory?: unknown, maxBudgetUsd: number | null = null) {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'openai' as LLMProvider,
      apiKey: 'test-key',
      apiBaseUrl: 'http://localhost:1234',
      maxTurns: 10,
      maxBudgetUsd,
      planningPhase: { enabled: false },
      patchGuarantee: { enabled: false },
      memory,
    } as any,
    [],
  );
}

beforeEach(() => {
  initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
  vi.clearAllMocks();
  resetExtractionState();
  resetTelemetry();
  mockChat.mockResolvedValue({
    content: LLM_OUTPUT,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
});

describe('QueryEngine memory-tier wiring', () => {
  it('default-injects the engine API client so the enabled tier fires via the isolated path', async () => {
    const engine = createEngine({ config: { llmExtraction: { enabled: true } } });

    await engine.getMemoryIntegration().extractMemoriesFromConversation([feedbackMessage()]);

    expect(mockChat).toHaveBeenCalledTimes(1);
    // Isolated extraction call semantics (GR5): direct chat, no tools,
    // deterministic temperature, own abort signal, extraction system prompt.
    const request = mockChat.mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(request.temperature).toBe(0);
    expect(request.abortSignal).toBeDefined();
    expect(request.systemPrompt).toContain('memory extraction assistant');
  });

  it('an explicit llmClient in config.memory wins over the default injection', async () => {
    const explicitClient = {
      chat: vi.fn().mockResolvedValue({
        content: LLM_OUTPUT,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    };
    const engine = createEngine({
      config: { llmExtraction: { enabled: true } },
      llmClient: explicitClient,
    });

    await engine.getMemoryIntegration().extractMemoriesFromConversation([feedbackMessage()]);

    expect(explicitClient.chat).toHaveBeenCalledTimes(1);
    // The engine's own API client was bypassed.
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('default config (tier disabled) never touches the API client', async () => {
    const engine = createEngine();

    await engine.getMemoryIntegration().extractMemoriesFromConversation([feedbackMessage()]);

    expect(mockChat).not.toHaveBeenCalled();
  });

  it('the injected budget enforcer is shared: a tiny session budget gates the tier (GR6)', async () => {
    // costLimitUsd = $0.0001; one extraction estimate (~$0.0047) already
    // exceeds it, so the shared enforcer must skip the LLM tier.
    const engine = createEngine({ config: { llmExtraction: { enabled: true } } }, 0.0001);

    await engine.getMemoryIntegration().extractMemoriesFromConversation([feedbackMessage()]);

    expect(mockChat).not.toHaveBeenCalled();
  });
});
