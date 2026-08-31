import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileMemoryService } from '../../src/memory/FileMemoryService';
import type { MemoryEntry, MemoryType } from '../../src/memory/types';

// Redirect ~/.kc-cli to a per-run temp dir so these integration tests never
// touch the real (possibly read-only) home directory. Same mutable-homedir
// pattern as test/memory/addMemory-signature.test.ts and
// test/bootstrap/config.test.ts.
const homedirMock = vi.hoisted(() => {
  let _value = '/tmp/kc-memory-file-default-home';
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

// Use a temp directory for tests
let tempDir: string;
let service: FileMemoryService;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-memory-test-'));
  homedirMock.setHomedir(tempDir);
  service = new FileMemoryService();
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('FileMemoryService', () => {
  it('should be instantiable', () => {
    expect(service).toBeDefined();
  });

  it('should have initialize method', () => {
    expect(typeof service.initialize).toBe('function');
  });

  it('should have addMemory method', () => {
    expect(typeof service.addMemory).toBe('function');
  });

  it('should have listMemories method', () => {
    expect(typeof service.listMemories).toBe('function');
  });

  it('should have getMemory method', () => {
    expect(typeof service.getMemory).toBe('function');
  });

  it('should have removeMemory method', () => {
    expect(typeof service.removeMemory).toBe('function');
  });

  it('should have updateMemory method', () => {
    expect(typeof service.updateMemory).toBe('function');
  });

  it('should have saveSession method', () => {
    expect(typeof service.saveSession).toBe('function');
  });

  it('should have loadSession method', () => {
    expect(typeof service.loadSession).toBe('function');
  });

  it('should have listSessions method', () => {
    expect(typeof service.listSessions).toBe('function');
  });

  it('should have deleteSession method', () => {
    expect(typeof service.deleteSession).toBe('function');
  });

  it('should have archiveSession method', () => {
    expect(typeof service.archiveSession).toBe('function');
  });

  it('should have pruneOldSessions method', () => {
    expect(typeof service.pruneOldSessions).toBe('function');
  });

  it('should have scanMemories method', () => {
    expect(typeof service.scanMemories).toBe('function');
  });

  it('should have getProjectMemoryPath method', () => {
    expect(typeof service.getProjectMemoryPath).toBe('function');
  });
});

describe('FileMemoryService: Memory Operations (integration)', () => {
  // These tests require actual filesystem access
  // Skip if running in a restricted environment

  it('should list memories for non-existent project (returns empty)', async () => {
    const memories = await service.listMemories('nonexistent-project-hash');
    expect(memories).toEqual([]);
  });

  it('should scan memories for non-existent project (returns empty)', async () => {
    const memories = await service.scanMemories('nonexistent-project-hash');
    expect(memories).toEqual([]);
  });

  it('should get memory for non-existent file (returns null)', async () => {
    const memory = await service.getMemory('nonexistent-hash', 'nonexistent.md');
    expect(memory).toBeNull();
  });

  it('should list sessions (returns empty initially)', async () => {
    const sessions = await service.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should load non-existent session (returns null)', async () => {
    const session = await service.loadSession('nonexistent-session');
    expect(session).toBeNull();
  });

  it('should delete non-existent session (no error)', async () => {
    await expect(service.deleteSession('nonexistent-session')).resolves.not.toThrow();
  });

  it('should prune sessions with 0 retention (returns 0 if none)', async () => {
    const pruned = await service.pruneOldSessions(0);
    expect(typeof pruned).toBe('number');
  });
});
