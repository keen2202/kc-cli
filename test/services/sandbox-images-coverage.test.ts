import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

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

import { ImageManager } from '../../src/services/sandbox-images';
import { spawn } from 'child_process';
import * as fs from 'fs';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRmSync = vi.mocked(fs.rmSync);

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

describe('ImageManager - coverage', () => {
  let manager: ImageManager;

  beforeEach(() => {
    manager = new ImageManager();
    vi.clearAllMocks();
  });

  describe('ensureImage', () => {
    it('should handle pull failure and report error progress', async () => {
      routeSpawn((args) => {
        if (args.includes('inspect')) return { status: 1 };
        if (args.includes('pull')) return { status: 1, stderr: 'network timeout' };
        return {};
      });

      const progress = vi.fn();
      await expect(manager.ensureImage('bad-image:latest', progress)).rejects.toThrow('Failed to pull Docker image');
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' })
      );
    });

    it('should report pulling progress on successful pull', async () => {
      routeSpawn((args) => {
        if (args.includes('inspect')) return { status: 1 };
        if (args.includes('pull')) return { stdout: 'Pulling complete' };
        return {};
      });

      const progress = vi.fn();
      await manager.ensureImage('ubuntu:latest', progress);

      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pulling', message: expect.stringContaining('Pulling') })
      );
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pulling', message: expect.stringContaining('Successfully pulled') })
      );
    });

    it('should work without progress callback', async () => {
      routeSpawn(() => ({}));
      await expect(manager.ensureImage('node:22-alpine')).resolves.not.toThrow();
    });
  });

  describe('buildCustomImage', () => {
    it('should create temp dir, write Dockerfile, build, and cleanup', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);
      routeSpawn(() => ({}));

      await manager.buildCustomImage('FROM node:22\nRUN echo hi', 'custom:latest');

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('.docker-build'), { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile'),
        'FROM node:22\nRUN echo hi'
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['build']),
        expect.anything()
      );
      expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('.docker-build'), { recursive: true, force: true });
    });

    it('should still cleanup on build failure', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);
      routeSpawn(() => ({ status: 1, stderr: 'build failed' }));

      await expect(manager.buildCustomImage('FROM bad', 'custom:fail')).rejects.toThrow('build failed');
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('should ignore cleanup errors', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockImplementation(() => { throw new Error('rm failed'); });
      routeSpawn(() => ({}));

      await expect(manager.buildCustomImage('FROM node:22', 'custom:latest')).resolves.not.toThrow();
    });
  });

  describe('getProjectSandboxImage', () => {
    it('should build custom image when Dockerfile exists but image not built', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('FROM node:22\nRUN echo hi');

      // First call: image inspect fails (not built)
      // Then build succeeds
      // Then subsequent inspect succeeds
      let inspectCalls = 0;
      routeSpawn((args) => {
        if (args.includes('inspect')) {
          inspectCalls++;
          if (inspectCalls === 1) return { status: 1 };
          return {};
        }
        return {};
      });
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBe('kc-cli-sandbox-custom:latest');
    });
  });

  describe('listCachedImages', () => {
    it('should return empty array when no images found', async () => {
      routeSpawn(() => ({ stdout: '' }));
      const images = await manager.listCachedImages();
      expect(images).toEqual([]);
    });

    it('should parse single image correctly', async () => {
      routeSpawn(() => ({ stdout: 'node:22-alpine|abc123|150MB|2024-01-01' }));
      const images = await manager.listCachedImages();
      expect(images).toHaveLength(1);
      expect(images[0]).toEqual({
        repository: 'node',
        tag: '22-alpine',
        id: 'abc123',
        size: '150MB',
        createdAt: '2024-01-01',
      });
    });
  });

  describe('pruneUnused', () => {
    it('should parse number of deleted images from output', async () => {
      routeSpawn(() => ({ stdout: 'Deleted Images:\nuntagged: sha256:abc123\nTotal reclaimed space: 500MB\n3 images deleted' }));
      const count = await manager.pruneUnused();
      expect(count).toBe(3);
    });

    it('should return 0 when no images match pattern', async () => {
      routeSpawn(() => ({ stdout: 'Total reclaimed space: 0B' }));
      const count = await manager.pruneUnused();
      expect(count).toBe(0);
    });
  });
});
