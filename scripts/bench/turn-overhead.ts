// Per-turn overhead benchmark: measures buildApiMessages and full token
// re-estimation across transcript sizes 50/200/800.
// Run: npx tsx scripts/bench/turn-overhead.ts
import { randomUUID } from 'node:crypto';
import { ConversationState } from '../../src/query/QueryEngineState';
import { buildApiMessages } from '../../src/query/QueryEngineStreaming';
import { estimateMessageTokensArray } from '../../src/utils/tokenEstimation';
import type { ChatMessage } from '../../src/query/protocol';

function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 4 === 1) {
      // assistant with tool calls + following tool result — exercises pairing repair
      const callId = `call_${i}`;
      msgs.push({
        id: randomUUID(), role: 'assistant', timestamp: Date.now(),
        content: `step ${i}: ` + 'analysis of the code change '.repeat(8),
        toolCalls: [{ id: callId, toolName: 'FileRead', input: { path: `src/f${i}.ts` }, status: 'completed' }],
      } as ChatMessage);
      msgs.push({
        id: randomUUID(), role: 'tool', timestamp: Date.now(),
        content: `file content for step ${i} `.repeat(10),
        toolResults: [{ toolCallId: callId, output: `file content for step ${i} `.repeat(10) }],
      } as ChatMessage);
    } else {
      msgs.push({
        id: randomUUID(), role: i % 2 === 0 ? 'user' : 'assistant', timestamp: Date.now(),
        content: `message ${i}: ` + 'lorem ipsum context for benchmarking '.repeat(6),
      } as ChatMessage);
    }
  }
  return msgs;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function bench(fn: () => unknown, runs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Math.round(median(samples) * 1000) / 1000; // median ms
}

const results: Array<Record<string, unknown>> = [];
for (const n of [50, 200, 800]) {
  const cs = new ConversationState({ maxMessages: n + 100 });
  for (const m of makeMessages(n)) cs.addMessage(m);
  results.push({
    messages: cs.messageCount,
    buildApiMessages_ms: bench(() => buildApiMessages(cs.getMessagesCopy()), 100),
    estimateTokens_ms: bench(() => estimateMessageTokensArray(cs.getMessages()), 30),
  });
}
console.log(JSON.stringify({ metric: 'turn_overhead', results, timestamp: new Date().toISOString() }, null, 2));
