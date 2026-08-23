// Behavior tests for the QueryEngine memory sub-module (QueryEngineMemory.ts).
//
// Scope (audit round3 T13 / H6): drive the REAL `MemoryHandler` and its real
// `MemoryIntegration`/relevance-search/extraction pipeline — no mocking of the
// module under test. Covered boundaries:
//   - enable/disable gating (isEnabled + zero-callback load when disabled)
//   - memory loading & injection format ("# Relevant Memories" system-prompt
//     segment), relevance ranking, relevanceSearchLimit, null-content filtering
//   - error suppression: an integration failure degrades to empty context
//   - persistence triggers: heuristic auto-extraction saves via saveMemory;
//     disabled tiers never save
//   - a real temp-dir round trip: seed memory files on disk, load them back
//     through MemoryHandler, persist an extracted memory to disk, re-parse it

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryHandler } from '../../src/query/QueryEngineMemory';
import type { MemoryIntegrationConfig } from '../../src/memory/integration';
import { resetExtractionState } from '../../src/memory/memoryExtraction';
import { composeMemoryFile, parseFrontmatter } from '../../src/memory/frontmatter';
import type { MemoryManifestEntry } from '../../src/memory/types';
import type { ChatMessage } from '../../src/query/protocol';
import { logger } from '../../src/services/logger';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-mem-test-'));
  // The extraction pipeline keeps a module-level content-hash dedup cache.
  resetExtractionState();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userMsg(content: string): ChatMessage {
  return { id: 'u1', role: 'user', content, timestamp: 1000 } as ChatMessage;
}

function handler(overrides: MemoryIntegrationConfig = {}): MemoryHandler {
  return new MemoryHandler({ ...overrides });
}

/** Manifest/content callbacks backed by REAL files in the temp dir. */
function diskBackedCallbacks(dir: string): Pick<
  MemoryIntegrationConfig,
  'getMemoryManifest' | 'getMemoryContent'
> {
  const manifest = (): MemoryManifestEntry[] =>
    fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(fileName => {
      const raw = fs.readFileSync(path.join(dir, fileName), 'utf-8');
      const { header } = parseFrontmatter(raw);
      return {
        fileName,
        description: header.description ?? '',
        type: header.type ?? 'project',
        mtime: fs.statSync(path.join(dir, fileName)).mtimeMs,
      };
    });
  const content = async (fileName: string): Promise<string | null> => {
    try {
      const raw = fs.readFileSync(path.join(dir, fileName), 'utf-8');
      return parseFrontmatter(raw).body;
    } catch {
      return null;
    }
  };
  return { getMemoryManifest: manifest, getMemoryContent: content };
}

// ─── Enablement gating ──────────────────────────────────────────────────────

describe('MemoryHandler — enablement', () => {
  it('is enabled by default and reports the flag through isEnabled()', () => {
    expect(handler().isEnabled()).toBe(true);
  });

  it('a disabled integration reports disabled and loads memories without touching the manifest', async () => {
    const getMemoryManifest = vi.fn(async () => [
      { fileName: 'db.md', description: 'database migration steps', type: 'project' as const, mtime: 1 },
    ]);
    const h = handler({ config: { enabled: false }, getMemoryManifest });

    expect(h.isEnabled()).toBe(false);
    await expect(h.loadRelevantMemories('run the database migration', [])).resolves.toBe('');
    expect(getMemoryManifest).not.toHaveBeenCalled();
  });

  it('exposes the underlying integration for engine wiring (getIntegration)', () => {
    const h = handler({ config: { relevanceSearchLimit: 2 } });
    expect(h.getIntegration().getConfig().relevanceSearchLimit).toBe(2);
  });
});

// ─── Loading & injection ────────────────────────────────────────────────────

describe('MemoryHandler — loadRelevantMemories injection format', () => {
  it('formats matched memories as a "# Relevant Memories" system-prompt segment', async () => {
    const h = handler({
      getMemoryManifest: async () => [
        { fileName: 'migration.md', description: 'postgres migration runbook', type: 'project', mtime: 1 },
      ],
      getMemoryContent: async () => '1. Stop the app.\n2. Run migrate up.',
    });

    const ctx = await h.loadRelevantMemories('how do I run the postgres migration?', ['FileRead']);

    expect(ctx).toContain('# Relevant Memories');
    expect(ctx).toContain('1. Stop the app.');
    expect(ctx).toContain('Run migrate up.');
  });

  it('returns empty context for an empty manifest', async () => {
    const h = handler({
      getMemoryManifest: async () => [],
      getMemoryContent: async () => 'unused',
    });

    await expect(h.loadRelevantMemories('anything at all', [])).resolves.toBe('');
  });

  it('respects relevanceSearchLimit when several memories match', async () => {
    const h = handler({
      config: { relevanceSearchLimit: 1 },
      getMemoryManifest: async () => [
        { fileName: 'postgres-migration.md', description: 'postgres migration runbook', type: 'project', mtime: 1 },
        { fileName: 'mysql-migration.md', description: 'mysql migration runbook', type: 'project', mtime: 1 },
      ],
      getMemoryContent: async (fileName) => `BODY:${fileName}`,
    });

    const ctx = await h.loadRelevantMemories('postgres migration', []);

    // The best-scoring memory wins; only one body is injected.
    expect(ctx).toContain('BODY:postgres-migration.md');
    expect(ctx).not.toContain('BODY:mysql-migration.md');
  });

  it('filters out memories whose content cannot be loaded (null)', async () => {
    const h = handler({
      getMemoryManifest: async () => [
        { fileName: 'gone.md', description: 'was deleted from disk', type: 'project', mtime: 1 },
      ],
      getMemoryContent: async () => null,
    });

    await expect(h.loadRelevantMemories('deleted memory query', [])).resolves.toBe('');
  });

  it('degrades to empty context when the integration fails, instead of throwing', async () => {
    // T21: failure signal moved from console.warn to the structured logger.
    const warnSpy = vi.spyOn(logger.memory, 'warn').mockImplementation(() => {});
    try {
      const h = handler({
        getMemoryManifest: async () => {
          throw new Error('disk boom');
        },
      });

      await expect(h.loadRelevantMemories('query during outage', [])).resolves.toBe('');
      expect(warnSpy).toHaveBeenCalledWith(
        '[MemoryIntegration] Failed to load memories',
        expect.objectContaining({ error: expect.stringContaining('disk boom') }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('loads real memory files seeded in a temp directory through the public API', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'postgres-migration.md'),
      composeMemoryFile(
        { name: 'postgres_migration_runbook', description: 'postgres migration runbook', type: 'project' },
        'Stop the app server, then run migrate up.',
      ),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'editor-shortcuts.md'),
      composeMemoryFile(
        { name: 'editor_shortcuts', description: 'editor shortcut cheatsheet', type: 'reference' },
        'Ctrl+S saves the file.',
      ),
    );

    const h = handler({ ...diskBackedCallbacks(tmpDir), projectHash: 'test-project' });

    const ctx = await h.loadRelevantMemories('how do I run the postgres migration safely?', []);
    expect(ctx).toContain('# Relevant Memories');
    expect(ctx).toContain('run migrate up');

    // An unrelated file on disk is readable through the same path.
    const other = await h.loadRelevantMemories('editor shortcut cheatsheet', []);
    expect(other).toContain('Ctrl+S saves the file.');
  });
});

// ─── Persistence triggers ───────────────────────────────────────────────────

describe('MemoryHandler — persistence triggers (auto-extraction)', () => {
  function capturingSave() {
    const saved: Array<Parameters<NonNullable<MemoryIntegrationConfig['saveMemory']>>[0]> = [];
    const saveMemory = async (memory: (typeof saved)[number]) => { saved.push(memory); };
    return { saved, saveMemory };
  }

  it('persists a user-preference memory extracted from the conversation via saveMemory', async () => {
    const { saved, saveMemory } = capturingSave();
    const h = handler({ saveMemory });

    await h.getIntegration().extractMemoriesFromConversation([
      userMsg('I prefer vitest with verbose reporters on every project'),
    ]);

    expect(saved).toHaveLength(1);
    expect(saved[0].header.type).toBe('user');
    expect(saved[0].header.name).toBe('user_preferences');
    expect(saved[0].content).toContain('vitest with verbose reporters');
    expect(saved[0].fileName.endsWith('.md')).toBe(true);
  });

  it('does not persist anything when autoExtract is disabled', async () => {
    const { saved, saveMemory } = capturingSave();
    const h = handler({ config: { autoExtract: false }, saveMemory });

    await h.getIntegration().extractMemoriesFromConversation([
      userMsg('I prefer vitest with verbose reporters on every project'),
    ]);

    expect(saved).toHaveLength(0);
  });

  it('does not persist anything when the whole memory system is disabled', async () => {
    const { saved, saveMemory } = capturingSave();
    const h = handler({ config: { enabled: false }, saveMemory });

    await h.getIntegration().extractMemoriesFromConversation([
      userMsg('I prefer vitest with verbose reporters on every project'),
    ]);

    expect(saved).toHaveLength(0);
  });

  it('round-trips an extracted memory into the temp dir on disk and re-parses it', async () => {
    const h = handler({
      ...diskBackedCallbacks(tmpDir),
      saveMemory: async (memory) => {
        const file = path.join(tmpDir, memory.fileName);
        fs.writeFileSync(file, composeMemoryFile(memory.header, memory.content));
      },
    });

    await h.getIntegration().extractMemoriesFromConversation([
      userMsg('I prefer vitest with verbose reporters on every project'),
    ]);

    const written = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
    expect(written).toHaveLength(1);
    const { header, body } = parseFrontmatter(
      fs.readFileSync(path.join(tmpDir, written[0]), 'utf-8'),
    );
    expect(header.type).toBe('user');
    expect(header.name).toBe('user_preferences');
    expect(body).toContain('vitest with verbose reporters');
  });
});
