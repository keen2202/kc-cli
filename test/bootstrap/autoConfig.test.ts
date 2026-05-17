import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectProjectType,
  autoConfigure,
  getRecommendedLsp,
  getSupportedProjectTypes,
} from '../../src/bootstrap/autoConfig';

// Mock fs
vi.mock('fs/promises', () => ({
  access: vi.fn(),
}));

import * as fs from 'fs/promises';

describe('Auto-Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectProjectType', () => {
    it('should detect Node.js project from package.json', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('package.json')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('node');
      expect(result.name).toBe('Node.js');
      expect(result.indicators).toContain('package.json');
      expect(result.lspServer).toBe('typescript-language-server');
    });

    it('should detect Python project from pyproject.toml', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('pyproject.toml')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('python');
      expect(result.name).toBe('Python');
      expect(result.lspServer).toBe('pyright');
    });

    it('should detect Go project from go.mod', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('go.mod')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('go');
      expect(result.lspServer).toBe('gopls');
    });

    it('should detect Rust project from Cargo.toml', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('Cargo.toml')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('rust');
      expect(result.lspServer).toBe('rust-analyzer');
    });

    it('should detect Java project from pom.xml', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('pom.xml')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('java');
      expect(result.lspServer).toBe('jdtls');
    });

    it('should detect Ruby project from Gemfile', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('Gemfile')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('ruby');
      expect(result.lspServer).toBe('solargraph');
    });

    it('should detect multi-language project and pick primary', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        // Node.js with 3 indicators, Python with 1
        if (p.includes('package.json') || p.includes('tsconfig.json') || p.includes('yarn.lock')) return undefined;
        if (p.includes('requirements.txt')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectProjectType('/test');
      expect(result.type).toBe('node');
    });

    it('should return unknown when no indicators found', async () => {
      (fs.access as any).mockRejectedValue(new Error('ENOENT'));

      const result = await detectProjectType('/test');
      expect(result.type).toBe('unknown');
      expect(result.lspServer).toBeNull();
    });
  });

  describe('autoConfigure', () => {
    it('should configure Node.js project', async () => {
      (fs.access as any).mockImplementation(async (p: string) => {
        if (p.includes('package.json')) return undefined;
        throw new Error('ENOENT');
      });

      const result = await autoConfigure('/test');
      expect(result.project.type).toBe('node');
      expect(result.lspEnabled).toBe(true);
      expect(result.sandboxConfigured).toBe(true);
      expect(result.summary).toContain('Node.js');
    });

    it('should handle unknown project', async () => {
      (fs.access as any).mockRejectedValue(new Error('ENOENT'));

      const result = await autoConfigure('/test');
      expect(result.project.type).toBe('unknown');
      expect(result.lspEnabled).toBe(false);
      expect(result.sandboxConfigured).toBe(false);
      expect(result.summary).toContain('No specific project type');
    });
  });

  describe('getRecommendedLsp', () => {
    it('should return LSP for Node.js', () => {
      expect(getRecommendedLsp('node')).toBe('typescript-language-server');
    });

    it('should return LSP for Python', () => {
      expect(getRecommendedLsp('python')).toBe('pyright');
    });

    it('should return null for unknown', () => {
      expect(getRecommendedLsp('unknown')).toBeNull();
    });
  });

  describe('getSupportedProjectTypes', () => {
    it('should return all supported types', () => {
      const types = getSupportedProjectTypes();
      expect(types).toContain('node');
      expect(types).toContain('python');
      expect(types).toContain('go');
      expect(types).toContain('rust');
      expect(types).toContain('java');
      expect(types).toContain('ruby');
      expect(types).toContain('cpp');
      expect(types).not.toContain('unknown');
    });
  });
});
