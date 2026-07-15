import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLanguageFromRegistry,
  getLanguageConfig,
  listRegisteredLanguages,
  hasCapability,
  registerLanguageServer,
  isLanguageServerAvailable,
  discoverAvailableServers,
  LANGUAGE_REGISTRY,
} from '../../src/lsp/language-registry';

// Mock child_process for execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('Language Registry', () => {
  describe('detectLanguageFromRegistry', () => {
    it('should detect TypeScript files', () => {
      expect(detectLanguageFromRegistry('file.ts')).toBe('typescript');
      expect(detectLanguageFromRegistry('file.tsx')).toBe('typescript');
      expect(detectLanguageFromRegistry('file.js')).toBe('typescript');
      expect(detectLanguageFromRegistry('file.jsx')).toBe('typescript');
    });

    it('should detect Go files', () => {
      expect(detectLanguageFromRegistry('main.go')).toBe('go');
    });

    it('should detect Python files', () => {
      expect(detectLanguageFromRegistry('script.py')).toBe('python');
    });

    it('should detect Rust files', () => {
      expect(detectLanguageFromRegistry('lib.rs')).toBe('rust');
    });

    it('should detect Java files', () => {
      expect(detectLanguageFromRegistry('Main.java')).toBe('java');
    });

    it('should detect C++ files', () => {
      expect(detectLanguageFromRegistry('main.cpp')).toBe('cpp');
      expect(detectLanguageFromRegistry('main.c')).toBe('cpp');
      expect(detectLanguageFromRegistry('header.h')).toBe('cpp');
      expect(detectLanguageFromRegistry('header.hpp')).toBe('cpp');
    });

    it('should detect Ruby files', () => {
      expect(detectLanguageFromRegistry('app.rb')).toBe('ruby');
    });

    it('should return null for unknown extensions', () => {
      expect(detectLanguageFromRegistry('file.txt')).toBeNull();
      expect(detectLanguageFromRegistry('file.md')).toBeNull();
      expect(detectLanguageFromRegistry('noext')).toBeNull();
    });

    it('should handle paths with directories', () => {
      expect(detectLanguageFromRegistry('/path/to/file.ts')).toBe('typescript');
      expect(detectLanguageFromRegistry('/deep/nested/path/main.go')).toBe('go');
    });
  });

  describe('getLanguageConfig', () => {
    it('should return config for known languages', () => {
      const tsConfig = getLanguageConfig('typescript');
      expect(tsConfig).not.toBeNull();
      expect(tsConfig!.command).toBe('typescript-language-server');
      expect(tsConfig!.extensions).toContain('.ts');
    });

    it('should return null for unknown languages', () => {
      expect(getLanguageConfig('unknown')).toBeNull();
      expect(getLanguageConfig('java')).not.toBeNull();
    });
  });

  describe('listRegisteredLanguages', () => {
    it('should list all registered languages', () => {
      const languages = listRegisteredLanguages();
      expect(languages).toContain('typescript');
      expect(languages).toContain('go');
      expect(languages).toContain('python');
      expect(languages).toContain('rust');
      expect(languages).toContain('java');
      expect(languages).toContain('cpp');
      expect(languages).toContain('ruby');
    });

    it('should return 7 languages', () => {
      expect(listRegisteredLanguages()).toHaveLength(7);
    });
  });

  describe('hasCapability', () => {
    it('should return true for supported capabilities', () => {
      expect(hasCapability('typescript', 'completion')).toBe(true);
      expect(hasCapability('typescript', 'rename')).toBe(true);
      expect(hasCapability('go', 'hover')).toBe(true);
    });

    it('should return false for unsupported capabilities', () => {
      // Ruby does not have 'rename' capability
      expect(hasCapability('ruby', 'rename')).toBe(false);
    });

    it('should return false for unknown languages', () => {
      expect(hasCapability('unknown', 'completion')).toBe(false);
    });
  });

  describe('registerLanguageServer', () => {
    it('should add a new language server', () => {
      registerLanguageServer({
        languageId: 'swift',
        extensions: ['.swift'],
        command: 'sourcekit-lsp',
        args: [],
        capabilities: ['completion', 'hover', 'definition'],
      });

      expect(getLanguageConfig('swift')).not.toBeNull();
      expect(detectLanguageFromRegistry('file.swift')).toBe('swift');
      expect(hasCapability('swift', 'completion')).toBe(true);

      // Cleanup
      const idx = LANGUAGE_REGISTRY.findIndex(c => c.languageId === 'swift');
      if (idx >= 0) LANGUAGE_REGISTRY.splice(idx, 1);
    });

    it('should replace existing language server config', () => {
      const original = getLanguageConfig('python');
      registerLanguageServer({
        languageId: 'python',
        extensions: ['.py'],
        command: 'pyright-langserver',
        args: ['--stdio'],
        capabilities: ['completion', 'hover', 'definition', 'diagnostics'],
      });

      const updated = getLanguageConfig('python');
      expect(updated!.command).toBe('pyright-langserver');

      // Restore original
      if (original) registerLanguageServer(original);
    });
  });

  describe('isLanguageServerAvailable', () => {
    it('should return false for unknown language', () => {
      expect(isLanguageServerAvailable('unknown-lang')).toBe(false);
    });

    it('should return true when binary is found', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/gopls'));

      expect(isLanguageServerAvailable('go')).toBe(true);
      expect(execSync).toHaveBeenCalledWith('command -v gopls', { stdio: 'ignore', timeout: 3000 });
    });

    it('should return false when binary is not found', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      expect(isLanguageServerAvailable('rust')).toBe(false);
    });
  });

  describe('discoverAvailableServers', () => {
    it('should return only servers whose binaries are found', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('typescript-language-server')) {
          return Buffer.from('/usr/bin/typescript-language-server');
        }
        if (typeof cmd === 'string' && cmd.includes('gopls')) {
          return Buffer.from('/usr/bin/gopls');
        }
        throw new Error('not found');
      });

      const available = discoverAvailableServers();
      expect(available.length).toBeGreaterThanOrEqual(2);
      const ids = available.map(c => c.languageId);
      expect(ids).toContain('typescript');
      expect(ids).toContain('go');
    });

    it('should return empty array when no servers available', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      const available = discoverAvailableServers();
      expect(available).toEqual([]);
    });
  });

  describe('detectLanguageFromRegistry edge cases', () => {
    it('should handle case-insensitive extensions', () => {
      expect(detectLanguageFromRegistry('file.TS')).toBe('typescript');
      expect(detectLanguageFromRegistry('file.PY')).toBe('python');
    });

    it('should handle files with no extension', () => {
      expect(detectLanguageFromRegistry('Makefile')).toBeNull();
    });

    it('should handle deeply nested paths', () => {
      expect(detectLanguageFromRegistry('/very/deep/nested/path/file.go')).toBe('go');
    });

    it('should handle .cc extension for cpp', () => {
      expect(detectLanguageFromRegistry('file.cc')).toBe('cpp');
    });
  });
});
