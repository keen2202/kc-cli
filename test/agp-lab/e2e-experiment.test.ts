/**
 * T8 integration — full offline pipeline: candidate → evaluate → gate → promote → catalog → rollback.
 * Uses a temp lab root so the developer's real .kc-cli/experiments is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runFailureRecoveryE2e } from '../../scripts/agp/e2e';
import { resolveLabPaths } from '../../scripts/agp/lab-paths';
import { VersionStore } from '../../scripts/agp/version-store';
import { OverlayStore } from '../../scripts/agp/overlay-store';
import { EvidenceStore } from '../../scripts/agp/evidence-store';
import { rollbackActive } from '../../scripts/agp/promotion';
import { loadCatalog } from '../../scripts/agp/catalog-writer';
import { DecisionLog } from '../../scripts/agp/decision-log';

describe('agp-lab/e2e-experiment', () => {
  let tmp: string;
  let labRoot: string;
  let runsRoot: string;
  let workDirParent: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-agp-e2e-'));
    labRoot = path.join(tmp, 'lab');
    runsRoot = path.join(tmp, 'eval-runs');
    workDirParent = path.join(tmp, 'workspaces');
    fs.mkdirSync(labRoot, { recursive: true });
    fs.mkdirSync(runsRoot, { recursive: true });
    fs.mkdirSync(workDirParent, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('promotes failure-recovery-001 through mock gate and exposes catalog active', async () => {
    const result = await runFailureRecoveryE2e({
      labRoot,
      runsRoot,
      workDirParent,
      repeats: 3,
      operator: 'e2e-test',
    });

    expect(result.gate.outcome).toBe('accept');
    expect(result.gate.accept).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.catalogActive).toBe('failure-recovery-001');

    // held-in improves 2/3 → 3/3; held-out stays 1.0
    expect(result.heldIn.baseline.verifiedTaskRate).toBeCloseTo(2 / 3, 4);
    expect(result.heldIn.candidate.verifiedTaskRate).toBeCloseTo(1, 4);
    expect(result.heldOut.baseline.verifiedTaskRate).toBeCloseTo(1, 4);
    expect(result.heldOut.candidate.verifiedTaskRate).toBeCloseTo(1, 4);

    // no-patch rate drops on held-in
    expect(result.heldIn.candidate.noPatchRate).toBeLessThan(
      result.heldIn.baseline.noPatchRate
    );
    expect(result.gate.deltas.heldIn.verifiedTaskRate).toBeGreaterThan(0);

    // evidence is immutable and readable
    const paths = resolveLabPaths(labRoot);
    const evidence = new EvidenceStore(paths);
    expect(evidence.exists(result.evidenceRef)).toBe(true);
    const record = evidence.read(result.evidenceRef);
    expect(record?.kind).toBe('gate-report');
    expect((record?.content.gate as { accept?: boolean })?.accept).toBe(true);

    // decisions log has promote
    const decisions = new DecisionLog(paths).list();
    expect(decisions.some(d => d.action === 'promote')).toBe(true);

    // catalog shape
    const catalog = loadCatalog(paths.catalogPath);
    expect(catalog.state).toBe('valid');
    if (catalog.state === 'valid') {
      const artifact = catalog.catalog.artifacts['prompt-surface:failure-recovery'];
      expect(artifact?.active).toBe('failure-recovery-001');
      expect(artifact?.variants.some(v => v.status === 'promoted')).toBe(true);
    }
  }, 120_000);

  it('rollback after e2e promote returns catalog active to baseline', async () => {
    const result = await runFailureRecoveryE2e({
      labRoot,
      runsRoot,
      workDirParent,
      repeats: 3,
    });
    expect(result.promoted).toBe(true);

    const paths = resolveLabPaths(labRoot);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    const rollback = rollbackActive(paths, overlays, {
      artifactId: 'prompt-surface:failure-recovery',
      operator: 'e2e-test',
      reason: 'post-demo rollback',
      confirmed: true,
    });
    expect(rollback.ok).toBe(true);

    const catalog = loadCatalog(paths.catalogPath);
    if (catalog.state === 'valid') {
      expect(
        catalog.catalog.artifacts['prompt-surface:failure-recovery']?.active
      ).toBeNull();
    }
  }, 120_000);

  it('promote=false leaves candidate status and does not write catalog active', async () => {
    const result = await runFailureRecoveryE2e({
      labRoot,
      runsRoot,
      workDirParent,
      repeats: 3,
      promote: false,
    });
    expect(result.gate.accept).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.catalogActive).toBeNull();

    const paths = resolveLabPaths(labRoot);
    const overlays = new OverlayStore(paths, new VersionStore(paths));
    const variant = overlays.getVariant(
      'prompt-surface:failure-recovery',
      'failure-recovery-001'
    );
    expect(variant?.status).toBe('candidate');
  }, 120_000);
});
