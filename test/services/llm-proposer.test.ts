// Tests for the T6 LLM-driven proposer: code-level enablement gate,
// mandatory audit quadruple, proposal constraints (diversity/minimality/
// surface bounds), budget stop, and the Math.random removal in improve.ts.

import { describe, it, expect } from 'vitest';
import { LLMProposer, emptyEvidenceBundle } from '../../src/agp/sepl/llm-proposer';
import type { ProposerChatClient, ProposerGate } from '../../src/agp/sepl/llm-proposer';
import { ImproveOperator } from '../../src/agp/sepl/improve';
import { AuditLog } from '../../src/agp/audit-log';
import { BudgetEnforcer } from '../../src/services/budget';
import { MockLLMClient } from '../utils/mock-llm';
import type {
  EvaluatorBackend,
  EvolvableState,
  EvolvableVariable,
  Modification,
  ProposalAudit,
} from '../../src/agp/sepl/protocol';
import type { ServerInterface } from '../../src/agp/server-interface';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const stubBackend: EvaluatorBackend = {
  name: 'stub',
  evaluate: async () => ({ split: 'held_in', repeats: [] }),
};

const openGate: ProposerGate = {
  acceptanceGate: { enabled: true },
  evaluatorBackend: stubBackend,
};

function makeMod(overrides: Partial<Modification> = {}): Modification {
  return {
    id: 'mod-1',
    hypothesisId: 'hyp-1',
    targetResource: 'Agent:coder',
    resourceType: 'Agent',
    changeType: 'template_rewrite',
    proposedValue: null,
    estimatedImpact: 0.5,
    riskLevel: 'low',
    ...overrides,
  };
}

function makeAudit(overrides: Partial<ProposalAudit> = {}): ProposalAudit {
  return {
    targetFailurePattern: 'tool_timeout/direct_cause',
    editedSurface: 'Agent:coder',
    expectedEffect: 'fewer retries on timeouts',
    regressionRisk: 'low — wording only',
    ...overrides,
  };
}

function proposalJson(proposedValue: string, audit: Partial<ProposalAudit> | ProposalAudit = makeAudit()): string {
  return JSON.stringify({ proposedValue, audit });
}

function makeProposer(
  mock: MockLLMClient,
  auditLog: AuditLog,
  extra: { budget?: BudgetEnforcer; branches?: number; estimatedTokensPerProposal?: number } = {}
): LLMProposer {
  const proposer = LLMProposer.createGated(
    { client: mock as unknown as ProposerChatClient, auditLog, ...extra },
    openGate
  );
  expect(proposer).not.toBeNull();
  return proposer!;
}

function proposeInput(currentValue = 'Always run tests before finishing.') {
  return {
    evidence: emptyEvidenceBundle(),
    targetMod: makeMod(),
    currentValue,
    sessionId: 's1',
    iteration: 1,
  };
}

// ─── Enablement gate ─────────────────────────────────────────────────────────

describe('LLMProposer.createGated', () => {
  it('returns null when the acceptance gate is disabled', () => {
    const logs: string[] = [];
    const proposer = LLMProposer.createGated(
      { client: new MockLLMClient() as unknown as ProposerChatClient },
      { acceptanceGate: { enabled: false }, evaluatorBackend: stubBackend },
      m => logs.push(m)
    );
    expect(proposer).toBeNull();
    expect(logs.join(' ')).toContain('acceptance gate disabled');
  });

  it('returns null when no evaluator backend is injected', () => {
    const logs: string[] = [];
    const proposer = LLMProposer.createGated(
      { client: new MockLLMClient() as unknown as ProposerChatClient },
      { acceptanceGate: { enabled: true }, evaluatorBackend: null },
      m => logs.push(m)
    );
    expect(proposer).toBeNull();
    expect(logs.join(' ')).toContain('no evaluator backend');
  });

  it('returns an instance when gate is enabled and a backend exists', () => {
    const proposer = LLMProposer.createGated(
      { client: new MockLLMClient() as unknown as ProposerChatClient },
      openGate
    );
    expect(proposer).toBeInstanceOf(LLMProposer);
  });
});

// ─── Proposal generation ─────────────────────────────────────────────────────

describe('LLMProposer.propose', () => {
  it('parses K parallel branches and records accepted audit entries', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([
      { content: proposalJson('Variant A: verify before edit.') },
      { content: proposalJson('Variant B: read files first.') },
      { content: proposalJson('Variant C: cite evidence in replies.') },
    ]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog);

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(3);
    expect(mock.getCallLog()).toHaveLength(3);
    expect(candidates[0].audit.regressionRisk).toBe('low — wording only');
    const accepted = auditLog.query({ phase: 'proposal', success: true });
    expect(accepted).toHaveLength(3);
    expect(accepted[0].details.editedSurface).toBe('Agent:coder');
  });

  it('does not crash on malformed responses and records the rejection', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([
      { content: 'sure, here is my thinking but no JSON at all' },
      { content: '```json\n{"proposedValue": "Variant B ok."' }, // truncated JSON
      { content: proposalJson('Variant C fine.') },
    ]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog);

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(1);
    const rejected = auditLog.query({ phase: 'proposal', success: false });
    expect(rejected).toHaveLength(2);
    expect(rejected[0].error).toContain('unparseable');
  });

  it('rejects candidates missing any audit quadruple field', async () => {
    const mock = new MockLLMClient();
    const incomplete = makeAudit();
    delete (incomplete as Partial<ProposalAudit>).regressionRisk;
    mock.setResponses([{ content: proposalJson('Variant missing risk.', incomplete) }]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog, { branches: 1 });

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(0);
    const rejected = auditLog.query({ phase: 'proposal', success: false });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toContain('regressionRisk');
  });

  it('rejects edits to surfaces outside the target resource', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([
      { content: proposalJson('Variant touching another surface.', makeAudit({ editedSurface: 'Agent:other' })) },
    ]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog, { branches: 1 });

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(0);
    const rejected = auditLog.query({ phase: 'proposal', success: false });
    expect(rejected[0].error).toContain('surface out of bounds');
    // The full quadruple still lands in the audit trail
    expect(rejected[0].details.editedSurface).toBe('Agent:other');
  });

  it('deduplicates wording-variant branches (cross-branch diversity)', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([
      { content: proposalJson('Verify   before edit.') },
      { content: proposalJson('Verify before  edit.') }, // whitespace variant
      { content: proposalJson('A genuinely different edit.') },
    ]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog);

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(2);
    const rejected = auditLog.query({ phase: 'proposal', success: false });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toContain('duplicate');
  });

  it('rejects no-op proposals identical to the current value', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([{ content: proposalJson('Always run  tests before finishing.') }]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog, { branches: 1 });

    const candidates = await proposer.propose(proposeInput('Always run tests before finishing.'));

    expect(candidates).toHaveLength(0);
    expect(auditLog.query({ phase: 'proposal', success: false })[0].error).toContain('no-op');
  });

  it('stops launching branches when the sub-agent budget rejects', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([{ content: proposalJson('Never sent.') }]);
    const auditLog = new AuditLog();
    const budget = new BudgetEnforcer({ subAgentTokenLimit: 10 });
    const proposer = makeProposer(mock, auditLog, { budget, estimatedTokensPerProposal: 100 });

    const candidates = await proposer.propose(proposeInput());

    expect(candidates).toHaveLength(0);
    expect(mock.getCallLog()).toHaveLength(0);
    expect(auditLog.query({ phase: 'proposal', success: false })[0].error).toContain('budget');
  });

  it('rejects proposals exceeding the minimality length bound', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([{ content: proposalJson('x'.repeat(600)) }]);
    const auditLog = new AuditLog();
    // currentValue short → bound = max(len*3, 500) = 500
    const proposer = makeProposer(mock, auditLog, { branches: 1 });

    const candidates = await proposer.propose(proposeInput('short'));

    expect(candidates).toHaveLength(0);
    expect(auditLog.query({ phase: 'proposal', success: false })[0].error).toContain('minimality');
  });
});

// ─── Improve operator integration ────────────────────────────────────────────

function makeState(variable: Partial<EvolvableVariable>): EvolvableState {
  const full: EvolvableVariable = {
    resourceId: 'Agent:coder',
    resourceType: 'Agent',
    variableName: 'temperature',
    learnability: 1,
    currentValue: 0.7,
    valueType: 'number',
    ...variable,
  };
  const key = `${full.resourceId}:${full.variableName}`;
  return {
    variables: new Map([[key, full]]),
    trainableSubset: [key],
  };
}

const stubServer = { set_variables() {} } as unknown as ServerInterface;

describe('ImproveOperator (T6 changes)', () => {
  it('variable_update no longer applies random perturbation to numbers', async () => {
    const operator = new ImproveOperator(stubServer);
    const state = makeState({});

    const result = await operator.execute(state, {
      modifications: [makeMod({ changeType: 'variable_update' })],
      sourceHypothesisId: 'hyp-1',
    });

    const updated = result.state.variables.get('Agent:coder:temperature');
    expect(updated?.currentValue).toBe(0.7); // deterministic — exact original value
  });

  it('attachLLMProposer routes template_rewrite through the proposer', async () => {
    const mock = new MockLLMClient();
    mock.setResponses([
      { content: proposalJson('LLM-proposed system prompt.') },
      { content: proposalJson('Alternative wording two.') },
      { content: proposalJson('Alternative wording three.') },
    ]);
    const auditLog = new AuditLog();
    const proposer = makeProposer(mock, auditLog);

    const operator = new ImproveOperator(stubServer);
    operator.attachLLMProposer(proposer, () => ({ sessionId: 's1', iteration: 2 }));

    const state = makeState({
      variableName: 'systemPrompt',
      currentValue: 'Old prompt.',
      valueType: 'template',
    });
    const result = await operator.execute(state, {
      modifications: [makeMod({ changeType: 'template_rewrite' })],
      sourceHypothesisId: 'hyp-1',
    });

    const updated = result.state.variables.get('Agent:coder:systemPrompt');
    expect(updated?.currentValue).toBe('LLM-proposed system prompt.');
    expect(String(updated?.currentValue)).not.toContain('[Refinement]');
    expect(auditLog.query({ phase: 'proposal', success: true }).length).toBeGreaterThan(0);
  });
});
