// Tests for ImageManager

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageManager } from '../../src/services/sandbox-images';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
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

import { execSync } from 'child_process';
import * as fs from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

describe('ImageManager', () => {
  let manager: ImageManager;

  beforeEach(() => {
    manager = new ImageManager();
    vi.clearAllMocks();
  });

  describe('ensureImage', () => {
    it('should skip pull if image already exists locally', async () => {
      mockExecSync.mockReturnValue('');

      const progress = vi.fn();
      await manager.ensureImage('node:22-alpine', progress);

      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'exists' })
      );
      // Should not call docker pull
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('docker pull'),
        expect.anything()
      );
    });

    it('should pull image if not found locally', async () => {
      let inspectCalled = false;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
          inspectCalled = true;
          throw new Error('not found');
        }
        if (typeof cmd === 'string' && cmd.includes('docker pull')) {
          return 'Pulling complete';
        }
        return '';
      });

      const progress = vi.fn();
      await manager.ensureImage('ubuntu:latest', progress);

      expect(inspectCalled).toBe(true);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pulling' })
      );
    });

    it('should not re-check images already verified in session', async () => {
      mockExecSync.mockReturnValue('');

      await manager.ensureImage('node:22-alpine');
      mockExecSync.mockClear();

      await manager.ensureImage('node:22-alpine');
      // Should not call docker image inspect again
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('listCachedImages', () => {
    it('should parse docker images output', () => {
      mockExecSync.mockReturnValue(
        'node:22-alpine|abc123|150MB|2024-01-01\nnode:20-alpine|def456|140MB|2024-01-02'
      );

      const images = manager.listCachedImages();
      expect(images).toHaveLength(2);
      expect(images[0].repository).toBe('node');
      expect(images[0].tag).toBe('22-alpine');
    });

    it('should return empty array on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('docker not found'); });

      const images = manager.listCachedImages();
      expect(images).toEqual([]);
    });
  });

  describe('pruneUnused', () => {
    it('should return number of pruned images', () => {
      mockExecSync.mockReturnValue('Deleted Images:\nTotal reclaimed space: 500MB');

      const count = manager.pruneUnused();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('docker not found'); });

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
      mockExecSync.mockReturnValue(''); // image inspect succeeds

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBe('kc-cli-sandbox-custom:latest');
    });
  });
});
