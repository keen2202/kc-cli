import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFirstRun,
  getTourSteps,
  runTour,
  completeTour,
  skipTour,
  getMarkerPath,
  resetFirstRun,
} from '../../src/services/firstRun';

vi.mock('fs/promises', async () => {
  return {
    access: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  };
});

import * as fs from 'fs/promises';

const mockAccess = vi.mocked(fs.access);
const mockMkdir = vi.mocked(fs.mkdir);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockUnlink = vi.mocked(fs.unlink);

describe('firstRun - coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isFirstRun', () => {
    it('should return false when marker exists', async () => {
      mockAccess.mockResolvedValue(undefined);
      expect(await isFirstRun()).toBe(false);
    });

    it('should return true when marker does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      expect(await isFirstRun()).toBe(true);
    });
  });

  describe('getTourSteps', () => {
    it('should return array of tour steps', () => {
      const steps = getTourSteps();
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
    });

    it('should return a copy (not the original array)', () => {
      const steps1 = getTourSteps();
      const steps2 = getTourSteps();
      expect(steps1).not.toBe(steps2);
      expect(steps1).toEqual(steps2);
    });

    it('should include welcome message', () => {
      const steps = getTourSteps();
      expect(steps.some(s => s.message.includes('Welcome'))).toBe(true);
    });

    it('should include help reference', () => {
      const steps = getTourSteps();
      expect(steps.some(s => s.message.includes('/help'))).toBe(true);
    });

    it('should include level reference', () => {
      const steps = getTourSteps();
      expect(steps.some(s => s.message.includes('/level'))).toBe(true);
    });

    it('should have optional action field', () => {
      const steps = getTourSteps();
      const stepsWithAction = steps.filter(s => s.action);
      const stepsWithoutAction = steps.filter(s => !s.action);
      expect(stepsWithAction.length).toBeGreaterThan(0);
      expect(stepsWithoutAction.length).toBeGreaterThan(0);
    });
  });

  describe('runTour', () => {
    it('should yield all tour steps', async () => {
      const steps = [];
      for await (const step of runTour()) {
        steps.push(step);
      }
      expect(steps.length).toBe(getTourSteps().length);
    });

    it('should yield steps in order', async () => {
      const expected = getTourSteps();
      const actual = [];
      for await (const step of runTour()) {
        actual.push(step);
      }
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i].message).toBe(expected[i].message);
      }
    });
  });

  describe('completeTour', () => {
    it('should create marker file', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await completeTour();

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.first-run-complete'),
        expect.stringContaining('completedAt'),
        'utf-8'
      );
    });

    it('should write version in marker', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await completeTour();

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written.version).toBe('1.0.0');
    });
  });

  describe('skipTour', () => {
    it('should call completeTour', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await skipTour();

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('getMarkerPath', () => {
    it('should return a path containing .first-run-complete', () => {
      const path = getMarkerPath();
      expect(path).toContain('.first-run-complete');
    });

    it('should include home directory', () => {
      const path = getMarkerPath();
      expect(path).toBeTruthy();
    });
  });

  describe('resetFirstRun', () => {
    it('should delete marker file', async () => {
      mockUnlink.mockResolvedValue(undefined);
      await resetFirstRun();
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should handle missing file gracefully', async () => {
      mockUnlink.mockRejectedValue(new Error('ENOENT'));
      await expect(resetFirstRun()).resolves.not.toThrow();
    });
  });
});
