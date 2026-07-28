// Tests for T7: candidate lineage completion + versioned data contracts.
// Covers the 'rejected' audit phase (CommitOperator rejection paths),
// VersionManager.mergeAccepted, and format-versioned persistence with
// tolerant loading of legacy format-less files.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog, AUDIT_LOG_FORMAT } from '../../src/agp/audit-log';
import { VersionManager } from '../../src/agp/version-manager';
import { CommitOperator } from '../../src/agp/sepl/commit';
import { DynamicManager, AGP_STATE_FORMAT } from '../../src/agp/dynamic-manager';
import type { ServerInterface } from '../../src/agp/server-interface';
import type { ResourceRegistrationRecord } from '../../src/agp/protocol';
import type {
  EvaluationSpace,
  EvolvableState,
  GateDecision,
} from '../../src/agp/sepl/protocol';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const stubServer = { restore() {}, set_variables() {} } as unknown as ServerInterface;

function emptyState(): EvolvableState {
  return { variables: new Map(), trainableSubset: [] };
}

function makeEvalSpace(overrides: Partial<EvaluationSpace> = {}): EvaluationSpace {
  return {
    results: [
      {
        accepted: false,
        primaryScore: 0.4,
        metricScores: {},
        safetyPassed: true,
        failedConstraints: [],
        improvementDelta: -0.1,
        summary: 'candidate 1 on Agent:coder',
      },
    ],
    baseline: {},
    bestCandidateIndex: -1,
    ...overrides,
  };
}

function rejectDecision(reason: string): GateDecision {
  return {
    format: 'kc.acceptance_gate.v1',
    rule: 'Δin ≥ 0 && Δho ≥ 0 && max > 0',
    splits: [],
    decision: 'reject',
    reason,
    evaluatedAt: Date.now(),
  };
}

function makeRecord(
  description: string,
  params: Record<string, unknown>,
  version = '1.0.0'
): ResourceRegistrationRecord {
  return {
    entity: {
      name: 'coder',
      description,
      ioMapping: {},
      evolvability: 1,
      metadata: {} as never,
    },
    version,
    implementationDescriptor: 'sepl/evolved/Agent:coder',
    instantiationParams: params,
    exportedRepresentations: [],
  };
}

// ─── Rejected-candidate lineage ──────────────────────────────────────────────

describe('CommitOperator rejected-candidate audit (T7)', () => {
  it('records a rejected entry with the gate reason on gate rejection', async () => {
    const auditLog = new AuditLog();
    const operator = new CommitOperator(
      stubServer,
      new VersionManager(),
      false,
      { enabled: true },
      auditLog
    );
    operator.setAuditContext({ sessionId: 's7', iteration: 3 });
    operator.setGateDecision(rejectDecision('held_out regression: Δho = -0.33'));

    const result = await operator.execute(emptyState(), makeEvalSpace());

    expect(result.output.accepted).toBe(false);
    const rejected = auditLog.query({ phase: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].sessionId).toBe('s7');
    expect(rejected[0].iteration).toBe(3);
    expect(String(rejected[0].details.reason)).toContain('held_out regression');
    // Candidate lineage preserved without changing the active harness
    const candidates = rejected[0].details.candidates as Array<{ summary: string }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].summary).toContain('candidate 1');
  });

  it('records a rejected entry when no candidates pass heuristic evaluation', async () => {
    const auditLog = new AuditLog();
    const operator = new CommitOperator(stubServer, new VersionManager(), false, undefined, auditLog);

    const result = await operator.execute(emptyState(), makeEvalSpace());

    expect(result.output.accepted).toBe(false);
    const rejected = auditLog.query({ phase: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].details.reason).toBe('No candidates passed evaluation');
  });

  it('records no rejected entry when a candidate is committed', async () => {
    const auditLog = new AuditLog();
    const operator = new CommitOperator(stubServer, new VersionManager(), false, undefined, auditLog);

    const space = makeEvalSpace({
      results: [
        {
          accepted: true,
          primaryScore: 0.9,
          metricScores: {},
          safetyPassed: true,
          failedConstraints: [],
          improvementDelta: 0.2,
          summary: 'improvement on Agent:coder',
        },
      ],
      bestCandidateIndex: 0,
    });
    const result = await operator.execute(emptyState(), space);

    expect(result.output.accepted).toBe(true);
    expect(auditLog.query({ phase: 'rejected' })).toHaveLength(0);
  });
});

// ─── Merge-accepted semantics ────────────────────────────────────────────────

describe('VersionManager.mergeAccepted (T7)', () => {
  it('merges multiple accepted edits into a single lineage node with a correct diff', () => {
    const versions = new VersionManager();
    versions.createSnapshot(makeRecord('base prompt', { temperature: 0.5 }), {
      resourceType: 'Agent',
    });
    expect(versions.getLineage('Agent', 'coder')).toHaveLength(1);

    const snapshot = versions.mergeAccepted(
      'Agent',
      'coder',
      [
        makeRecord('edit A', { temperature: 0.7 }, '1.0.1'),
        makeRecord('edit B', { temperature: 0.7, maxTokens: 2048 }, '1.0.2'),
      ],
      'MergeAccepted: candidates [mod-a, mod-b]'
    );

    expect(snapshot).not.toBeNull();
    // Exactly one new lineage node for the whole round
    const lineage = versions.getLineage('Agent', 'coder');
    expect(lineage).toHaveLength(2);
    expect(lineage[1].commitMessage).toContain('mod-a, mod-b');
    // Later edits win on params; both accepted params are present
    expect(snapshot!.record.instantiationParams).toEqual({ temperature: 0.7, maxTokens: 2048 });
    // Diff between base and merged version reflects the combined change
    const diff = versions.diff('Agent', 'coder', '1.0.0', snapshot!.version);
    expect(diff).not.toBeNull();
    expect(diff!.changes.some(c => c.field === 'description' && c.newValue === 'edit B')).toBe(true);
  });

  it('returns null for an empty record list', () => {
    const versions = new VersionManager();
    expect(versions.mergeAccepted('Agent', 'coder', [], 'nothing')).toBeNull();
  });
});

// ─── Versioned persistence contracts ─────────────────────────────────────────

describe('format-versioned persistence (T7)', () => {
  it('saves the audit log inside a kc.audit_log.v1 envelope and reloads it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-audit-'));
    try {
      const log = new AuditLog({ persistDir: dir });
      log.record({
        sessionId: 's1',
        iteration: 0,
        phase: 'rejected',
        details: { reason: 'test' },
        resources: [],
        success: true,
      });
      await log.save();

      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'audit-log.json'), 'utf-8'));
      expect(raw.format).toBe(AUDIT_LOG_FORMAT);
      expect(Array.isArray(raw.entries)).toBe(true);

      const reloaded = new AuditLog({ persistDir: dir });
      await reloaded.load();
      expect(reloaded.size).toBe(1);
      expect(reloaded.query({ phase: 'rejected' })).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerantly loads a legacy format-less audit log (bare array)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-audit-legacy-'));
    try {
      const legacyEntries = [
        {
          id: 'audit_legacy_0',
          timestamp: Date.now(),
          sessionId: 'old',
          iteration: 0,
          phase: 'decision',
          details: { committed: true },
          resources: [],
          success: true,
        },
      ];
      fs.writeFileSync(path.join(dir, 'audit-log.json'), JSON.stringify(legacyEntries), 'utf-8');

      const log = new AuditLog({ persistDir: dir });
      await log.load();
      expect(log.size).toBe(1);
      expect(log.query({ sessionId: 'old' })).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps kc.agp_state.v1 on serialized AGP state', () => {
    const server = {
      listAll: () => [],
      get: () => ({ success: false }),
      register: () => ({ success: true }),
    } as unknown as ServerInterface;
    const manager = new DynamicManager(server);

    const state = manager.serializeAll();
    expect(state.format).toBe(AGP_STATE_FORMAT);
  });

  it('loads a legacy AGP state file without a format field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-agp-'));
    try {
      const legacyState = {
        version: '1.0.0',
        timestamp: Date.now(),
        resources: { Agent: { coder: makeRecord('legacy', {}) } },
      };
      const filePath = path.join(dir, 'agp-state.json');
      fs.writeFileSync(filePath, JSON.stringify(legacyState), 'utf-8');

      const registered: string[] = [];
      const server = {
        listAll: () => [],
        get: () => ({ success: false }),
        register: (_type: string, record: ResourceRegistrationRecord) => {
          registered.push(record.entity.name);
          return { success: true };
        },
      } as unknown as ServerInterface;

      const manager = new DynamicManager(server);
      const result = manager.loadFromFile(filePath);
      expect(result.loaded).toBe(1);
      expect(registered).toEqual(['coder']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
