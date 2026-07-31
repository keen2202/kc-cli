// Tests for ImageManager

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { ImageManager } from '../../src/services/sandbox-images';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { spawn } from 'child_process';
import * as fs from 'fs';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);

/** Helper: build a fake ChildProcess that emits stdout/stderr then closes. */
function fakeChild(overrides: { stdout?: string; stderr?: string; status?: number }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Emit asynchronously so runDocker's listeners are attached first.
  setImmediate(() => {
    if (overrides.stdout) child.stdout.emit('data', overrides.stdout);
    if (overrides.stderr) child.stderr.emit('data', overrides.stderr);
    child.emit('close', overrides.status ?? 0);
  });
  return child;
}

/** Route docker invocations by args, mirroring the old spawnSync router. */
function routeSpawn(router: (args: readonly string[]) => { stdout?: string; stderr?: string; status?: number }) {
  mockSpawn.mockImplementation(((cmd: string, args?: readonly string[]) => {
    if (cmd === 'docker' && args) return fakeChild(router(args)) as never;
    return fakeChild({}) as never;
  }) as never);
}

describe('ImageManager', () => {
  let manager: ImageManager;

  beforeEach(() => {
    manager = new ImageManager();
    vi.clearAllMocks();
  });

  describe('ensureImage', () => {
    it('should skip pull if image already exists locally', async () => {
      routeSpawn(() => ({}));

      const progress = vi.fn();
      await manager.ensureImage('node:22-alpine', progress);

      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'exists' })
      );
      // Should not call docker pull
      expect(mockSpawn).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['pull']),
        expect.anything()
      );
    });

    it('should pull image if not found locally', async () => {
      let inspectCalled = false;
      routeSpawn((args) => {
        if (args.includes('inspect')) {
          inspectCalled = true;
          return { status: 1 };
        }
        if (args.includes('pull')) {
          return { stdout: 'Pulling complete' };
        }
        return {};
      });

      const progress = vi.fn();
      await manager.ensureImage('ubuntu:latest', progress);

      expect(inspectCalled).toBe(true);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pulling' })
      );
    });

    it('should not re-check images already verified in session', async () => {
      routeSpawn(() => ({}));

      await manager.ensureImage('node:22-alpine');
      mockSpawn.mockClear();

      await manager.ensureImage('node:22-alpine');
      // Should not call docker image inspect again
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('listCachedImages', () => {
    it('should parse docker images output', async () => {
      routeSpawn(() => ({ stdout: 'node:22-alpine|abc123|150MB|2024-01-01\nnode:20-alpine|def456|140MB|2024-01-02' }));

      const images = await manager.listCachedImages();
      expect(images).toHaveLength(2);
      expect(images[0].repository).toBe('node');
      expect(images[0].tag).toBe('22-alpine');
    });

    it('should return empty array on error', async () => {
      routeSpawn(() => ({ status: 1 }));

      const images = await manager.listCachedImages();
      expect(images).toEqual([]);
    });
  });

  describe('pruneUnused', () => {
    it('should return number of pruned images', async () => {
      routeSpawn(() => ({ stdout: 'Deleted Images:\nTotal reclaimed space: 500MB' }));

      const count = await manager.pruneUnused();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 on error', async () => {
      routeSpawn(() => ({ status: 1 }));

      expect(await manager.pruneUnused()).toBe(0);
    });
  });

  describe('getProjectSandboxImage', () => {
    it('should return null if no custom Dockerfile exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBeNull();
    });

    it('should return tag if custom image already built', async () => {
      mockExistsSync.mockReturnValue(true);
      routeSpawn(() => ({})); // image inspect succeeds

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBe('kc-cli-sandbox-custom:latest');
    });
  });
});
