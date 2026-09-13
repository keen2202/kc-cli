/**
 * Evidence-bound promotion / rollback for the offline AGP lab (T7).
 *
 * Promote is allowed only when:
 *  - the variant is a candidate
 *  - evidenceRef exists and is readable
 *  - the evidence record is a gate-report with accept=true
 *  - caller passed --yes (enforced by CLI)
 *
 * Rollback moves active to the previous promoted variant, or baseline (null).
 */

import * as fs from 'fs';
import { type LabPaths } from './lab-paths';
import { EvidenceStore } from './evidence-store';
import { OverlayStore, type OverlayVariant } from './overlay-store';
import { writeCatalogFromOverlays } from './catalog-writer';
import { DecisionLog } from './decision-log';

export type PromoteResult =
  | { ok: true; variant: OverlayVariant; evidenceRef: string }
  | { ok: false; reason: string };

export type RollbackResult =
  | { ok: true; newActive: string | null; previousActive: string | null }
  | { ok: false; reason: string };

function isAcceptedGateReport(
  evidence: EvidenceStore,
  evidenceRef: string
): { ok: boolean; reason: string } {
  if (!evidenceRef) {
    return { ok: false, reason: 'variant has empty evidenceRef' };
  }
  if (!evidence.exists(evidenceRef)) {
    return { ok: false, reason: `evidence not found: ${evidenceRef}` };
  }
  const record = evidence.read(evidenceRef);
  if (!record) {
    return { ok: false, reason: `evidence unreadable: ${evidenceRef}` };
  }
  const gate = record.content.gate as { accept?: boolean; outcome?: string } | undefined;
  if (!gate || typeof gate.accept !== 'boolean') {
    return { ok: false, reason: 'evidence is not a gate-report (missing gate.accept)' };
  }
  if (!gate.accept) {
    return { ok: false, reason: `gate rejected candidate (outcome=${gate.outcome ?? 'reject'})` };
  }
  return { ok: true, reason: 'ok' };
}

export interface PromoteOptions {
  artifactId: string;
  variantId: string;
  operator: string;
  reason: string;
  /** Must be true — CLI requires --yes. */
  confirmed: boolean;
}

export function promoteVariant(
  paths: LabPaths,
  overlays: OverlayStore,
  evidence: EvidenceStore,
  options: PromoteOptions
): PromoteResult {
  if (!options.confirmed) {
    return { ok: false, reason: 'promote requires explicit confirmation (--yes)' };
  }

  const variant = overlays.getVariant(options.artifactId, options.variantId);
  if (!variant) {
    return { ok: false, reason: `unknown variant ${options.artifactId}/${options.variantId}` };
  }
  if (variant.status !== 'candidate') {
    return { ok: false, reason: `variant status is ${variant.status}; only candidates can be promoted` };
  }

  const gateCheck = isAcceptedGateReport(evidence, variant.evidenceRef);
  if (!gateCheck.ok) {
    return { ok: false, reason: gateCheck.reason };
  }

  const stamped = overlays.setStatus(options.artifactId, options.variantId, 'promoted', {
    promotedBy: options.operator,
    promotedAt: Date.now(),
    reason: options.reason,
  });
  if (!stamped.ok) {
    return { ok: false, reason: stamped.reason };
  }

  // Rebuild catalog so active points at the newly promoted variant.
  const write = writeCatalogFromOverlays(paths, overlays);
  if (!write.ok) {
    // Status is already promoted — surface catalog failure loudly.
    return { ok: false, reason: `promoted but catalog write failed: ${write.message}` };
  }

  const log = new DecisionLog(paths);
  log.append({
    action: 'promote',
    artifactId: options.artifactId,
    variantId: options.variantId,
    previousActive: null,
    newActive: options.variantId,
    evidenceRef: variant.evidenceRef,
    operator: options.operator,
    reason: options.reason,
    timestamp: Date.now(),
  });

  return { ok: true, variant: stamped.variant, evidenceRef: variant.evidenceRef };
}

/**
 * Roll active back to the previous promoted variant (not retired/rejected).
 * With no previous promoted variant, active becomes null (baseline).
 */
export function rollbackActive(
  paths: LabPaths,
  overlays: OverlayStore,
  options: { artifactId: string; operator: string; reason: string; confirmed: boolean }
): RollbackResult {
  if (!options.confirmed) {
    return { ok: false, reason: 'rollback requires explicit confirmation (--yes)' };
  }

  const variants = overlays.listVariants(options.artifactId);
  const promoted = variants.filter(v => v.status === 'promoted');
  if (promoted.length === 0) {
    return { ok: false, reason: `no promoted variant on ${options.artifactId}` };
  }

  const current = promoted[promoted.length - 1];
  // Previous promoted = last promoted that is not the current one.
  const previous = promoted.length >= 2 ? promoted[promoted.length - 2] : null;

  // Retire current so catalog active falls to previous (or null).
  const retired = overlays.setStatus(options.artifactId, current.variantId, 'retired', {
    reason: options.reason || 'rollback',
    promotedBy: options.operator,
  });
  if (!retired.ok) {
    return { ok: false, reason: retired.reason };
  }

  const write = writeCatalogFromOverlays(paths, overlays);
  if (!write.ok) {
    return { ok: false, reason: `catalog write failed after rollback: ${write.message}` };
  }

  const newActive = previous ? previous.variantId : null;
  const log = new DecisionLog(paths);
  log.append({
    action: 'rollback',
    artifactId: options.artifactId,
    variantId: current.variantId,
    previousActive: current.variantId,
    newActive,
    evidenceRef: current.evidenceRef,
    operator: options.operator,
    reason: options.reason || 'rollback',
    timestamp: Date.now(),
  });

  return { ok: true, newActive, previousActive: current.variantId };
}

/** True when a lock file can be created (simple exclusive create). */
export function tryAcquirePromoteLock(paths: LabPaths): { ok: boolean; lockPath: string } {
  const lockPath = `${paths.catalogPath}.lock`;
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { ok: true, lockPath };
  } catch {
    return { ok: false, lockPath };
  }
}

export function releasePromoteLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}
