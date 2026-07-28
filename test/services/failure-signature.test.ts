/**
 * Failure signature + evidence bundle tests (harness-evolution T3).
 *
 * Verifies deterministic three-part signatures (terminalCause, causalStatus,
 * mechanism), exact-match clustering, prescription-free bundles, and the
 * Reflect operator's evidence-driven path with legacy fallback.
 */

import { describe, it, expect } from 'vitest';
import { TraceManager } from '../../src/agp/trace-manager';
import { ReflectOperator, buildTraceSpace } from '../../src/agp/sepl/reflect';
import { createEmptyEvolvableState } from '../../src/agp/sepl/protocol';
import type { EvidenceBundle, TraceSpace } from '../../src/agp/sepl/protocol';

function findCluster(bundle: EvidenceBundle, mechanism: string) {
  return bundle.clusters.find(c => c.signature.mechanism === mechanism);
}

describe('TraceManager.buildEvidenceBundle', () => {
  it('detects retry loops (same call failing consecutively >= 2 times)', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    for (let i = 0; i < 3; i++) {
      tm.recordToolCall('FileWrite', { path: 'a.ts' }, null, {
        isError: true,
        errorMessage: 'operation failed',
      });
    }

    const bundle = tm.buildEvidenceBundle('s1');
    expect(bundle.totalFailures).toBe(3);

    const loop = findCluster(bundle, 'retry_loop');
    expect(loop).toBeDefined();
    expect(loop!.count).toBe(2); // failures #2 and #3 are the repeats
    expect(loop!.signature.terminalCause).toBe('tool_failed');
    expect(loop!.signature.causalStatus).toBe('direct'); // last failure is in this cluster
    expect(loop!.representativeEvents.length).toBe(2);

    // The first failure of the burst is a separate (unknown) cluster
    const first = findCluster(bundle, 'unknown');
    expect(first).toBeDefined();
    expect(first!.count).toBe(1);
    expect(first!.signature.causalStatus).toBe('incidental');
  });

  it('does not flag retry_loop when the same call succeeds in between', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('FileWrite', { path: 'a.ts' }, null, { isError: true, errorMessage: 'operation failed' });
    tm.recordToolCall('FileWrite', { path: 'a.ts' }, 'ok'); // success resets streak
    tm.recordToolCall('FileWrite', { path: 'a.ts' }, null, { isError: true, errorMessage: 'operation failed' });

    const bundle = tm.buildEvidenceBundle('s1');
    expect(findCluster(bundle, 'retry_loop')).toBeUndefined();
  });

  it('classifies ENOENT failures as missing_artifact with file_not_found cause', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('FileRead', { path: 'missing.txt' }, null, {
      isError: true,
      errorMessage: 'ENOENT: no such file or directory, open missing.txt',
    });

    const bundle = tm.buildEvidenceBundle('s1');
    expect(bundle.clusters.length).toBe(1);
    expect(bundle.clusters[0].signature).toEqual({
      terminalCause: 'file_not_found',
      causalStatus: 'direct',
      mechanism: 'missing_artifact',
    });
  });

  it('detects exploration stall after a long read-only streak', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    for (let i = 0; i < 5; i++) {
      tm.recordToolCall('Grep', { pattern: `q${i}` }, 'results');
    }
    tm.recordToolCall('FileWrite', { path: 'x.ts' }, null, {
      isError: true,
      errorMessage: 'agent could not make progress',
    });

    const bundle = tm.buildEvidenceBundle('s1');
    const stall = findCluster(bundle, 'exploration_stall');
    expect(stall).toBeDefined();
    expect(stall!.signature.terminalCause).toBe('tool_failed');
    expect(stall!.signature.causalStatus).toBe('direct');
  });

  it('detects exploration stall via a runtime-control break decision event', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.record({
      category: 'decision',
      severity: 'warn',
      source: 'runtime-control',
      message: 'exploration_break:soft',
    });
    tm.recordToolCall('Task', { goal: 'x' }, null, {
      isError: true,
      errorMessage: 'agent could not make progress',
    });

    const bundle = tm.buildEvidenceBundle('s1');
    expect(findCluster(bundle, 'exploration_stall')).toBeDefined();
  });

  it('splits same terminalCause with different mechanisms into different clusters', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    // Burst A: retry loop on ToolA (terminalCause tool_failed)
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
    // Burst B: exploration stall on ToolB (terminalCause tool_failed too)
    for (let i = 0; i < 5; i++) {
      tm.recordToolCall('FileRead', { path: `f${i}` }, 'content');
    }
    tm.recordToolCall('ToolB', { y: 2 }, null, { isError: true, errorMessage: 'agent gave up' });

    const bundle = tm.buildEvidenceBundle('s1');
    const loop = findCluster(bundle, 'retry_loop');
    const stall = findCluster(bundle, 'exploration_stall');
    expect(loop).toBeDefined();
    expect(stall).toBeDefined();
    expect(loop!.signature.terminalCause).toBe('tool_failed');
    expect(stall!.signature.terminalCause).toBe('tool_failed');
    expect(loop!.signature.mechanism).not.toBe(stall!.signature.mechanism);
  });

  it('prefers an explicit errorCode from event data as terminalCause', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordError('budget-service', new Error('turn budget exhausted'), {
      errorCode: 'budget_exceeded',
    });

    const bundle = tm.buildEvidenceBundle('s1');
    expect(bundle.clusters[0].signature.terminalCause).toBe('budget_exceeded');
  });

  it('classifies timeout / permission / env / schema mechanisms deterministically', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('Shell', { cmd: 'a' }, null, { isError: true, errorMessage: 'command not found: pytest' });
    tm.recordToolCall('Shell', { cmd: 'b' }, null, { isError: true, errorMessage: 'operation timed out after 30s' });
    tm.recordToolCall('FileWrite', { path: 'c' }, null, { isError: true, errorMessage: 'EACCES: permission denied' });
    tm.recordToolCall('ToolX', { z: 1 }, null, { isError: true, errorMessage: 'input validation failed: bad schema' });

    const bundle = tm.buildEvidenceBundle('s1');
    const mechanisms = bundle.clusters.map(c => c.signature.mechanism).sort();
    expect(mechanisms).toEqual(
      ['env_missing_dependency', 'permission_blocked', 'schema_invalid', 'timeout_unbounded'].sort()
    );
  });

  it('is deterministic: the same trace sequence yields the same clusters', () => {
    const build = () => {
      const tm = new TraceManager();
      tm.startSession('s1');
      tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
      tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
      tm.recordToolCall('FileRead', { path: 'gone' }, null, {
        isError: true,
        errorMessage: 'ENOENT: no such file',
      });
      return tm.buildEvidenceBundle('s1');
    };

    const a = build();
    const b = build();
    // Compare structure ignoring volatile ids/timestamps
    const strip = (bundle: EvidenceBundle) =>
      bundle.clusters.map(c => ({
        signature: c.signature,
        count: c.count,
        symptoms: c.sharedSymptoms,
        sources: c.representativeEvents.map(e => e.source),
      }));
    expect(strip(a)).toEqual(strip(b));
  });

  it('contains no prescriptions (evaluator/optimizer separation)', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'ENOENT: no such file' });

    const serialized = JSON.stringify(tm.buildEvidenceBundle('s1'));
    expect(serialized).not.toMatch(/fixDirection|repairSuggestion|suggestion|recommended/i);
  });

  it('returns an empty bundle for traces without failures', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('Grep', { pattern: 'ok' }, 'results');

    const bundle = tm.buildEvidenceBundle('s1');
    expect(bundle.clusters).toEqual([]);
    expect(bundle.totalFailures).toBe(0);
  });
});

describe('ReflectOperator evidence consumption', () => {
  it('buildTraceSpace attaches an evidence bundle', () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'ENOENT: no such file' });

    const trace = buildTraceSpace(tm, 's1');
    expect(trace.evidence).toBeDefined();
    expect(trace.evidence!.clusters.length).toBe(1);
  });

  it('generates hypotheses from evidence clusters instead of string counts', async () => {
    const tm = new TraceManager();
    tm.startSession('s1');
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });
    tm.recordToolCall('ToolA', { x: 1 }, null, { isError: true, errorMessage: 'operation failed' });

    const trace = buildTraceSpace(tm, 's1');
    const reflect = new ReflectOperator(tm);
    const result = await reflect.execute(createEmptyEvolvableState(), trace);

    expect(result.success).toBe(true);
    const top = result.output.hypotheses[0];
    expect(top.description).toContain('retry_loop');
    expect(top.evidence).toContain('terminalCause=tool_failed');
    expect(top.evidence).toContain('mechanism=retry_loop');
    expect(top.evidence).toContain('causalStatus=direct');
  });

  it('falls back to legacy heuristics when no evidence is present', async () => {
    const trace: TraceSpace = {
      executionSummary: {
        totalEvents: 10,
        errorCount: 3,
        failurePatterns: new Map([['boom', 3]]),
        averageLatencyMs: 100,
        toolFailures: [{ name: 'ToolA', errorMessage: 'boom', count: 3 }],
        llmIssues: [],
      },
      sessionId: 's1',
      // no evidence field — legacy path must still work
    };

    const reflect = new ReflectOperator(new TraceManager());
    const result = await reflect.execute(createEmptyEvolvableState(), trace);

    expect(result.success).toBe(true);
    expect(result.output.hypotheses.length).toBeGreaterThan(0);
    expect(result.output.hypotheses[0].description).toContain('ToolA');
  });
});
