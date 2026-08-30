// T27 (M2): one summary prompt implementation for both compaction engines — round4 §6-M2
//
// Before this refactor the two engines carried duplicated prompt builders and
// had drifted (only the functional engine appended the modified-files block).
// Here both engines are driven end-to-end with a capturing fake API client and
// their prompts are compared — this test failed BEFORE the extraction.

import { describe, it, expect, vi } from 'vitest';
import type { BaseApiClient } from '../../../src/api/BaseApiClient';
import type { ChatMessage } from '../../../src/query/protocol';
import { buildSummaryPrompt, buildFallbackSummary } from '../../../src/services/compaction/prompts';
import { fullCompact } from '../../../src/services/compaction/functional';
import { FullCompactionEngine } from '../../../src/services/compaction/full';

function makeMessages(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < 14; i++) {
    out.push({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', content: `hello ${i}`, timestamp: i });
  }
  return out;
}

interface ChatCapture {
  prompt: string;
}

function makeCapturingClient(capture: ChatCapture, reply: string): BaseApiClient {
  const client = {
    chat: vi.fn(async (config: { messages: Array<{ content?: string }> }) => {
      capture.prompt = config.messages[0]?.content ?? '';
      return { content: reply, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }),
  };
  return client as unknown as BaseApiClient;
}

describe('T27: unified compaction prompt builders', () => {
  it('functional and full engines send the IDENTICAL summary prompt for the same input', async () => {
    const messages = makeMessages();
    const systemPrompt = 'sys-prompt-for-test';

    const functionalCapture: ChatCapture = { prompt: '' };
    await fullCompact(
      messages,
      makeCapturingClient(functionalCapture, 'summary from functional'),
      { model: 'm', contextWindow: 100_000 },
      systemPrompt,
    );

    const fullCapture: ChatCapture = { prompt: '' };
    const engine = new FullCompactionEngine(
      makeCapturingClient(fullCapture, 'summary from full'),
      'm',
      systemPrompt,
    );
    await engine.compact(messages, {
      tokenBudget: 100_000,
      currentTokens: 100_000,
      systemPromptTokens: 0,
    });

    expect(fullCapture.prompt).toBe(functionalCapture.prompt);
    expect(fullCapture.prompt).toContain(systemPrompt);
    expect(fullCapture.prompt).toContain('Keep the summary under 500 words.');
  });

  it('includes the modified-files preservation block when provided (merged enhancement)', () => {
    const prompt = buildSummaryPrompt(makeMessages(), 'sys', ['src/a.ts', 'src/b.ts']);
    expect(prompt).toContain('IMPORTANT: The following files were modified during this session');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
  });

  it('omits the modified-files block when not provided (full engine behavior unchanged)', () => {
    const prompt = buildSummaryPrompt(makeMessages(), 'sys');
    expect(prompt).not.toContain('IMPORTANT: The following files were modified');
  });

  it('fallback summary has a stable shape (snapshot)', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'x'.repeat(120), timestamp: 1 },
      { id: '2', role: 'assistant', content: 'short reply', timestamp: 2 },
    ];
    expect(buildFallbackSummary(messages)).toBe(
      [
        '[Auto-generated summary - LLM unavailable]',
        `User: ${'x'.repeat(100)}...`,
        'Assistant: short reply',
      ].join('\n'),
    );
  });
});
