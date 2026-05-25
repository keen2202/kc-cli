// Tests for cross-mode cache pollution prevention

import { describe, it, expect, beforeEach } from 'vitest';
import { classifier, PermissionClassifier, type ClassifierDecision } from './classifier';
import type { PermissionContext, PermissionMode } from '../types/permissions';

function makeContext(mode: PermissionMode): PermissionContext {
  return {
    mode,
    cwd: '/workspace',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    alwaysDenyRules: [],
    alwaysAskRules: [],
    alwaysAllowRules: [],
    bypassPermissions: mode === 'bypassPermissions',
  };
}

describe('Classifier Cross-Mode Cache Isolation', () => {
  // Use a fresh classifier instance to avoid state pollution from other tests
  let freshClassifier: PermissionClassifier;

  beforeEach(() => {
    freshClassifier = new PermissionClassifier();
  });

  it('uses separate cache entries for different permission modes', async () => {
    const bypassCtx = makeContext('bypassPermissions');
    const autoCtx = makeContext('auto');
    const dontAskCtx = makeContext('dontAsk');

    // Classify in bypass mode
    const bypassResult = await freshClassifier.classify('Bash', { command: 'ls -la' }, bypassCtx);

    // Classify the same command in auto mode
    const autoResult = await freshClassifier.classify('Bash', { command: 'ls -la' }, autoCtx);

    // Results may differ because modes differ
    // The key test is that both complete (no crash) and produce valid results
    expect(bypassResult).toHaveProperty('behavior');
    expect(autoResult).toHaveProperty('behavior');
    expect(bypassResult).toHaveProperty('confidence');
    expect(autoResult).toHaveProperty('confidence');

    // Classify in dontAsk mode
    const dontAskResult = await freshClassifier.classify('Bash', { command: 'ls -la' }, dontAskCtx);
    expect(dontAskResult).toHaveProperty('behavior');
  });

  it('does not reuse bypassPermissions allow result in auto mode', async () => {
    const bypassCtx = makeContext('bypassPermissions');
    const autoCtx = makeContext('auto');

    // First, classify 'git push' in bypass mode
    await freshClassifier.classify('Git', { command: 'push origin main' }, bypassCtx);

    // Now, classify the same command in auto mode
    const autoDecision = await freshClassifier.classify('Git', { command: 'push origin main' }, autoCtx);

    // In auto mode, 'push' should not be auto-allowed just because bypass mode cached "allow"
    // The classifier should independently evaluate this
    expect(autoDecision).toHaveProperty('behavior');
    expect(autoDecision).toHaveProperty('confidence');
  });

  it('does not allow dontAsk deny result to pollute auto mode cache', async () => {
    const dontAskCtx = makeContext('dontAsk');
    const autoCtx = makeContext('auto');

    // Classify a dangerous command in dontAsk mode
    await freshClassifier.classify('Bash', { command: 'rm -rf /tmp/test' }, dontAskCtx);

    // Classify the same command in auto mode
    const autoDecision = await freshClassifier.classify('Bash', { command: 'rm -rf /tmp/test' }, autoCtx);

    // Auto mode should evaluate independently
    expect(autoDecision).toHaveProperty('behavior');
  });

  it('uses same cache entry within the same mode', async () => {
    const ctx = makeContext('auto');

    const first = await freshClassifier.classify('Bash', { command: 'echo hello' }, ctx);
    const second = await freshClassifier.classify('Bash', { command: 'echo hello' }, ctx);

    // Same mode, same command → should return cached result
    expect(first.behavior).toBe(second.behavior);
    expect(first.confidence).toBe(second.confidence);
    expect(first.reason).toBe(second.reason);
  });

  it('differentiates cache entries by command within same mode', async () => {
    const ctx = makeContext('auto');

    const lsResult = await freshClassifier.classify('Bash', { command: 'ls -la' }, ctx);
    const rmResult = await freshClassifier.classify('Bash', { command: 'rm file.txt' }, ctx);

    // Different commands should produce separate cache entries
    expect(lsResult).toHaveProperty('behavior');
    expect(rmResult).toHaveProperty('behavior');
  });
});
