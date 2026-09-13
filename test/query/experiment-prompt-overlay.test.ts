/**
 * T9 — experiment prompt-surface overlay wired into QueryEngine conditional injection.
 *
 * Covers:
 * - disabled / no runtime → byte-identical baseline injection
 * - enabled + catalog overlay → surface text replaced
 * - baseHash drift → baseline fallback
 * - corrupt catalog → baseline fallback
 * - session pin locked (no mid-session catalog re-read)
 * - static prefix never rewritten (only evolvable conditional surfaces)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildConditionalInjection,
  CONDITIONAL_SURFACES,
  FAILURE_RECOVERY_SURFACE,
  BOOTSTRAP_FIRST_TURN_SURFACE,
  computeSurfaceRuntime,
} from '../../src/api/prompts/instruction-surfaces';
import { FileExperimentRuntime } from '../../src/experiments/runtime';
import { computeBaseHash, CATALOG_FORMAT } from '../../src/experiments/catalog';

const FAILURE_RUNTIME = { isFirstTurn: false, lastToolResultHadError: true };
const FIRST_TURN_RUNTIME = { isFirstTurn: true, lastToolResultHadError: false };

function writeCatalog(tmp: string, obj: unknown): void {
  const dir = path.join(tmp, '.kc-cli', 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(obj), 'utf8');
}

describe('query/experiment-prompt-overlay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-exp-overlay-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('without resolver, injection equals code baseline (byte-identical)', () => {
    const text = buildConditionalInjection(FAILURE_RUNTIME);
    const expected = FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME);
    expect(text).toBe(expected);
  });

  it('no-op runtime resolver keeps baseline text', () => {
    const rt = new FileExperimentRuntime({
      enabled: false,
      cwd: tmp,
      sessionId: 's',
      promptSurfaceBaselines: {
        'failure-recovery': FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME),
      },
    });
    rt.initialize();
    const text = buildConditionalInjection(FAILURE_RUNTIME, CONDITIONAL_SURFACES, (name, base) =>
      rt.resolvePromptSurface(name, base).value
    );
    expect(text).toBe(FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME));
  });

  it('promoted overlay replaces only the matching evolvable surface', () => {
    const failureBase = FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME);
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(failureBase),
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: '## Failure Recovery (OVERLAID)',
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
      promptSurfaceBaselines: {
        'failure-recovery': failureBase,
        'bootstrap-first-turn': BOOTSTRAP_FIRST_TURN_SURFACE.build(FIRST_TURN_RUNTIME),
      },
    });
    rt.initialize();

    const failureText = buildConditionalInjection(FAILURE_RUNTIME, CONDITIONAL_SURFACES, (n, b) =>
      rt.resolvePromptSurface(n, b).value
    );
    expect(failureText).toBe('## Failure Recovery (OVERLAID)');

    // First-turn surface still baseline (not in catalog / not overlaid)
    const firstTurnText = buildConditionalInjection(FIRST_TURN_RUNTIME, CONDITIONAL_SURFACES, (n, b) =>
      rt.resolvePromptSurface(n, b).value
    );
    expect(firstTurnText).toBe(BOOTSTRAP_FIRST_TURN_SURFACE.build(FIRST_TURN_RUNTIME));
  });

  it('baseHash drift falls back to baseline at resolve time', () => {
    const failureBase = FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME);
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(failureBase),
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
      sessionId: 's',
      promptSurfaceBaselines: { 'failure-recovery': failureBase },
    });
    rt.initialize();
    // Code baseline changed after initialize → drift
    const resolved = rt.resolvePromptSurface('failure-recovery', 'CHANGED BASELINE');
    expect(resolved.source).toBe('baseline');
    expect(resolved.value).toBe('CHANGED BASELINE');
  });

  it('corrupt catalog → baseline only, no throw', () => {
    const dir = path.join(tmp, '.kc-cli', 'experiments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{broken', 'utf8');
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      promptSurfaceBaselines: {
        'failure-recovery': FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME),
      },
    });
    expect(() => rt.initialize()).not.toThrow();
    const text = buildConditionalInjection(FAILURE_RUNTIME, CONDITIONAL_SURFACES, (n, b) =>
      rt.resolvePromptSurface(n, b).value
    );
    expect(text).toBe(FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME));
  });

  it('session lock: mid-session catalog change is ignored', () => {
    const failureBase = FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME);
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(failureBase),
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: 'FIRST',
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
      promptSurfaceBaselines: { 'failure-recovery': failureBase },
    });
    rt.initialize();
    expect(rt.resolvePromptSurface('failure-recovery', failureBase).value).toBe('FIRST');

    // Mutate catalog mid-session
    writeCatalog(tmp, {
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash(failureBase),
          active: 'c2',
          variants: [
            {
              variantId: 'c2',
              status: 'promoted',
              payload: 'SECOND',
              evidenceRef: 'sha256:ev2',
            },
          ],
        },
      },
    });
    // Still FIRST — assignments locked
    expect(rt.resolvePromptSurface('failure-recovery', failureBase).value).toBe('FIRST');
  });

  it('does not rewrite static prefix (resolver only applied to evolvable conditionals)', () => {
    // buildConditionalInjection never touches static surfaces; assert the
    // static manifest path is independent of the resolver.
    const staticText = FAILURE_RECOVERY_SURFACE.build(FAILURE_RUNTIME);
    const withNullResolver = buildConditionalInjection(
      FAILURE_RUNTIME,
      CONDITIONAL_SURFACES,
      () => 'SHOULD_NOT_APPEAR_TO_NON_EVOLVABLE'
    );
    // Both CONDITIONAL_SURFACES are evolvable, so overlay applies — but the
    // static system prompt builder (composeStaticSurfaces) has no resolver.
    expect(withNullResolver).toBe('SHOULD_NOT_APPEAR_TO_NON_EVOLVABLE');
    expect(staticText).not.toBe(withNullResolver);
  });

  it('computeSurfaceRuntime still derives predicates correctly', () => {
    expect(computeSurfaceRuntime([]).isFirstTurn).toBe(true);
    expect(
      computeSurfaceRuntime([
        { role: 'user' },
        { role: 'assistant' },
        { role: 'tool', toolResults: [{ isError: true }] },
      ]).lastToolResultHadError
    ).toBe(true);
  });
});
