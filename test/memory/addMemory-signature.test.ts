// FileMemoryService signature persistence tests (harness-evolution T8).
//
// addMemory rebuilds the frontmatter header before writing; it must keep the
// optional `signature` (and `confidence`) fields so bridged failure memories
// stay dedupable across sessions: the scanner manifest exposes the signature
// that MemoryIntegration.bridgeFailureSignatures matches on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Redirect ~ to a per-run temp dir so the round-trip never touches the real
// ~/.kc-cli tree. Same mutable-homedir pattern as test/bootstrap/config.test.ts.
const homedirMock = vi.hoisted(() => {
  let _value = '/tmp/kc-memory-signature-default-home';
  return {
    getHomedir: () => _value,
    setHomedir: (v: string) => {
      _value = v;
    },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: homedirMock.getHomedir,
  };
});

import * as os from 'os';
import { FileMemoryService } from '../../src/memory/FileMemoryService';
import { scanMemoryFiles } from '../../src/memory/scanner';
import type { MemoryEntry } from '../../src/memory/types';

const PROJECT_HASH = 'sig-test-project';

let tempHome: string;
let service: FileMemoryService;

beforeEach(async () => {
  // Real tmpdir still works — the os mock only overrides homedir.
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-memory-sig-'));
  homedirMock.setHomedir(tempHome);
  service = new FileMemoryService();
  await service.initialize();
});

afterEach(async () => {
  try {
    await fs.rm(tempHome, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

function bridgedMemory(): MemoryEntry {
  return {
    header: {
      name: 'Recurring failure: tool_timeout',
      description: 'Recurring failure: retry_loop caused by tool_timeout',
      type: 'feedback',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      confidence: 'high',
      signature: { terminalCause: 'tool_timeout', mechanism: 'retry_loop', count: 2 },
    },
    content: 'Occurrences: 2\n\nShell commands keep timing out after 30s.',
    filePath: '',
    fileName: 'failure-tool_timeout-retry_loop.md',
    mtime: 0,
  };
}

describe('FileMemoryService.addMemory — T8 signature persistence', () => {
  it('round-trips signature and confidence through addMemory → getMemory', async () => {
    const fileName = await service.addMemory(PROJECT_HASH, bridgedMemory());

    const loaded = await service.getMemory(PROJECT_HASH, fileName);
    expect(loaded).not.toBeNull();
    expect(loaded!.header.signature).toEqual({
      terminalCause: 'tool_timeout',
      mechanism: 'retry_loop',
      count: 2,
    });
    expect(loaded!.header.confidence).toBe('high');
    expect(loaded!.content).toContain('Occurrences: 2');
  });

  it('exposes the persisted signature via the scanner manifest (dedup path)', async () => {
    await service.addMemory(PROJECT_HASH, bridgedMemory());

    const manifest = await scanMemoryFiles(PROJECT_HASH);
    const entry = manifest.find((m) => m.fileName === 'failure-tool_timeout-retry_loop.md');
    expect(entry).toBeDefined();
    expect(entry!.signature).toEqual({
      terminalCause: 'tool_timeout',
      mechanism: 'retry_loop',
      count: 2,
    });
  });
});
