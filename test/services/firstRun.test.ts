import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isFirstRun,
  getTourSteps,
  runTour,
  completeTour,
  skipTour,
  getMarkerPath,
} from '../../src/services/firstRun';

// Mock fs
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

import * as fs from 'fs/promises';

describe('FirstRun Experience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isFirstRun', () => {
    it('should return true when marker file does not exist', async () => {
      (fs.access as any).mockRejectedValue(new Error('ENOENT'));
      const result = await isFirstRun();
      expect(result).toBe(true);
    });

    it('should return false when marker file exists', async () => {
      (fs.access as any).mockResolvedValue(undefined);
      const result = await isFirstRun();
      expect(result).toBe(false);
    });
  });

  describe('getTourSteps', () => {
    it('should return 5 tour steps', () => {
      const steps = getTourSteps();
      expect(steps.length).toBe(5);
    });

    it('should have welcome message as first step', () => {
      const steps = getTourSteps();
      expect(steps[0].message).toContain('Welcome to KC-CLI');
    });

    it('should have help command in steps', () => {
      const steps = getTourSteps();
      const helpStep = steps.find(s => s.message.includes('/help'));
      expect(helpStep).toBeDefined();
    });

    it('should have level command in steps', () => {
      const steps = getTourSteps();
      const levelStep = steps.find(s => s.message.includes('/level'));
      expect(levelStep).toBeDefined();
    });
  });

  describe('runTour', () => {
    it('should yield all tour steps', async () => {
      const steps: any[] = [];
      for await (const step of runTour()) {
        steps.push(step);
      }
      expect(steps.length).toBe(5);
    });

    it('should yield steps in order', async () => {
      const steps: any[] = [];
      for await (const step of runTour()) {
        steps.push(step);
      }
      expect(steps[0].message).toContain('Welcome');
      expect(steps[4].message).toContain('/level');
    });
  });

  describe('completeTour', () => {
    it('should create marker file', async () => {
      (fs.mkdir as any).mockResolvedValue(undefined);
      (fs.writeFile as any).mockResolvedValue(undefined);

      await completeTour();

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should write JSON with completedAt timestamp', async () => {
      (fs.mkdir as any).mockResolvedValue(undefined);
      (fs.writeFile as any).mockResolvedValue(undefined);

      await completeTour();

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = JSON.parse(writeCall[1]);
      expect(content.completedAt).toBeDefined();
      expect(typeof content.completedAt).toBe('number');
    });
  });

  describe('skipTour', () => {
    it('should create marker file same as completeTour', async () => {
      (fs.mkdir as any).mockResolvedValue(undefined);
      (fs.writeFile as any).mockResolvedValue(undefined);

      await skipTour();

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe('getMarkerPath', () => {
    it('should return path ending with .first-run-complete', () => {
      const markerPath = getMarkerPath();
      expect(markerPath).toContain('.first-run-complete');
    });

    it('should be in .kc-cli directory', () => {
      const markerPath = getMarkerPath();
      expect(markerPath).toContain('.kc-cli');
    });
  });
});
