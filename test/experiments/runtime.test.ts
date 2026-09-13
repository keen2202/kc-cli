import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createExperimentRuntime,
  FileExperimentRuntime,
} from '../../src/experiments/runtime';
import { computeBaseHash, computeBaseHashJson, CATALOG_FORMAT } from '../../src/experiments/catalog';

describe('experiments/runtime', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-exp-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeCatalog(obj: unknown): void {
    const dir = path.join(tmp, '.kc-cli', 'experiments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(obj), 'utf8');
  }

  it('disabled factory returns noop with zero assignments', () => {
    const rt = createExperimentRuntime({ enabled: false, sessionId: 's' });
    rt.initialize();
    expect(rt.getAssignments()).toEqual([]);
  });

  it('missing catalog → baseline only', () => {
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's1',
      promptSurfaceBaselines: { 'failure-recovery': 'BASE' },
    });
    rt.initialize();
    const resolved = rt.resolvePromptSurface('failure-recovery', 'BASE');
    expect(resolved.source).toBe('baseline');
    expect(resolved.value).toBe('BASE');
  });

  it('corrupted catalog → baseline only, no throw', () => {
    const dir = path.join(tmp, '.kc-cli', 'experiments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{broken', 'utf8');
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's1',
      promptSurfaceBaselines: { 'failure-recovery': 'BASE' },
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', 'BASE').source).toBe('baseline');
  });

  it('promoted overlay is used when baseHash matches', () => {
    const base = 'BASE TEXT';
    writeCatalog({
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(base),
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: 'OVERLAID',
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's1',
      promptSurfaceBaselines: { 'failure-recovery': base },
    });
    rt.initialize();
    const resolved = rt.resolvePromptSurface('failure-recovery', base);
    expect(resolved.source).toBe('experiment');
    expect(resolved.value).toBe('OVERLAID');
    expect(resolved.variantId).toBe('c1');
    expect(rt.getAssignments()).toHaveLength(1);
  });

  it('baseHash mismatch at resolve-time falls back to baseline', () => {
    const base = 'BASE TEXT';
    writeCatalog({
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(base),
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: 'OVERLAID',
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's1',
      promptSurfaceBaselines: { 'failure-recovery': base },
    });
    rt.initialize();
    // Code baseline changed after init → drift guard
    const resolved = rt.resolvePromptSurface('failure-recovery', 'CHANGED BASE');
    expect(resolved.source).toBe('baseline');
    expect(resolved.value).toBe('CHANGED BASE');
  });

  it('catalog baseHash mismatch skips overlay at initialize', () => {
    writeCatalog({
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: 'sha256:stale',
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: 'OVERLAID',
              evidenceRef: 'sha256:ev',
            },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's1',
      promptSurfaceBaselines: { 'failure-recovery': 'BASE' },
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', 'BASE').source).toBe('baseline');
    expect(rt.getAssignments()).toHaveLength(0);
  });

  it('invalid policy overlay falls back to baseline', () => {
    const baseline = { maxSameCallRetries: 2, maxReadOnlyStreak: 5 };
    writeCatalog({
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson(baseline),
          active: 'p1',
          variants: [
            {
              variantId: 'p1',
              status: 'promoted',
              // out of bounds (maxSameCallRetries max 5)
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
      sessionId: 's1',
      runtimePolicyBaseline: baseline,
    });
    rt.initialize();
    const resolved = rt.resolveRuntimePolicy(baseline);
    expect(resolved.source).toBe('baseline');
    expect(resolved.value).toEqual(baseline);
  });

  it('valid policy overlay merges allowlisted fields only', () => {
    const baseline = {
      enabled: true,
      maxSameCallRetries: 2,
      retryIntervention: 'soft' as const,
      maxReadOnlyStreak: 5,
      maxTotalToolMessages: 0,
    };
    writeCatalog({
      format: CATALOG_FORMAT,
      artifacts: {
        'runtime-policy:default': {
          kind: 'runtime-policy',
          baseHash: computeBaseHashJson({ maxSameCallRetries: 2, maxReadOnlyStreak: 5 }),
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
      sessionId: 's1',
      // baseHash is computed from runtimePolicyBaseline as stored in constructor
      runtimePolicyBaseline: { maxSameCallRetries: 2, maxReadOnlyStreak: 5 },
    });
    rt.initialize();
    const resolved = rt.resolveRuntimePolicy(baseline);
    expect(resolved.source).toBe('experiment');
    expect(resolved.value.maxSameCallRetries).toBe(4);
    expect(resolved.value.retryIntervention).toBe('hard');
    // enabled is frozen
    expect(resolved.value.enabled).toBe(true);
  });

  it('recordRunOutcome appends JSONL and never throws on success', async () => {
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 'sess-1',
    });
    rt.initialize();
    await rt.recordRunOutcome({
      runId: 'r1',
      sessionId: 'sess-1',
      artifactAssignments: [],
      success: false,
      verified: false,
      patchFiles: [],
      turns: 3,
      noPatch: true,
      errorCode: 'budget_exceeded',
      timestamp: 1,
    });
    const file = path.join(tmp, '.kc-cli', 'experiments', 'runs', 'sess-1.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).errorCode).toBe('budget_exceeded');
  });
});
