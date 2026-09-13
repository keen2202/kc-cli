import { describe, it, expect } from 'vitest';
import {
  createNoopExperimentRuntime,
  type RuntimePolicyOverlay,
} from '../../src/experiments/protocol';

describe('experiments/protocol', () => {
  it('noop runtime always returns baseline and empty assignments', async () => {
    const rt = createNoopExperimentRuntime();
    rt.initialize();
    expect(rt.getAssignments()).toEqual([]);

    const surface = rt.resolvePromptSurface('failure-recovery', 'BASE TEXT');
    expect(surface.source).toBe('baseline');
    expect(surface.value).toBe('BASE TEXT');
    expect(surface.variantId).toBeNull();

    const baselinePolicy: RuntimePolicyOverlay = { maxSameCallRetries: 2 };
    const policy = rt.resolveRuntimePolicy(baselinePolicy);
    expect(policy.source).toBe('baseline');
    expect(policy.value).toBe(baselinePolicy);

    await expect(
      rt.recordRunOutcome({
        runId: 'r1',
        sessionId: 's1',
        artifactAssignments: [],
        success: true,
        verified: false,
        patchFiles: [],
        turns: 0,
        noPatch: true,
        timestamp: Date.now(),
      })
    ).resolves.toBeUndefined();
  });
});
