import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REQUIRED_SECTIONS,
  validateReport,
} from '../../src/orchestrator/report-validator';
import type {
  CompletionClaim,
  ReportFinding,
  SubAgentResult,
} from '../../src/orchestrator/types';
import type { ExecutionTrace } from '../../src/services/execution-env';

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    agentId: 'agent@0',
    name: 'agent',
    success: true,
    output: '',
    toolUseCount: 1,
    totalTokensUsed: 10,
    duration: 5,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<CompletionClaim> = {}): CompletionClaim {
  return {
    filesCreated: [],
    filesModified: [],
    commands: [],
    obligationCitations: ['消息 1'],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    commands: [],
    fileWrites: [],
    startedAt: 1,
    cwd: '/repo',
    ...overrides,
  };
}

const CHECKPOINT = '是否保留既有 API 兼容性？';

function findingsFor(result: SubAgentResult, required = [DEFAULT_REQUIRED_SECTIONS[0]!]): ReportFinding[] {
  return validateReport(result, { requiredSections: required, checkpoints: [CHECKPOINT] });
}

describe('validateReport — positive fixtures', () => {
  it('returns zero findings for a fully compliant report', () => {
    const result = makeResult({
      output: [
        '交付物清单: 创建 src/new-file.ts',
        '命令+退出码: npm test (exit 0)',
        `检查站作答: ${CHECKPOINT} 答：保留`,
        '测试结果：共 23 个用例通过',
      ].join('\n'),
      claim: makeClaim({
        filesCreated: ['src/new-file.ts'],
        commands: [{
          command: 'npm test',
          exitCode: 0,
          evidenceLine: 'Tests 23 passed',
        }],
      }),
      meta: {
        executionTrace: makeTrace({
          commands: [{
            command: 'npm test',
            exitCode: 0,
            stdout: 'Tests 23 passed',
            stderr: '',
            timestamp: 2,
          }],
          fileWrites: [{ path: 'src/new-file.ts', kind: 'created', timestamp: 3 }],
          cwd: '/repo',
        }),
      },
    });

    expect(validateReport(result, {
      requiredSections: [...DEFAULT_REQUIRED_SECTIONS],
      checkpoints: [CHECKPOINT],
    })).toEqual([]);
  });

  it('accepts an absolute declared path that matches the trace cwd', () => {
    const result = makeResult({
      output: '交付物清单: /repo/src/a.ts\n命令+退出码: npm test (exit 0)',
      claim: makeClaim({
        filesModified: ['/repo/src/a.ts'],
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'ok' }],
      }),
      meta: {
        executionTrace: makeTrace({
          fileWrites: [{ path: '/repo/src/a.ts', kind: 'created', timestamp: 3 }],
        }),
      },
    });

    const findings = validateReport(result, { requiredSections: ['交付物清单', '命令+退出码'] });
    expect(findings.filter((f) => f.rule === 'R4')).toEqual([]);
  });
});

describe('validateReport — LT-1 real negative cases', () => {
  it('LT-1 case 1: "作答见消息开头" without an actual checkpoint answer is an R1 blocker', () => {
    const result = makeResult({
      output: '任务已完成，作答见消息开头。',
    });

    const findings = validateReport(result, {
      requiredSections: [...DEFAULT_REQUIRED_SECTIONS],
      checkpoints: [CHECKPOINT],
    });

    expect(findings.some((f) => f.rule === 'R1' && f.severity === 'blocker')).toBe(true);
    expect(findings.some((f) => f.code === 'checkpoint_deflection')).toBe(true);
  });

  it('LT-1 case 2: "23 个用例" with no evidenceLine is an R2 blocker marked unsubstantiated', () => {
    const result = makeResult({
      output: [
        '交付物清单: 无',
        '命令+退出码: npm test (exit 0)',
        `检查站作答: ${CHECKPOINT} 答：保留`,
        '本次任务共完成 23 个用例的验证。',
      ].join('\n'),
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0 }],
      }),
    });

    const findings = validateReport(result, {
      requiredSections: [...DEFAULT_REQUIRED_SECTIONS],
      checkpoints: [CHECKPOINT],
    });
    const r2 = findings.filter((f) => f.rule === 'R2');

    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({
      severity: 'blocker',
      code: 'numeric_claim_unsubstantiated',
      unsubstantiated: true,
    });
  });

  it('LT-1 case 3: empty obligationCitations is an R3 warning', () => {
    const result = makeResult({
      output: '交付物清单: x\n命令+退出码: x (exit 0)',
      claim: makeClaim({ obligationCitations: [] }),
    });

    const findings = validateReport(result, { requiredSections: ['交付物清单', '命令+退出码'] });

    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'R3',
        severity: 'warning',
        code: 'missing_obligation_citations',
      }),
    ]);
  });
});

describe('validateReport — R2 claim/evidence reconciliation', () => {
  it('flags a mismatch when the evidenceLine contains a different number', () => {
    const result = makeResult({
      output: '共 23 个用例通过',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'Tests 21 passed' }],
      }),
    });

    const r2 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R2');
    expect(r2[0]).toMatchObject({
      severity: 'blocker',
      code: 'numeric_claim_mismatch',
      unsubstantiated: true,
    });
  });

  it('degrades an unparseable evidenceLine to a warning (not blocker)', () => {
    const result = makeResult({
      output: '共 23 个用例通过',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'Tests passed (count unavailable)' }],
      }),
    });

    const r2 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R2');
    expect(r2[0]).toMatchObject({
      severity: 'warning',
      code: 'numeric_claim_unparseable_evidence',
    });
  });

  it('accepts a matching evidenceLine', () => {
    const result = makeResult({
      output: '共 23 个用例通过',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'Tests 23 passed' }],
      }),
    });

    expect(validateReport(result, { requiredSections: [] })).toEqual([]);
  });
});

describe('validateReport — R4 boundary attestation', () => {
  it('blocks an undeclared write observed by the execution trace', () => {
    const result = makeResult({
      output: '交付物清单: 无新增文件',
      claim: makeClaim(),
      meta: {
        executionTrace: makeTrace({
          fileWrites: [{ path: 'src/secret.ts', kind: 'created', timestamp: 2 }],
        }),
      },
    });

    const r4 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R4');
    expect(r4.some((f) => f.severity === 'blocker' && f.code === 'undeclared_write')).toBe(true);
  });

  it('exempts backup-directory writes (false-positive guard)', () => {
    const result = makeResult({
      output: '交付物清单: 无',
      claim: makeClaim(),
      meta: {
        executionTrace: makeTrace({
          fileWrites: [{ path: '.kc-cli/backups/src-a.ts.bak', kind: 'created', timestamp: 2 }],
        }),
      },
    });

    const r4 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R4');
    expect(r4).toEqual([]);
  });

  it('does not run R4 when no execution trace is present', () => {
    const result = makeResult({
      output: '交付物清单: src/a.ts',
      claim: makeClaim({ filesCreated: ['src/a.ts'] }),
    });

    expect(validateReport(result, { requiredSections: [] })).toEqual([]);
  });
});

describe('validateReport — R5 environment claims', () => {
  it('warns when stdout is claimed unavailable but the trace captured it', () => {
    const result = makeResult({
      output: '命令+退出码: npm test (exit 0)。stdout 未被捕获，无法报告详细输出。',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'Tests 23 passed' }],
      }),
      meta: {
        executionTrace: makeTrace({
          commands: [{
            command: 'npm test',
            exitCode: 0,
            stdout: 'Tests 23 passed',
            stderr: '',
            timestamp: 2,
          }],
        }),
      },
    });

    const r5 = validateReport(result, { requiredSections: ['命令+退出码'] }).filter((f) => f.rule === 'R5');
    expect(r5[0]).toMatchObject({
      severity: 'warning',
      code: 'stdout_claim_conflict',
    });
  });
});

describe('validateReport — additional coverage branches', () => {
  it('accepts a checkpoint id/marker answer when the full question is absent', () => {
    const question = '请确认迁移计划是否可用并保留既有 API 兼容性与回滚路径';
    const result = makeResult({
      output: '请确认迁移计划是否可用并保留既有 API 兼容性，答：是',
      claim: makeClaim(),
    });

    const findings = validateReport(result, {
      requiredSections: ['检查站作答'],
      checkpoints: [question],
    });
    expect(findings.filter((f) => f.rule === 'R1')).toEqual([]);
  });

  it('does not flag a blank checkpoint or blank custom section', () => {
    const result = makeResult({ output: 'any output', claim: makeClaim() });
    expect(validateReport(result, { requiredSections: ['检查站作答'], checkpoints: ['   '] })).toEqual([]);
    expect(validateReport(result, { requiredSections: [''] })).toEqual([]);
  });

  it('warns on an unlocatable obligation citation', () => {
    const result = makeResult({
      output: '交付物清单: x',
      claim: makeClaim({ obligationCitations: ['not a locatable citation'] }),
    });

    const findings = validateReport(result, { requiredSections: [] });
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'R3',
        severity: 'warning',
        code: 'unlocatable_obligation_citation',
      }),
    ]);
  });

  it('blocks a declared write that the trace never observed', () => {
    const result = makeResult({
      output: '交付物清单: src/ghost.ts',
      claim: makeClaim({ filesCreated: ['src/ghost.ts'] }),
      meta: { executionTrace: makeTrace() },
    });

    const r4 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R4');
    expect(r4.some((f) => f.code === 'declared_write_not_traced' && f.severity === 'blocker')).toBe(true);
  });

  it('warns when a report claims command failure but all traced exits are zero', () => {
    const result = makeResult({
      output: '命令执行失败，原因是依赖缺失。',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: 'ok' }],
      }),
      meta: {
        executionTrace: makeTrace({
          commands: [{
            command: 'npm test',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            timestamp: 2,
          }],
        }),
      },
    });

    const r5 = validateReport(result, { requiredSections: [] }).filter((f) => f.rule === 'R5');
    expect(r5.some((f) => f.code === 'command_failure_claim_conflict' && f.severity === 'warning')).toBe(true);
  });

  it('ignores non-finite numeric values without throwing', () => {
    const result = makeResult({ output: `共 ${'9'.repeat(400)} 个用例通过` });
    expect(() => validateReport(result, { requiredSections: [] })).not.toThrow();
  });

  it('returns no findings for malformed/non-object input', () => {
    expect(validateReport(null as unknown as SubAgentResult, { requiredSections: [] })).toEqual([]);
  });
});

describe('validateReport — edge cases', () => {
  it('handles an empty report without throwing', () => {
    const findings = validateReport(makeResult(), { requiredSections: [...DEFAULT_REQUIRED_SECTIONS] });
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.some((f) => f.rule === 'R1' && f.severity === 'blocker')).toBe(true);
  });

  it('handles a 100KB report in under 50ms', () => {
    const filler = 'lorem ipsum 测试文本 '.repeat(5500); // ~110KB
    const result = makeResult({ output: `${filler}\n共 23 个用例通过` });
    const started = performance.now();
    const findings = validateReport(result, { requiredSections: [] });
    const elapsed = performance.now() - started;

    expect(findings.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('handles non-UTF8-style / multi-byte unicode content without corruption', () => {
    const result = makeResult({
      output: '交付物清单: 🧪 café ✓\n命令+退出码: `npm test` (exit 0)\n共 0 个用例通过',
      claim: makeClaim({
        commands: [{ command: 'npm test', exitCode: 0, evidenceLine: '0 passed' }],
      }),
    });

    expect(() => validateReport(result, { requiredSections: ['交付物清单', '命令+退出码'] })).not.toThrow();
  });

  it('accepts a plain string[] as the second argument', () => {
    const result = makeResult({ output: '交付物清单: x' });
    const findings = validateReport(result, ['交付物清单'] as unknown as never);
    expect(findings.filter((f) => f.rule === 'R1')).toEqual([]);
  });
});
