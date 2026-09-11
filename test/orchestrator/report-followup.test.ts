import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// QueryEngine is mocked so the backend runs the full in-process lifecycle
// without hitting an API. `submitMessageImpl` records every prompt, which lets
// these tests assert the generated follow-up message.
let submitMessageImpl: (message: string) => AsyncGenerator<any> = async function* () {};

vi.mock('../../src/query/QueryEngine', () => ({
  QueryEngine: class MockQueryEngine {
    submitMessage(message: string) {
      return submitMessageImpl(message);
    }
    abort(_reason?: string) {}
    isAborted() {
      return false;
    }
  },
}));

const CHECKPOINT = '是否保留既有 API 兼容性？';
const REQUIRED = ['交付物清单', '命令+退出码', '检查站作答'];

const GOOD_REPORT = [
  '交付物清单: 无新增文件',
  '命令+退出码: 未执行命令 (exit 0)',
  `检查站作答: ${CHECKPOINT} 答：保留`,
].join('\n');

const BAD_REPORT = '任务已完成。作答见消息开头。';

function turnComplete(content: string): any {
  return {
    type: 'agent:turn_complete',
    message: { content, toolCalls: [] },
    timestamp: Date.now(),
  };
}

function parentContext(): any {
  return {
    cwd: '/test',
    abortController: new AbortController(),
    permissions: {
      mode: 'default',
      cwd: '/test',
      toolName: '',
      input: {},
      alwaysDenyRules: [],
      alwaysAskRules: [],
      alwaysAllowRules: [],
      bypassPermissions: false,
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  const state = await import('../../src/bootstrap/state');
  state.initializeState({ cwd: '/test', permissionMode: 'default' });
  process.env.KC_API_KEY = 'test-dummy-key';
  submitMessageImpl = async function* () {};
  vi.doMock('../../src/query/QueryEngine', () => ({
    QueryEngine: class MockQueryEngine {
      submitMessage(message: string) {
        return submitMessageImpl(message);
      }
      abort(_reason?: string) {}
      isAborted() {
        return false;
      }
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeOrchestrator() {
  const { AgentOrchestrator, resetOrchestrator } = await import(
    '../../src/orchestrator/agent-orchestrator'
  );
  resetOrchestrator();
  return new AgentOrchestrator([]);
}

describe('report follow-up gate', () => {
  it('resumes once when the first report has blocker findings', async () => {
    const calls: string[] = [];
    submitMessageImpl = async function* (message: string) {
      calls.push(message);
      yield turnComplete(calls.length === 1 ? BAD_REPORT : GOOD_REPORT);
    };

    const orchestrator = await makeOrchestrator();
    const agentId = await orchestrator.spawn(
      {
        name: 'gated',
        prompt: 'do the task',
        systemPromptMode: 'default',
        checkpoints: [CHECKPOINT],
        reportPolicy: { requiredSections: REQUIRED, maxFollowUps: 1 },
      },
      parentContext(),
    );

    const result = await orchestrator.waitForCompletion(agentId, 5000);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('[Report integrity gate]');
    expect(calls[1]).toContain('作答见消息开头');
    expect(result.success).toBe(true);
    expect(result.meta?.unresolved).toBeUndefined();
    expect(result.meta?.reportFindings?.some((f) => f.rule === 'R3')).toBe(true);
  });

  it('marks the result unresolved after the follow-up budget is exhausted', async () => {
    const calls: string[] = [];
    submitMessageImpl = async function* (message: string) {
      calls.push(message);
      yield turnComplete(BAD_REPORT);
    };

    const orchestrator = await makeOrchestrator();
    const agentId = await orchestrator.spawn(
      {
        name: 'still-bad',
        prompt: 'do the task',
        systemPromptMode: 'default',
        checkpoints: [CHECKPOINT],
        reportPolicy: { requiredSections: REQUIRED, maxFollowUps: 1 },
      },
      parentContext(),
    );

    const result = await orchestrator.waitForCompletion(agentId, 5000);

    expect(calls).toHaveLength(2); // initial + one bounded follow-up
    expect(result.success).toBe(false);
    expect(result.meta?.unresolved).toBe(true);
    expect(result.error).toContain('Report integrity unresolved');
    expect(result.meta?.reportFindings?.some((f) => f.severity === 'blocker')).toBe(true);

    const aggregated = await orchestrator.waitForAll(1000);
    expect(aggregated.unresolvedAgents).toContain(agentId);
    expect(aggregated.findings?.some((f) => f.severity === 'blocker')).toBe(true);
    expect(aggregated.summary).toContain('UNRESOLVED');
  });

  it('does not resume when the report only has warnings', async () => {
    const calls: string[] = [];
    submitMessageImpl = async function* (message: string) {
      calls.push(message);
      yield turnComplete('任务完成，但没有结构化汇报义务引用。');
    };

    const orchestrator = await makeOrchestrator();
    const agentId = await orchestrator.spawn(
      {
        name: 'warn-only',
        prompt: 'do the task',
        systemPromptMode: 'default',
        reportPolicy: { requiredSections: [], maxFollowUps: 1 },
      },
      parentContext(),
    );

    const result = await orchestrator.waitForCompletion(agentId, 5000);

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.meta?.unresolved).toBeUndefined();
    expect(result.meta?.reportFindings?.some((f) => f.severity === 'warning')).toBe(true);
    expect(result.meta?.reportFindings?.some((f) => f.severity === 'blocker')).toBe(false);
  });

  it('leaves non-policy agents on the legacy path', async () => {
    const calls: string[] = [];
    submitMessageImpl = async function* (message: string) {
      calls.push(message);
      yield turnComplete('done');
    };

    const orchestrator = await makeOrchestrator();
    const agentId = await orchestrator.spawn(
      { name: 'legacy', prompt: 'do the task', systemPromptMode: 'default' },
      parentContext(),
    );

    const result = await orchestrator.waitForCompletion(agentId, 5000);

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.meta?.reportFindings).toBeUndefined();
    expect(result.meta?.unresolved).toBeUndefined();
  });
});
