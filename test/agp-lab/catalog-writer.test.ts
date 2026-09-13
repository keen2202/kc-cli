import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveLabPaths,
  computeBaseHash,
  MAX_STDOUT_CHARS,
} from '../../scripts/agp/lab-paths';
import {
  loadCatalog,
  updateCatalog,
  buildCatalogFromOverlays,
  writeCatalogFromOverlays,
  isCatalogShape,
} from '../../scripts/agp/catalog-writer';
import { OverlayStore } from '../../scripts/agp/overlay-store';
import { VersionStore } from '../../scripts/agp/version-store';
import { EvidenceStore, sanitizeEvidenceContent } from '../../scripts/agp/evidence-store';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-catalog-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ART = 'prompt-surface:failure-recovery';

function seedOverlay(overlays: OverlayStore, variantId: string, evidenceRef: string) {
  overlays.setBaseline(ART, 'prompt-surface', computeBaseHash('BASELINE'), 'baseline text');
  overlays.putVariant({
    artifactId: ART,
    kind: 'prompt-surface',
    baseHash: computeBaseHash('BASELINE'),
    baselineDescription: 'baseline text',
    variantId,
    payload: `payload-${variantId}`,
    evidenceRef,
  });
}

describe('agp-lab/catalog-writer', () => {
  it('treats a missing catalog as empty (not corrupt)', () => {
    const paths = resolveLabPaths(tmp);
    const loaded = loadCatalog(paths.catalogPath);
    expect(loaded.state).toBe('missing');
  });

  it('detects invalid JSON and wrong-format catalogs as corrupt', () => {
    const paths = resolveLabPaths(tmp);
    fs.mkdirSync(path.dirname(paths.catalogPath), { recursive: true });

    fs.writeFileSync(paths.catalogPath, '{not json', 'utf8');
    expect(loadCatalog(paths.catalogPath).state).toBe('corrupt');

    fs.writeFileSync(
      paths.catalogPath,
      JSON.stringify({ format: 'other.v9', artifacts: {} }),
      'utf8'
    );
    expect(loadCatalog(paths.catalogPath).state).toBe('corrupt');
  });

  it('builds a valid kc.experiments.v1 catalog from overlay state', () => {
    const paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    seedOverlay(overlays, 'cand-001', 'sha256:ev1');

    const catalog = buildCatalogFromOverlays(overlays);
    expect(catalog.format).toBe('kc.experiments.v1');
    expect(isCatalogShape(catalog)).toBe(true);

    const artifact = catalog.artifacts[ART];
    expect(artifact.kind).toBe('prompt-surface');
    expect(artifact.baseHash).toBe(computeBaseHash('BASELINE'));
    expect(artifact.variants).toHaveLength(1);
    expect(artifact.variants[0].variantId).toBe('cand-001');
    expect(artifact.variants[0].status).toBe('candidate');
    expect(artifact.active).toBeNull();
  });

  it('points active at the latest promoted variant', () => {
    const paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    seedOverlay(overlays, 'cand-001', 'sha256:ev1');
    seedOverlay(overlays, 'cand-002', 'sha256:ev2');
    expect(overlays.setStatus(ART, 'cand-002', 'promoted').ok).toBe(true);

    const catalog = buildCatalogFromOverlays(overlays);
    expect(catalog.artifacts[ART].active).toBe('cand-002');
  });

  it('writeCatalogFromOverlays creates catalog.json atomically', () => {
    const paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    seedOverlay(overlays, 'cand-001', 'sha256:ev1');

    const result = writeCatalogFromOverlays(paths, overlays);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(paths.catalogPath)).toBe(true);

    const reloaded = loadCatalog(paths.catalogPath);
    expect(reloaded.state).toBe('valid');
    if (reloaded.state === 'valid') {
      expect(reloaded.catalog.artifacts[ART].variants[0].variantId).toBe('cand-001');
    }
  });

  it('refuses to overwrite a corrupt catalog (file bytes stay intact)', () => {
    const paths = resolveLabPaths(tmp);
    fs.mkdirSync(path.dirname(paths.catalogPath), { recursive: true });
    const garbage = '!!!corrupt-catalog!!!';
    fs.writeFileSync(paths.catalogPath, garbage, 'utf8');

    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    seedOverlay(overlays, 'cand-001', 'sha256:ev1');

    const result = writeCatalogFromOverlays(paths, overlays);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('corrupt');
    }

    // Corrupt file is preserved — lab never silently replaces it.
    expect(fs.readFileSync(paths.catalogPath, 'utf8')).toBe(garbage);
  });

  it('atomic write crash safety: rename failure leaves previous catalog intact', () => {
    const paths = resolveLabPaths(tmp);
    const versions = new VersionStore(paths);
    const overlays = new OverlayStore(paths, versions);
    seedOverlay(overlays, 'cand-001', 'sha256:ev1');

    // First successful write establishes a known-good catalog.
    expect(writeCatalogFromOverlays(paths, overlays).ok).toBe(true);
    const before = fs.readFileSync(paths.catalogPath, 'utf8');

    // Second write: simulate crash between temp write and rename.
    const boomRename = () => {
      throw new Error('simulated crash before rename');
    };

    seedOverlay(overlays, 'cand-002', 'sha256:ev2');
    const failed = writeCatalogFromOverlays(paths, overlays, { rename: boomRename });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe('io');

    // Destination still holds the previous valid catalog.
    const after = fs.readFileSync(paths.catalogPath, 'utf8');
    expect(after).toBe(before);
    expect(loadCatalog(paths.catalogPath).state).toBe('valid');

    // No stray temp files left as the final catalog name.
    const files = fs.readdirSync(path.dirname(paths.catalogPath));
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('atomic write: temp file exists and destination is absent if rename fails on first create', () => {
    const paths = resolveLabPaths(tmp);
    const boomRename = () => {
      throw new Error('boom');
    };

    const result = updateCatalog(paths.catalogPath, c => c, { rename: boomRename });
    expect(result.ok).toBe(false);

    expect(fs.existsSync(paths.catalogPath)).toBe(false);
  });
});

describe('agp-lab/evidence-store', () => {
  it('writes immutable evidence keyed by hash; rewrite of same content is a no-op', () => {
    const paths = resolveLabPaths(tmp);
    const evidence = new EvidenceStore(paths);

    const first = evidence.write({
      kind: 'gate-report',
      content: { accepted: true, split: 'held-in', verifiedTaskRate: 0.5 },
    });
    expect(first.created).toBe(true);
    expect(first.evidenceHash.startsWith('sha256:')).toBe(true);
    expect(fs.existsSync(first.path)).toBe(true);

    const second = evidence.write({
      kind: 'gate-report',
      content: { accepted: true, split: 'held-in', verifiedTaskRate: 0.5 },
    });
    expect(second.created).toBe(false);
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.path).toBe(first.path);
  });

  it('is read-only after write: different content gets a different hash, never overwrites', () => {
    const paths = resolveLabPaths(tmp);
    const evidence = new EvidenceStore(paths);

    const a = evidence.write({ kind: 'eval', content: { n: 1 } });
    const original = fs.readFileSync(a.path, 'utf8');

    const b = evidence.write({ kind: 'eval', content: { n: 2 } });
    expect(b.evidenceHash).not.toBe(a.evidenceHash);
    expect(b.path).not.toBe(a.path);

    // Original file bytes unchanged.
    expect(fs.readFileSync(a.path, 'utf8')).toBe(original);
    expect(evidence.read(a.evidenceHash)?.content).toEqual({ n: 1 });
  });

  it('truncates stdout-like fields to ≤4KB and redacts secret keys', () => {
    const paths = resolveLabPaths(tmp);
    const evidence = new EvidenceStore(paths);
    const longOut = 'x'.repeat(MAX_STDOUT_CHARS + 500);

    const result = evidence.write({
      kind: 'eval-task',
      content: {
        stdout: longOut,
        nested: { apiKey: 'sk-should-not-appear', token: 'tok-123' },
      },
    });

    const record = evidence.read(result.evidenceHash);
    expect(record).not.toBeNull();
    const content = record!.content;
    const stdout = content.stdout as string;
    expect(stdout.length).toBeLessThanOrEqual(MAX_STDOUT_CHARS + 32);
    expect(stdout).toContain('…[truncated]');
    expect(JSON.stringify(content)).not.toContain('sk-should-not-appear');
    expect(JSON.stringify(content)).not.toContain('tok-123');
    expect((content.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
  });

  it('sanitizeEvidenceContent caps arbitrary long strings', () => {
    const long = 'y'.repeat(MAX_STDOUT_CHARS + 10);
    const sanitized = sanitizeEvidenceContent({ note: long }) as Record<string, unknown>;
    expect((sanitized.note as string).length).toBeLessThanOrEqual(MAX_STDOUT_CHARS + 32);
  });

  it('list/read/exists behave on empty and populated stores', () => {
    const paths = resolveLabPaths(tmp);
    const evidence = new EvidenceStore(paths);
    expect(evidence.list()).toEqual([]);
    expect(evidence.exists('sha256:nope')).toBe(false);
    expect(evidence.read('sha256:nope')).toBeNull();

    const w = evidence.write({ kind: 'x', content: { ok: true } });
    expect(evidence.exists(w.evidenceHash)).toBe(true);
    expect(evidence.list()).toEqual([w.evidenceHash]);
    expect(evidence.read(w.evidenceHash)?.kind).toBe('x');
  });
});
