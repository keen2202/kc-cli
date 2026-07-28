// T8: Failure signature → memory bridging tests
// Covers: dedup/merge on repeated bridging, default-off gating, threshold
// filtering, signature-weighted relevance scoring (legacy path unchanged),
// frontmatter round-trip, and post-turn hook wiring.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryIntegration } from '../../src/memory/integration';
import type { MemoryEntry, MemoryManifestEntry, MemoryConfig } from '../../src/memory/types';
import {
  calculateRelevanceScore,
  resetRelevanceState,
} from '../../src/memory/relevanceSearch';
import { composeMemoryFile, parseFrontmatter } from '../../src/memory/frontmatter';
import {
  registerFailureBridgingHook,
  executePostTurnHooksSync,
  clearHooks,
  getHookCount,
  type PostTurnHookContext,
} from '../../src/hooks/postTurnHooks';
import type { EvidenceBundle } from '../../src/agp/sepl/protocol';
import type { AgentState } from '../../src/state/types';

// ─── Test helpers ────────────────────────────────────────────────────────────

/** In-memory store standing in for the file-backed memory service. */
function makeStore() {
  const files = new Map<string, MemoryEntry>();
  return {
    files,
    getManifest: async (): Promise<MemoryManifestEntry[]> =>
      [...files.values()].map(e => ({
        fileName: e.fileName,
        description: e.header.description,
        type: e.header.type,
        mtime: e.mtime,
        confidence: e.header.confidence,
        signature: e.header.signature,
      })),
    getContent: async (fileName: string): Promise<string | null> =>
      files.get(fileName)?.content ?? null,
    save: async (entry: MemoryEntry): Promise<void> => {
      files.set(entry.fileName, entry);
    },
  };
}

function makeIntegration(
  store: ReturnType<typeof makeStore>,
  config?: Partial<MemoryConfig>,
  saveSpy?: (entry: MemoryEntry) => Promise<void>
): MemoryIntegration {
  return new MemoryIntegration({
    config,
    getMemoryManifest: store.getManifest,
    getMemoryContent: store.getContent,
    saveMemory: saveSpy ?? store.save,
    now: () => 1_700_000_000_000,
  });
}

function makeBundle(count: number, overrides?: {
  terminalCause?: string;
  mechanism?: string;
}): EvidenceBundle {
  return {
    clusters: [
      {
        signature: {
          terminalCause: overrides?.terminalCause ?? 'tool_timeout',
          causalStatus: 'direct',
          mechanism: (overrides?.mechanism ?? 'retry_loop') as EvidenceBundle['clusters'][number]['signature']['mechanism'],
        },
        count,
        representativeEvents: [
          { id: 'e1', source: 'Shell', message: 'command timed out', timestamp: 1 },
        ],
        sharedSymptoms: ['timed out after 30s'],
      },
    ],
    totalFailures: count,
    generatedAt: 1_700_000_000_000,
  };
}

const hookContext: PostTurnHookContext = {
  messages: [],
  systemPrompt: '',
  state: {} as AgentState,
  querySource: 'test',
};

// ─── Bridging: dedup & merge ─────────────────────────────────────────────────

describe('bridgeFailureSignatures — dedup and merge', () => {
  it('bridges the same failure mechanism twice into a single memory with count 2', async () => {
    const store = makeStore();
    const integration = makeIntegration(store, { failureBridging: true });

    await integration.bridgeFailureSignatures(makeBundle(1), { threshold: 1 });
    await integration.bridgeFailureSignatures(makeBundle(1), { threshold: 1 });

    expect(store.files.size).toBe(1);
    const entry = [...store.files.values()][0];
    expect(entry.header.type).toBe('feedback');
    expect(entry.header.signature).toEqual({
      terminalCause: 'tool_timeout',
      mechanism: 'retry_loop',
      count: 2,
    });
    expect(entry.content).toContain('Occurrences: 2');
  });

  it('separates verifier-level facts from the inferred mechanism in the body', async () => {
    const store = makeStore();
    const integration = makeIntegration(store, { failureBridging: true });

    await integration.bridgeFailureSignatures(makeBundle(2));

    const entry = [...store.files.values()][0];
    expect(entry.content).toContain('## Verifier-level facts');
    expect(entry.content).toContain('## Inferred mechanism');
    // Facts section carries observed data; mechanism section carries inference
    const factsSection = entry.content.split('## Inferred mechanism')[0];
    const mechanismSection = entry.content.split('## Inferred mechanism')[1];
    expect(factsSection).toContain('Terminal cause: tool_timeout');
    expect(factsSection).toContain('timed out after 30s');
    expect(factsSection).toContain('[Shell] command timed out');
    expect(mechanismSection).toContain('Mechanism: retry_loop');
    expect(mechanismSection).toContain('Causal status: direct');
  });

  it('merges into a legacy file via deterministic fileName + Occurrences parsing', async () => {
    const store = makeStore();
    // Legacy bridged memory without a manifest signature (pre-T8 format)
    store.files.set('failure-tool-timeout-retry-loop.md', {
      header: {
        name: 'Recurring failure: tool_timeout',
        description: 'legacy failure memory',
        type: 'feedback',
      },
      content: '- Occurrences: 3',
      filePath: '',
      fileName: 'failure-tool-timeout-retry-loop.md',
      mtime: 1,
    });
    const integration = makeIntegration(store, { failureBridging: true });

    await integration.bridgeFailureSignatures(makeBundle(2));

    expect(store.files.size).toBe(1);
    const entry = store.files.get('failure-tool-timeout-retry-loop.md')!;
    expect(entry.header.signature?.count).toBe(5);
  });

  it('creates distinct memories for distinct signatures', async () => {
    const store = makeStore();
    const integration = makeIntegration(store, { failureBridging: true });

    await integration.bridgeFailureSignatures(makeBundle(2));
    await integration.bridgeFailureSignatures(
      makeBundle(2, { terminalCause: 'permission_denied', mechanism: 'permission_blocked' })
    );

    expect(store.files.size).toBe(2);
  });
});

// ─── Bridging: gating & threshold ────────────────────────────────────────────

describe('bridgeFailureSignatures — gating', () => {
  it('is off by default: zero saveMemory calls without explicit opt-in', async () => {
    const store = makeStore();
    const saveSpy = vi.fn(store.save);
    const integration = makeIntegration(store, undefined, saveSpy);

    await integration.bridgeFailureSignatures(makeBundle(10), { threshold: 1 });

    expect(integration.getConfig().failureBridging).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('stays off when memory system is disabled even if failureBridging is true', async () => {
    const store = makeStore();
    const saveSpy = vi.fn(store.save);
    const integration = makeIntegration(
      store,
      { enabled: false, failureBridging: true },
      saveSpy
    );

    await integration.bridgeFailureSignatures(makeBundle(10), { threshold: 1 });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('skips clusters below the occurrence threshold (default 2)', async () => {
    const store = makeStore();
    const saveSpy = vi.fn(store.save);
    const integration = makeIntegration(store, { failureBridging: true }, saveSpy);

    await integration.bridgeFailureSignatures(makeBundle(1));

    expect(saveSpy).not.toHaveBeenCalled();
  });
});

// ─── Relevance scoring: signature weighting ──────────────────────────────────

describe('relevance scoring with failure signatures', () => {
  beforeEach(() => {
    resetRelevanceState();
  });

  const baseEntry = {
    description: 'recurring failure lesson',
    type: 'feedback' as const,
    mtime: Date.now(),
  };

  it('boosts signature memories when the query mentions cause and mechanism', () => {
    const plain: MemoryManifestEntry = { ...baseEntry, fileName: 'mem-a.md' };
    const signed: MemoryManifestEntry = {
      ...baseEntry,
      fileName: 'mem-b.md',
      signature: { terminalCause: 'tool_timeout', mechanism: 'retry_loop', count: 2 },
    };
    const query = 'how to avoid tool_timeout retry_loop failures';

    const plainScore = calculateRelevanceScore(query, plain);
    const signedScore = calculateRelevanceScore(query, signed);

    // Additive weighting applied before multipliers: +25 (cause) +15 (mechanism)
    expect(signedScore - plainScore).toBe(40);
  });

  it('leaves memories without a signature on the unchanged legacy path', () => {
    const plain: MemoryManifestEntry = { ...baseEntry, fileName: 'mem-a.md' };
    const signed: MemoryManifestEntry = {
      ...baseEntry,
      fileName: 'mem-b.md',
      signature: { terminalCause: 'tool_timeout', mechanism: 'retry_loop' },
    };
    const query = 'recurring failure lesson';

    // Query mentions neither cause nor mechanism → identical scores
    expect(calculateRelevanceScore(query, plain)).toBe(calculateRelevanceScore(query, signed));
  });
});

// ─── Frontmatter round-trip ──────────────────────────────────────────────────

describe('frontmatter signature serialization', () => {
  it('round-trips the signature through compose + parse', () => {
    const composed = composeMemoryFile(
      {
        name: 'Recurring failure: tool_timeout',
        description: 'bridged failure memory',
        type: 'feedback',
        signature: { terminalCause: 'tool_timeout', mechanism: 'retry_loop', count: 4 },
      },
      'body text'
    );

    const { header, body } = parseFrontmatter(composed);
    expect(header.signature).toEqual({
      terminalCause: 'tool_timeout',
      mechanism: 'retry_loop',
      count: 4,
    });
    expect(body).toBe('body text');
  });

  it('parses files without signature keys exactly as before', () => {
    const composed = composeMemoryFile(
      { name: 'plain memory', description: 'no signature', type: 'user' },
      'body'
    );
    const { header } = parseFrontmatter(composed);
    expect(header.signature).toBeUndefined();
  });
});

// ─── Post-turn hook wiring ───────────────────────────────────────────────────

describe('registerFailureBridgingHook', () => {
  beforeEach(() => {
    clearHooks();
  });

  it('bridges evidence when the hook fires via executePostTurnHooksSync', async () => {
    const store = makeStore();
    const integration = makeIntegration(store, { failureBridging: true });
    registerFailureBridgingHook(integration, () => makeBundle(2));

    expect(getHookCount()).toBe(1);
    await executePostTurnHooksSync(hookContext);

    expect(store.files.size).toBe(1);
  });

  it('does nothing when the evidence provider returns null', async () => {
    const store = makeStore();
    const saveSpy = vi.fn(store.save);
    const integration = makeIntegration(store, { failureBridging: true }, saveSpy);
    registerFailureBridgingHook(integration, () => null);

    await executePostTurnHooksSync(hookContext);

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('respects the default-off config through the hook path', async () => {
    const store = makeStore();
    const saveSpy = vi.fn(store.save);
    const integration = makeIntegration(store, undefined, saveSpy);
    registerFailureBridgingHook(integration, () => makeBundle(5), { threshold: 1 });

    await executePostTurnHooksSync(hookContext);

    expect(saveSpy).not.toHaveBeenCalled();
  });
});
