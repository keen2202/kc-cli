// Tests for QueryEngine.setModel — runtime model switching rebuilds the API
// client under the current provider/key/baseUrl and returns the applied model.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () {}),
    chat: vi.fn(async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })),
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

import { createAPIClient } from '../../src/api';
import type { LLMProvider } from '../../src/api';
import { initializeState } from '../../src/bootstrap/state';
import { QueryEngine } from '../../src/query/QueryEngine';

function createEngine() {
  return new QueryEngine(
    {
      model: 'model-a',
      provider: 'openai' as LLMProvider,
      apiKey: 'test-key',
      apiBaseUrl: 'http://localhost:1234',
      maxTurns: 10,
      maxBudgetUsd: null,
      planningPhase: { enabled: false },
      patchGuarantee: { enabled: false },
    } as any,
    [],
  );
}

describe('QueryEngine.setModel', () => {
  beforeEach(() => {
    initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
    vi.clearAllMocks();
  });

  it('returns the applied model and rebuilds the client under the current provider/key/baseUrl', () => {
    const engine = createEngine();
    (createAPIClient as ReturnType<typeof vi.fn>).mockClear();

    const applied = engine.setModel('model-b');

    expect(applied).toBe('model-b');
    expect(createAPIClient).toHaveBeenCalledTimes(1);
    expect(createAPIClient).toHaveBeenCalledWith({
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1234',
      model: 'model-b',
    });
  });

  it('reflects the new model in the config used for the next rebuild', () => {
    const engine = createEngine();
    engine.setModel('model-b');
    (createAPIClient as ReturnType<typeof vi.fn>).mockClear();

    // A subsequent key update should carry the model set by setModel.
    engine.setApiKey('sk-newkey');
    expect(createAPIClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-b', apiKey: 'sk-newkey' }),
    );
  });
});
