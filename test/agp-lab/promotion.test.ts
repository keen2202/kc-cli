import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLabPaths } from '../../scripts/agp/lab-paths';
import { VersionStore } from '../../scripts/agp/version-store';
import { OverlayStore } from '../../scripts/agp/overlay-store';
import { EvidenceStore } from '../../scripts/agp/evidence-store';
import {
  promoteVariant,
  rollbackActive,
  tryAcquirePromoteLock,
  releasePromoteLock,
} from '../../scripts/agp/promotion';
import { DecisionLog } from '../../scripts/agp/decision-log';
import { loadCatalog } from '../../scripts/agp/catalog-writer';

describe('agp-lab/promotion', () => {
  let tmp: string;
  let paths: ReturnType<typeof resolveLabPaths>;
  let overlays: OverlayStore;
  let evidence: EvidenceStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-promo-'));
    paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    overlays = new OverlayStore(paths, versions);
    evidence = new EvidenceStore(paths);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedCandidate(variantId: string, evidenceRef: string, accept: boolean): void {
    const written = evidence.write({
      kind: 'gate-report',
      content: {
        format: 'kc.agp.gate_report.v1',
        gate: { accept, outcome: accept ? 'accept' : 'reject' },
      },
    });
    // Use the actual hash when caller passed a placeholder.
    const ref = evidenceRef === 'auto' ? written.evidenceHash : evidenceRef;
    overlays.putVariant({
      artifactId: 'prompt-surface:failure-recovery',
      kind: 'prompt-surface',
      baseHash: 'sha256:base',
      baselineDescription: 'BASE',
      variantId,
      payload: 'NEW TEXT',
      evidenceRef: ref,
    });
  }

  it('rejects promote without confirmation', () => {
    seedCandidate('c1', 'auto', true);
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'test',
      confirmed: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('confirmation');
  });

  it('rejects promote without evidence', () => {
    overlays.putVariant({
      artifactId: 'prompt-surface:failure-recovery',
      kind: 'prompt-surface',
      baseHash: 'sha256:base',
      baselineDescription: 'BASE',
      variantId: 'c1',
      payload: 'X',
      evidenceRef: 'sha256:missing',
    });
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'test',
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('evidence not found');
  });

  it('rejects promote when gate rejected the candidate', () => {
    seedCandidate('c1', 'auto', false);
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'test',
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('gate rejected');
  });

  it('promotes a candidate with accepted gate evidence and updates catalog', () => {
    seedCandidate('c1', 'auto', true);
    const result = promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'improved recovery',
      confirmed: true,
    });
    expect(result.ok).toBe(true);

    const catalog = loadCatalog(paths.catalogPath);
    expect(catalog.state).toBe('valid');
    if (catalog.state === 'valid') {
      const artifact = catalog.catalog.artifacts['prompt-surface:failure-recovery'];
      expect(artifact?.active).toBe('c1');
    }

    const decisions = new DecisionLog(paths).list();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('promote');
    expect(decisions[0].newActive).toBe('c1');
  });

  it('rollback retires current and falls back to baseline when no previous', () => {
    seedCandidate('c1', 'auto', true);
    promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'ok',
      confirmed: true,
    });

    const result = rollbackActive(paths, overlays, {
      artifactId: 'prompt-surface:failure-recovery',
      operator: 'tester',
      reason: 'regression',
      confirmed: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newActive).toBeNull();
      expect(result.previousActive).toBe('c1');
    }

    const catalog = loadCatalog(paths.catalogPath);
    if (catalog.state === 'valid') {
      expect(catalog.catalog.artifacts['prompt-surface:failure-recovery']?.active).toBeNull();
    }
  });

  it('rollback moves to previous promoted when one exists', () => {
    seedCandidate('c1', 'auto', true);
    promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'v1',
      confirmed: true,
    });
    seedCandidate('c2', 'auto', true);
    promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c2',
      operator: 'tester',
      reason: 'v2',
      confirmed: true,
    });

    const result = rollbackActive(paths, overlays, {
      artifactId: 'prompt-surface:failure-recovery',
      operator: 'tester',
      reason: 'v2 bad',
      confirmed: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newActive).toBe('c1');
  });

  it('decision log is append-only across multiple actions', () => {
    seedCandidate('c1', 'auto', true);
    promoteVariant(paths, overlays, evidence, {
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'c1',
      operator: 'tester',
      reason: 'ok',
      confirmed: true,
    });
    rollbackActive(paths, overlays, {
      artifactId: 'prompt-surface:failure-recovery',
      operator: 'tester',
      reason: 'undo',
      confirmed: true,
    });
    const decisions = new DecisionLog(paths).list();
    expect(decisions.map(d => d.action)).toEqual(['promote', 'rollback']);
  });

  it('concurrent promote lock: only one winner', () => {
    const a = tryAcquirePromoteLock(paths);
    expect(a.ok).toBe(true);
    const b = tryAcquirePromoteLock(paths);
    expect(b.ok).toBe(false);
    releasePromoteLock(a.lockPath);
    const c = tryAcquirePromoteLock(paths);
    expect(c.ok).toBe(true);
    releasePromoteLock(c.lockPath);
  });
});
