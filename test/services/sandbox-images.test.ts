// Tests for ImageManager

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageManager } from '../../src/services/sandbox-images';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
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

import { spawnSync } from 'child_process';
import * as fs from 'fs';

const mockSpawnSync = vi.mocked(spawnSync);

/** Helper: build a spawnSync return value that represents success/error. */
function spawnResult(overrides: { stdout?: string; stderr?: string; status?: number }) {
  return {
    pid: 123,
    output: [null, null, null] as Array<string | null>,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    status: overrides.status ?? 0,
    signal: null,
  };
}
const mockExistsSync = vi.mocked(fs.existsSync);

describe('ImageManager', () => {
  let manager: ImageManager;

  beforeEach(() => {
    manager = new ImageManager();
    vi.clearAllMocks();
  });

  describe('ensureImage', () => {
    it('should skip pull if image already exists locally', async () => {
      mockSpawnSync.mockReturnValue(spawnResult({}));

      const progress = vi.fn();
      await manager.ensureImage('node:22-alpine', progress);

      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'exists' })
      );
      // Should not call docker pull
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['pull']),
        expect.anything()
      );
    });

    it('should pull image if not found locally', async () => {
      let inspectCalled = false;
      mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (cmd === 'docker' && args) {
          if (args.includes('inspect')) {
            inspectCalled = true;
            return spawnResult({ status: 1 });
          }
          if (args.includes('pull')) {
            return spawnResult({ stdout: 'Pulling complete' });
          }
        }
        return spawnResult({});
      });

      const progress = vi.fn();
      await manager.ensureImage('ubuntu:latest', progress);

      expect(inspectCalled).toBe(true);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pulling' })
      );
    });

    it('should not re-check images already verified in session', async () => {
      mockSpawnSync.mockReturnValue(spawnResult({}));

      await manager.ensureImage('node:22-alpine');
      mockSpawnSync.mockClear();

      await manager.ensureImage('node:22-alpine');
      // Should not call docker image inspect again
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });
  });

  describe('listCachedImages', () => {
    it('should parse docker images output', () => {
      mockSpawnSync.mockReturnValue(
        spawnResult({ stdout: 'node:22-alpine|abc123|150MB|2024-01-01\nnode:20-alpine|def456|140MB|2024-01-02' })
      );

      const images = manager.listCachedImages();
      expect(images).toHaveLength(2);
      expect(images[0].repository).toBe('node');
      expect(images[0].tag).toBe('22-alpine');
    });

    it('should return empty array on error', () => {
      mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));

      const images = manager.listCachedImages();
      expect(images).toEqual([]);
    });
  });

  describe('pruneUnused', () => {
    it('should return number of pruned images', () => {
      mockSpawnSync.mockReturnValue(
        spawnResult({ stdout: 'Deleted Images:\nTotal reclaimed space: 500MB' })
      );

      const count = manager.pruneUnused();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 on error', () => {
      mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));

      expect(manager.pruneUnused()).toBe(0);
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
      mockSpawnSync.mockReturnValue(spawnResult({})); // image inspect succeeds

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBe('kc-cli-sandbox-custom:latest');
    });
  });
});
