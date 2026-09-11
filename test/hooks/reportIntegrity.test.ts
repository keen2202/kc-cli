import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearHooks,
  executePostTurnHooksSync,
  getHookCount,
  registerReportIntegrityHook,
} from '../../src/hooks/postTurnHooks';
import type { PostTurnHookContext } from '../../src/hooks/postTurnHooks';
import type { ChatMessage } from '../../src/query/protocol';

beforeEach(() => {
  clearHooks();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearHooks();
});

function context(messages: ChatMessage[]): PostTurnHookContext {
  return {
    messages,
    systemPrompt: '',
    state: {} as never,
    querySource: 'test',
  };
}

function assistant(content: string): ChatMessage {
  return { id: 'a1', role: 'assistant', content, timestamp: 1 };
}

function toolMessage(output: string): ChatMessage {
  return {
    id: 't1',
    role: 'tool',
    content: null,
    timestamp: 2,
    toolResults: [{ toolCallId: 'c1', output, isError: false }],
  } as unknown as ChatMessage;
}

describe('main-agent report-integrity hook', () => {
  it('registers exactly one hook and deduplicates repeated registration', () => {
    registerReportIntegrityHook();
    registerReportIntegrityHook();
    expect(getHookCount()).toBe(1);
  });

  it('flags an unsubstantiated numeric claim on the final assistant message', async () => {
    registerReportIntegrityHook();
    const last = assistant('本次共完成 23 个用例的验证。');
    await executePostTurnHooksSync(context([last]));

    const metadata = (last as unknown as { metadata?: { reportFindings?: Array<{ code: string }> } }).metadata;
    expect(metadata?.reportFindings?.some((f) => f.code === 'numeric_claim_unsubstantiated')).toBe(true);
  });

  it('accepts a numeric claim corroborated by preceding tool output', async () => {
    registerReportIntegrityHook();
    const last = assistant('本次共完成 23 个用例的验证。');
    await executePostTurnHooksSync(context([last, toolMessage('Tests 23 passed')]));

    const metadata = (last as unknown as { metadata?: { reportFindings?: unknown[] } }).metadata;
    expect(metadata?.reportFindings).toBeUndefined();
  });

  it('flags a "see the beginning" checkpoint deflection', async () => {
    registerReportIntegrityHook();
    const last = assistant('检查站作答见消息开头。');
    await executePostTurnHooksSync(context([last]));

    const metadata = (last as unknown as { metadata?: { reportFindings?: Array<{ code: string }> } }).metadata;
    expect(metadata?.reportFindings?.some((f) => f.code === 'checkpoint_deflection')).toBe(true);
  });
});
