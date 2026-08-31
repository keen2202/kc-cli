// Long-session benchmark: drives QueryEngine with MockLLMClient for N turns,
// samples heap usage every K turns to produce a growth curve.
// Run: npx tsx scripts/bench/long-session.ts
import { initializeState } from '../../src/bootstrap/state';
import { QueryEngine } from '../../src/query/QueryEngine';
import { MockLLMClient } from '../../test/utils/mock-llm';
import type { BaseApiClient } from '../../src/api/BaseApiClient';

const TURNS = 60;
const SAMPLE_EVERY = 5;

initializeState();
process.env.KC_API_KEY = 'bench-dummy-key';

const mock = new MockLLMClient();
mock.setResponses(Array.from({ length: TURNS }, (_, i) => ({ content: `reply ${i}: ` + 'content '.repeat(40) })));

const engine = new QueryEngine(
  {
    model: 'bench-model', provider: 'anthropic', apiKey: 'bench-dummy-key',
    maxTurns: TURNS + 10, maxBudgetUsd: null,
    // The bench bypasses loadConfig (which applies KC_SANDBOX_FAIL_IF_NO_SANDBOX);
    // pass the flag directly so the engine constructs on hosts without a
    // sandbox backend (Windows dev machines).
    sandboxFailIfNoSandbox: false,
  },
  [],
);
// Established test pattern (see test/query/QueryEngineStreaming.test.ts): the
// engine always constructs its own client, so inject the mock afterwards.
(engine as unknown as { apiClient: BaseApiClient }).apiClient = mock as unknown as BaseApiClient;

const curve: Array<{ turn: number; heapUsedMb: number }> = [];
for (let turn = 1; turn <= TURNS; turn++) {
  for await (const _event of engine.submitMessage(`turn ${turn}: please answer briefly`)) {
    // drain the stream; events are irrelevant for this benchmark
  }
  if (turn % SAMPLE_EVERY === 0) {
    curve.push({ turn, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) });
  }
}
console.log(JSON.stringify({ metric: 'long_session', turns: TURNS, curve, timestamp: new Date().toISOString() }, null, 2));
