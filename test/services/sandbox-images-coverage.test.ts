import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { ImageManager } from '../../src/services/sandbox-images';
import { execSync } from 'child_process';
import * as fs from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRmSync = vi.mocked(fs.rmSync);

describe('ImageManager - coverage', () => {
  let manager: ImageManager;

  beforeEach(() => {
    manager = new ImageManager();
    vi.clearAllMocks();
  });

  describe('ensureImage', () => {
    it('should handle pull failure and report error progress', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
          throw new Error('not found');
        }
        if (typeof cmd === 'string' && cmd.includes('docker pull')) {
          throw new Error('network timeout');
        }
        return '';
      });

      const progress = vi.fn();
      await expect(manager.ensureImage('bad-image:latest', progress)).rejects.toThrow('Failed to pull Docker image');
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' })
      );
    });

    it('should report pulling progress on successful pull', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
          throw new Error('not found');
        }
        return '';
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
      mockExecSync.mockReturnValue('');
      await expect(manager.ensureImage('node:22-alpine')).resolves.not.toThrow();
    });
  });

  describe('buildCustomImage', () => {
    it('should create temp dir, write Dockerfile, build, and cleanup', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);
      mockExecSync.mockReturnValue('');

      await manager.buildCustomImage('FROM node:22\nRUN echo hi', 'custom:latest');

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('.docker-build'), { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile'),
        'FROM node:22\nRUN echo hi'
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('docker build'),
        expect.objectContaining({ timeout: 600000 })
      );
      expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('.docker-build'), { recursive: true, force: true });
    });

    it('should still cleanup on build failure', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);
      mockExecSync.mockImplementation(() => { throw new Error('build failed'); });

      await expect(manager.buildCustomImage('FROM bad', 'custom:fail')).rejects.toThrow('build failed');
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('should ignore cleanup errors', async () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockImplementation(() => { throw new Error('rm failed'); });
      mockExecSync.mockReturnValue('');

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
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
          inspectCalls++;
          if (inspectCalls === 1) throw new Error('not found');
          return '';
        }
        return '';
      });
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      mockRmSync.mockReturnValue(undefined);

      const image = await manager.getProjectSandboxImage('/project');
      expect(image).toBe('kc-cli-sandbox-custom:latest');
    });
  });

  describe('listCachedImages', () => {
    it('should return empty array when no images found', () => {
      mockExecSync.mockReturnValue('');
      const images = manager.listCachedImages();
      expect(images).toEqual([]);
    });

    it('should parse single image correctly', () => {
      mockExecSync.mockReturnValue('node:22-alpine|abc123|150MB|2024-01-01');
      const images = manager.listCachedImages();
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
    it('should parse number of deleted images from output', () => {
      mockExecSync.mockReturnValue('Deleted Images:\nuntagged: sha256:abc123\nTotal reclaimed space: 500MB\n3 images deleted');
      const count = manager.pruneUnused();
      expect(count).toBe(3);
    });

    it('should return 0 when no images match pattern', () => {
      mockExecSync.mockReturnValue('Total reclaimed space: 0B');
      const count = manager.pruneUnused();
      expect(count).toBe(0);
    });
  });
});
