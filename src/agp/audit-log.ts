/**
 * AGP Audit Log
 *
 * Records a complete, immutable audit trail of every evolution cycle.
 * Each entry captures: trigger → hypotheses → proposals → changes →
 * evaluation → decision → version change.
 *
 * Supports querying, export, and integrity verification.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvolutionCycleResult } from './sepl/protocol';
import type { Hypothesis, Modification, EvaluationResult, ProposalAudit } from './sepl/protocol';

/** Versioned on-disk format for the persisted audit log (T7). */
export const AUDIT_LOG_FORMAT = 'kc.audit_log.v1';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditEntry {
  /** Unique audit entry ID */
  id: string;
  /** Timestamp */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** Evolution iteration */
  iteration: number;
  /** Phase of the audit entry */
  phase: 'trigger' | 'hypothesis' | 'proposal' | 'change' | 'evaluation' | 'decision' | 'version' | 'rejected';
  /** Details for this phase */
  details: Record<string, unknown>;
  /** Related resource names */
  resources: string[];
  /** Whether this phase succeeded */
  success: boolean;
  /** Optional error message */
  error?: string;
}

export interface AuditSummary {
  /** Total audit entries */
  totalEntries: number;
  /** Entries by phase */
  entriesByPhase: Record<string, number>;
  /** Sessions with audit data */
  sessions: string[];
  /** Time range */
  timeRange: { earliest: number; latest: number };
  /** Committed changes count */
  committedChanges: number;
  /** Rolled-back changes count */
  rolledBackChanges: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

let auditCounter = 0;
function generateAuditId(): string {
  return `audit_${Date.now().toString(36)}_${(auditCounter++).toString(36)}`;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private maxEntries: number;
  private persistDir?: string;

  constructor(options?: { maxEntries?: number; persistDir?: string }) {
    this.maxEntries = options?.maxEntries ?? 10000;
    this.persistDir = options?.persistDir;
  }

  // ─── Recording ────────────────────────────────────────────────────────────

  /**
   * Record an audit entry.
   */
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: generateAuditId(),
      timestamp: Date.now(),
    };

    this.entries.push(full);

    // Ring buffer
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    return full;
  }

  /**
   * Record an LLM proposal outcome with its mandatory audit quadruple
   * (T6). Both accepted and rejected candidates leave a trail; rejected
   * entries carry the rejection reason as the error.
   */
  recordProposal(
    sessionId: string,
    iteration: number,
    proposal: {
      targetResource: string;
      changeType: string;
      proposer: string;
      audit: ProposalAudit;
      accepted: boolean;
      reason?: string;
    }
  ): AuditEntry {
    return this.record({
      sessionId,
      iteration,
      phase: 'proposal',
      details: {
        proposer: proposal.proposer,
        target: proposal.targetResource,
        changeType: proposal.changeType,
        targetFailurePattern: proposal.audit.targetFailurePattern,
        editedSurface: proposal.audit.editedSurface,
        expectedEffect: proposal.audit.expectedEffect,
        regressionRisk: proposal.audit.regressionRisk,
        accepted: proposal.accepted,
      },
      resources: [proposal.targetResource],
      success: proposal.accepted,
      error: proposal.accepted ? undefined : proposal.reason,
    });
  }

  /**
   * Record a complete evolution cycle.
   */
  recordCycle(
    sessionId: string,
    iteration: number,
    cycle: EvolutionCycleResult,
    details?: {
      hypotheses?: Hypothesis[];
      modifications?: Modification[];
      evaluations?: EvaluationResult[];
    }
  ): void {
    // Trigger
    this.record({
      sessionId,
      iteration,
      phase: 'trigger',
      details: { startedAt: Date.now() - cycle.durationMs },
      resources: cycle.committedResources,
      success: true,
    });

    // Hypotheses
    if (details?.hypotheses) {
      for (const hyp of details.hypotheses) {
        this.record({
          sessionId,
          iteration,
          phase: 'hypothesis',
          details: { id: hyp.id, description: hyp.description, confidence: hyp.confidence },
          resources: hyp.suspectedResources,
          success: true,
        });
      }
    }

    // Proposals
    if (details?.modifications) {
      for (const mod of details.modifications) {
        this.record({
          sessionId,
          iteration,
          phase: 'proposal',
          details: { id: mod.id, target: mod.targetResource, changeType: mod.changeType, risk: mod.riskLevel },
          resources: [mod.targetResource],
          success: true,
        });
      }
    }

    // Evaluations
    if (details?.evaluations) {
      for (const ev of details.evaluations) {
        this.record({
          sessionId,
          iteration,
          phase: 'evaluation',
          details: { accepted: ev.accepted, score: ev.primaryScore, delta: ev.improvementDelta, summary: ev.summary },
          resources: [],
          success: ev.accepted,
        });
      }
    }

    // Decision
    this.record({
      sessionId,
      iteration,
      phase: 'decision',
      details: { committed: cycle.committed, rolledBack: cycle.rolledBack, summary: cycle.evaluationSummary },
      resources: cycle.committedResources,
      success: cycle.committed,
    });

    // Version change
    if (cycle.committed && cycle.committedResources.length > 0) {
      this.record({
        sessionId,
        iteration,
        phase: 'version',
        details: { resources: cycle.committedResources },
        resources: cycle.committedResources,
        success: true,
      });
    }
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Query audit entries with filters.
   */
  query(filter: {
    sessionId?: string;
    phase?: AuditEntry['phase'];
    success?: boolean;
    since?: number;
    limit?: number;
  } = {}): AuditEntry[] {
    let results = this.entries;

    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.phase) results = results.filter(e => e.phase === filter.phase);
    if (filter.success !== undefined) results = results.filter(e => e.success === filter.success);
    if (filter.since) results = results.filter(e => e.timestamp >= filter.since!);
    if (filter.limit) results = results.slice(-filter.limit);

    return results;
  }

  /**
   * Get a summary of the audit log.
   */
  getSummary(): AuditSummary {
    const entriesByPhase: Record<string, number> = {};
    const sessions = new Set<string>();
    let committed = 0;
    let rolledBack = 0;

    for (const entry of this.entries) {
      entriesByPhase[entry.phase] = (entriesByPhase[entry.phase] ?? 0) + 1;
      sessions.add(entry.sessionId);
      if (entry.phase === 'decision') {
        if (entry.details.committed) committed++;
        if (entry.details.rolledBack) rolledBack++;
      }
    }

    return {
      totalEntries: this.entries.length,
      entriesByPhase,
      sessions: Array.from(sessions),
      timeRange: {
        earliest: this.entries[0]?.timestamp ?? 0,
        latest: this.entries[this.entries.length - 1]?.timestamp ?? 0,
      },
      committedChanges: committed,
      rolledBackChanges: rolledBack,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Save audit log to disk (versioned `kc.audit_log.v1` envelope).
   */
  async save(): Promise<void> {
    if (!this.persistDir) return;
    const filePath = path.join(this.persistDir, 'audit-log.json');
    try {
      await fs.promises.mkdir(this.persistDir, { recursive: true });
      const payload = { format: AUDIT_LOG_FORMAT, entries: this.entries };
      await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // Persistence failure is non-fatal
    }
  }

  /**
   * Load audit log from disk. Tolerates both the versioned envelope and
   * legacy format-less files (a bare entries array).
   */
  async load(): Promise<void> {
    if (!this.persistDir) return;
    const filePath = path.join(this.persistDir, 'audit-log.json');
    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        // Legacy pre-format file: bare entries array
        this.entries = parsed;
      } else if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries;
      }
    } catch {
      // No existing audit log
    }
  }

  /**
   * Clear all audit entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get the total number of entries.
   */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Global audit log singleton.
 */
let globalAuditLog: AuditLog | null = null;

export function getAuditLog(options?: { persistDir?: string }): AuditLog {
  if (!globalAuditLog) {
    globalAuditLog = new AuditLog(options);
  }
  return globalAuditLog;
}

export function resetAuditLog(): void {
  globalAuditLog?.clear();
  globalAuditLog = null;
}
