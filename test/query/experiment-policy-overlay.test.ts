/**
 * T10 — bounded RuntimeControlPolicy overlay via ExperimentRuntime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileExperimentRuntime } from '../../src/experiments/runtime';
import { computeBaseHashJson, CATALOG_FORMAT } from '../../src/experiments/catalog';
import type { RuntimePolicyOverlay } from '../../src/experiments/protocol';
import { RuntimeControlHandler } from '../../src/query/QueryEngineRuntimeControl';

const BASELINE: RuntimePolicyOverlay = {
  maxSameCallRetries: 2,
  retryIntervention: 'soft',
  maxReadOnlyStreak: 5,
  maxTotalToolMessages: 0,
};

function writeCatalog(tmp: string, obj: unknown): void {
  const dir = path.join(tmp, '.kc-cli', 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(obj), 'utf8');
}

describe('query/experiment-policy-overlay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-exp-policy-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('disabled runtime returns baseline policy unchanged', () => {
    const rt = new FileExperimentRuntime({
      enabled: false,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    const resolved = rt.resolveRuntimePolicy(BASELINE);
    expect(resolved.source).toBe('baseline');
    expect(resolved.value).toEqual(BASELINE);
  });

  it('promoted overlay merges allowlisted fields; enabled stays frozen', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson(BASELINE),
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              payload: { maxSameCallRetries: 4, retryIntervention: 'hard' },
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    const withEnabled = { ...BASELINE, enabled: false };
    const resolved = rt.resolveRuntimePolicy(withEnabled);
    expect(resolved.source).toBe('experiment');
    expect(resolved.value.maxSameCallRetries).toBe(4);
    expect(resolved.value.retryIntervention).toBe('hard');
    expect(resolved.value.enabled).toBe(false);
    expect(resolved.value.maxReadOnlyStreak).toBe(5);
  });

  it('out-of-bounds overlay is rejected whole-package → baseline', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson(BASELINE),
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              payload: { maxSameCallRetries: 99 },
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    expect(rt.resolveRuntimePolicy(BASELINE).source).toBe('baseline');
  });

  it('unknown field in overlay is rejected (strict schema)', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson(BASELINE),
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              payload: { enabled: true, maxSameCallRetries: 3 },
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    // enabled in payload → strict schema fails → baseline
    expect(rt.resolveRuntimePolicy(BASELINE).source).toBe('baseline');
  });

  it('hard intervention from overlay is reflected in RuntimeControlHandler', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson(BASELINE),
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              payload: { retryIntervention: 'hard', maxSameCallRetries: 1 },
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    const resolved = rt.resolveRuntimePolicy({ ...BASELINE, enabled: true });
    expect(resolved.source).toBe('experiment');
    const handler = new RuntimeControlHandler({ ...resolved.value, enabled: true });

    const input = { command: 'echo hi' };
    expect(handler.checkHardReject('Bash', input)).toBeNull();
    handler.recordToolResult('Bash', input, true);
    const reject = handler.checkHardReject('Bash', input);
    expect(reject).toContain('Runtime control policy rejected');
  });

  it('baseHash mismatch skips overlay at initialize', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: 'sha256:stale',
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              payload: { maxSameCallRetries: 5 },
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runtimePolicyBaseline: BASELINE,
    });
    rt.initialize();
    expect(rt.getAssignments()).toHaveLength(0);
    expect(rt.resolveRuntimePolicy(BASELINE).source).toBe('baseline');
  });
});
