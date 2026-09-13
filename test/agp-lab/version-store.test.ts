import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLabPaths } from '../../scripts/agp/lab-paths';
import { VersionStore } from '../../scripts/agp/version-store';
import { OverlayStore } from '../../scripts/agp/overlay-store';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-versions-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ART = 'prompt-surface:failure-recovery';

describe('agp-lab/version-store', () => {
  it('creates a root snapshot with null parent and sets it active', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    const snap = store.snapshot(ART, {
      variantId: 'cand-001',
      commitMessage: 'initial candidate',
      status: 'candidate',
    });

    expect(snap.variantId).toBe('cand-001');
    expect(snap.parentVariantId).toBeNull();
    expect(snap.branch).toBe('main');

    const active = store.getActive(ART);
    expect(active?.variantId).toBe('cand-001');
    expect(store.getParent(ART, 'cand-001')).toBeNull();
  });

  it('defaults parent to the current active variant', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, { variantId: 'cand-001' });
    const child = store.snapshot(ART, { variantId: 'cand-002' });

    expect(child.parentVariantId).toBe('cand-001');
    const parent = store.getParent(ART, 'cand-002');
    expect(parent?.variantId).toBe('cand-001');
  });

  it('persists lineage across store instances (file-backed)', () => {
    const paths = resolveLabPaths(tmp);
    const store = new VersionStore(paths);
    store.snapshot(ART, { variantId: 'cand-001' });
    store.snapshot(ART, { variantId: 'cand-002' });

    const reloaded = new VersionStore(paths);
    expect(reloaded.listVariants(ART).map(v => v.variantId)).toEqual([
      'cand-001',
      'cand-002',
    ]);
    expect(reloaded.getActive(ART)?.variantId).toBe('cand-002');
  });

  it('rejects duplicate variantId and unknown parent', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, { variantId: 'cand-001' });
    expect(() => store.snapshot(ART, { variantId: 'cand-001' })).toThrow(/already/);
    expect(() =>
      store.snapshot(ART, { variantId: 'cand-009', parentVariantId: 'ghost' })
    ).toThrow(/parent/);
  });

  it('branch creates a named lineage from a snapshot', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, { variantId: 'cand-001' });
    const branchSnap = store.branch(ART, 'cand-001', 'exp-a');

    expect(branchSnap.branch).toBe('exp-a');
    expect(branchSnap.parentVariantId).toBe('cand-001');
    expect(branchSnap.variantId).toBe('cand-001+exp-a');
    expect(store.getLineage(ART)?.branch).toBe('exp-a');
    expect(store.getActive(ART)?.variantId).toBe('cand-001+exp-a');

    expect(() => store.branch(ART, 'ghost', 'x')).toThrow(/unknown/);
    expect(() => store.branch(ART, 'cand-001', '')).toThrow(/branch name/);
  });

  it('diff reports changed lineage fields between two variants', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, {
      variantId: 'cand-001',
      commitMessage: 'first',
      status: 'candidate',
    });
    store.snapshot(ART, {
      variantId: 'cand-002',
      commitMessage: 'second',
      status: 'candidate',
    });

    const diff = store.diff(ART, 'cand-001', 'cand-002');
    expect(diff).not.toBeNull();
    expect(diff!.fromVariantId).toBe('cand-001');
    expect(diff!.toVariantId).toBe('cand-002');
    const fields = diff!.changes.map(c => c.field);
    expect(fields).toContain('parentVariantId');
    expect(fields).toContain('commitMessage');

    expect(store.diff(ART, 'cand-001', 'ghost')).toBeNull();
  });

  it('setActive moves the active pointer and rejects unknown targets', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, { variantId: 'cand-001' });
    store.snapshot(ART, { variantId: 'cand-002' });

    store.setActive(ART, 'cand-001');
    expect(store.getActive(ART)?.variantId).toBe('cand-001');
    expect(() => store.setActive(ART, 'nope')).toThrow(/unknown/);
  });

  it('stampStatus records status migration on the lineage snapshot', () => {
    const store = new VersionStore(resolveLabPaths(tmp));
    store.snapshot(ART, { variantId: 'cand-001', status: 'candidate' });

    store.stampStatus(ART, 'cand-001', 'promoted');
    expect(store.getSnapshot(ART, 'cand-001')?.status).toBe('promoted');

    store.stampStatus(ART, 'cand-001', 'retired');
    expect(store.getSnapshot(ART, 'cand-001')?.status).toBe('retired');

    expect(() => store.stampStatus(ART, 'ghost', 'promoted')).toThrow(/unknown/);
  });
});

describe('agp-lab/overlay-store status migration', () => {
  function makeOverlay() {
    const paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    overlays.putVariant({
      artifactId: ART,
      kind: 'prompt-surface',
      baseHash: 'sha256:base',
      baselineDescription: 'failure-recovery baseline',
      variantId: 'cand-001',
      payload: '## Failure Recovery\n…',
      evidenceRef: 'sha256:evidence-1',
    });
    return { paths, versions, overlays };
  }

  it('migrates candidate → promoted → retired', () => {
    const { overlays, versions } = makeOverlay();

    const toPromoted = overlays.setStatus(ART, 'cand-001', 'promoted', {
      promotedBy: 'tester',
      reason: 'gate accept',
    });
    expect(toPromoted.ok).toBe(true);
    if (toPromoted.ok) expect(toPromoted.variant.status).toBe('promoted');
    expect(versions.getSnapshot(ART, 'cand-001')?.status).toBe('promoted');

    const toRetired = overlays.setStatus(ART, 'cand-001', 'retired');
    expect(toRetired.ok).toBe(true);
    if (toRetired.ok) expect(toRetired.variant.status).toBe('retired');
  });

  it('migrates candidate → rejected and treats it as terminal', () => {
    const { overlays } = makeOverlay();
    expect(overlays.setStatus(ART, 'cand-001', 'rejected').ok).toBe(true);
    const back = overlays.setStatus(ART, 'cand-001', 'promoted');
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toMatch(/illegal status transition/);
  });

  it('rejects promoted → candidate (payload immutability)', () => {
    const { overlays } = makeOverlay();
    expect(overlays.setStatus(ART, 'cand-001', 'promoted').ok).toBe(true);
    const demote = overlays.setStatus(ART, 'cand-001', 'candidate');
    expect(demote.ok).toBe(false);
  });

  it('archive marks candidate retired; archive of rejected is refused', () => {
    const { overlays } = makeOverlay();
    const archived = overlays.archive(ART, 'cand-001');
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.variant.status).toBe('retired');

    overlays.putVariant({
      artifactId: ART,
      kind: 'prompt-surface',
      baseHash: 'sha256:base',
      baselineDescription: 'failure-recovery baseline',
      variantId: 'cand-002',
      payload: 'other',
      evidenceRef: 'sha256:evidence-2',
    });
    expect(overlays.setStatus(ART, 'cand-002', 'rejected').ok).toBe(true);
    expect(overlays.archive(ART, 'cand-002').ok).toBe(false);
  });

  it('unknown variant and unknown artifact return errors without throwing', () => {
    const { overlays } = makeOverlay();
    expect(overlays.setStatus(ART, 'ghost', 'promoted').ok).toBe(false);
    expect(overlays.setStatus('nope:artifact', 'cand-001', 'promoted').ok).toBe(false);
  });
});
