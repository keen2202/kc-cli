// test/query/conversation-version.test.ts
import { describe, it, expect } from 'vitest';
import { ConversationState } from '../../src/query/QueryEngineState';
import type { ChatMessage } from '../../src/query/protocol';
import { QueryEngine } from '../../src/query/QueryEngine';
import { MockLLMClient } from '../../test/utils/mock-llm';
import type { BaseApiClient } from '../../src/api/BaseApiClient';
import { initializeState } from '../../src/bootstrap/state';
import { estimateMessageTokensArray } from '../../src/utils/tokenEstimation';

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `${role}-${Math.random()}`, role, content, timestamp: Date.now() } as ChatMessage;
}

describe('ConversationState version counter', () => {
  it('bumps on addMessage', () => {
    const cs = new ConversationState();
    const v0 = cs.version;
    cs.addMessage(msg('user', 'hi'));
    expect(cs.version).toBe(v0 + 1);
  });

  it('bumps on setMessages', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'hi'));
    const v0 = cs.version;
    cs.setMessages([msg('user', 'compacted')]);
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('bumps on trim when messages exceed max', () => {
    const cs = new ConversationState({ maxMessages: 2 });
    cs.addMessage(msg('user', 'a'));
    cs.addMessage(msg('assistant', 'b'));
    cs.addMessage(msg('user', 'c'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('does not bump when trim removes nothing', () => {
    const cs = new ConversationState({ maxMessages: 10 });
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBe(v0);
  });

  it('bumps on branch, checkout, clear', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    const nodeId = cs.branch();
    expect(cs.version).toBeGreaterThan(v0);
    cs.addMessage(msg('assistant', 'on branch'));
    const v1 = cs.version;
    cs.checkout(nodeId);
    expect(cs.version).toBeGreaterThan(v1);
    const v2 = cs.version;
    cs.clear();
    expect(cs.version).toBeGreaterThan(v2);
  });
});

describe('api-messages version cache', () => {
  it('rebuilds only when the conversation version changes', async () => {
    initializeState();
    const mock = new MockLLMClient();
    mock.setResponses([{ content: 'one' }, { content: 'two' }]);
    const engine = new QueryEngine(
      // sandboxFailIfNoSandbox: false — Windows dev boxes have no sandbox
      // backend; aligns with the bench scripts' KC_SANDBOX_FAIL_IF_NO_SANDBOX.
      { model: 'm', provider: 'anthropic', apiKey: 'k', maxTurns: 5, maxBudgetUsd: null, sandboxFailIfNoSandbox: false },
      [],
    );
    // QueryEngineDeps has no apiClient slot — the constructor always builds a
    // real client. Existing tests swap the field post-construction instead
    // (see test/query/QueryEngineStreaming.test.ts).
    (engine as unknown as { apiClient: unknown }).apiClient = mock;
    for await (const _e of engine.submitMessage('first')) { /* drain */ }
    const firstRequest = mock.getCallLog().at(-1)!;
    for await (const _e of engine.submitMessage('second')) { /* drain */ }
    const secondRequest = mock.getCallLog().at(-1)!;
    // Second request contains the first turn's messages — rebuilt after mutation.
    expect(secondRequest.messages.length).toBeGreaterThan(firstRequest.messages.length);
  });
});

// Property-style equivalence: incremental trim accounting must match a full
// recompute for arbitrary message mixes. (fast-check is not a project
// dependency; a seeded PRNG loop covers the same input space.)
describe('trimIfNeeded incremental token accounting', () => {
  it('incremental estimate equals full recompute across random transcripts', () => {
    // mulberry32 — deterministic PRNG
    let rngState = 42;
    const rand = () => {
      rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
      let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let iter = 0; iter < 50; iter++) {
      const cs = new ConversationState({ maxMessages: 10 });
      const n = 10 + Math.floor(rand() * 21); // 10..30 messages
      for (let i = 0; i < n; i++) {
        cs.addMessage({
          id: `m-${iter}-${i}`,
          role: i === 0 ? 'system' : i % 2 === 0 ? 'user' : 'assistant',
          content: `msg ${i} ${'x'.repeat(Math.floor(rand() * 40))}`,
          timestamp: 0,
        } as ChatMessage);
      }
      cs.trimIfNeeded();
      const after = estimateMessageTokensArray(cs.getMessages());
      expect(cs.getTokenEstimate(), `iteration ${iter}`).toBe(after);
    }
  });
});
