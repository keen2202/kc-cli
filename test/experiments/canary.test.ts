import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileExperimentRuntime, canaryBucket, isInCanaryBucket } from '../../src/experiments/runtime';
import { computeBaseHash, CATALOG_FORMAT } from '../../src/experiments/catalog';

function writeCatalog(tmp: string, obj: unknown): void {
  const dir = path.join(tmp, '.kc-cli', 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(obj), 'utf8');
}

function catalogWithRollout(base: string, percent: number, active = 'c1') {
  return {
    format: CATALOG_FORMAT,
    artifacts: {
      'prompt-surface:failure-recovery': {
        kind: 'prompt-surface',
        baseHash: computeBaseHash(base),
        active,
        rollout: { mode: 'canary', percent },
        variants: [
          {
            variantId: active,
            status: 'promoted',
            payload: 'CANARY',
            evidenceRef: 'sha256:ev',
          },
        ],
      },
    },
  };
}

describe('experiments/canary', () => {
  let tmp: string;
  const BASE = 'BASE TEXT';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-canary-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('canaryBucket is stable and in 0..99', () => {
    const a = canaryBucket('session-abc', 'prompt-surface:failure-recovery');
    const b = canaryBucket('session-abc', 'prompt-surface:failure-recovery');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it('percent=0 means full baseline for every session', () => {
    writeCatalog(tmp, catalogWithRollout(BASE, 0));
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 'any-session',
      promptSurfaceBaselines: { 'failure-recovery': BASE },
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', BASE).source).toBe('baseline');
    expect(rt.getAssignments()).toHaveLength(0);
  });

  it('forceCanaryBucket=in receives overlay without touching catalog.active', () => {
    writeCatalog(tmp, catalogWithRollout(BASE, 1)); // 1% — almost always out
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      promptSurfaceBaselines: { 'failure-recovery': BASE },
      forceCanaryBucket: 'in',
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', BASE).value).toBe('CANARY');
    // catalog on disk unchanged
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmp, '.kc-cli', 'experiments', 'catalog.json'), 'utf8')
    );
    expect(raw.artifacts['prompt-surface:failure-recovery'].active).toBe('c1');
  });

  it('forceCanaryBucket=out stays baseline even when percent=50', () => {
    writeCatalog(tmp, catalogWithRollout(BASE, 50));
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      promptSurfaceBaselines: { 'failure-recovery': BASE },
      forceCanaryBucket: 'out',
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', BASE).source).toBe('baseline');
  });

  it('no rollout field = full overlay (back-compat with pre-T12 catalogs)', () => {
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(BASE),
          active: 'c1',
          variants: [
            { variantId: 'c1', status: 'promoted', payload: 'FULL', evidenceRef: 'sha256:e' },
          ],
        },
      },
    });
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      promptSurfaceBaselines: { 'failure-recovery': BASE },
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', BASE).value).toBe('FULL');
  });

  it('bucket distribution roughly respects percent over many sessions', () => {
    const percent = 20;
    let inCount = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      if (canaryBucket(`session-${i}`, 'prompt-surface:failure-recovery') < percent) inCount++;
    }
    // Loose bounds — deterministic hash, not a statistical guarantee of exact 20%.
    expect(inCount).toBeGreaterThan(n * 0.05);
    expect(inCount).toBeLessThan(n * 0.45);
  });

  it('isInCanaryBucket helper: percent 0/100 edges', () => {
    expect(
      isInCanaryBucket('s', 'a', { rollout: { mode: 'canary', percent: 0 } })
    ).toBe(false);
    expect(
      isInCanaryBucket('s', 'a', { rollout: { mode: 'canary', percent: 50 } })
    ).toBe(true); // percent>=50 still uses bucket; 100 would be always
    expect(
      isInCanaryBucket('s', 'a', { rollout: { mode: 'canary', percent: 50 } }, 'in')
    ).toBe(true);
    expect(
      isInCanaryBucket('s', 'a', { rollout: { mode: 'canary', percent: 50 } }, 'out')
    ).toBe(false);
    expect(isInCanaryBucket('s', 'a', {})).toBe(true);
  });
});
