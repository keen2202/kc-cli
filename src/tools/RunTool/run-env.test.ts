// Security tests for RunTool environment variable filtering

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Replicate the filter logic for testing

const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5LIB',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
  'PATH',
  'HOME',
  'SHELL',
  'BASH_ENV',
  'PROMPT_COMMAND',
  'IFS',
  'CDPATH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'ANSIBLE_CONFIG',
  'DOCKER_HOST',
  'KUBECONFIG',
]);

function getAllowlistedEnvVars(): Set<string> {
  return new Set(
    (process.env.KC_ALLOW_ENV_VARS || '')
      .split(',')
      .map(v => v.trim().toUpperCase())
      .filter(Boolean)
  );
}

function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const allowlisted = getAllowlistedEnvVars();
  const filtered: Record<string, string> = {};
  const blockedVars: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (DANGEROUS_ENV_VARS.has(upperKey) && !allowlisted.has(upperKey)) {
      blockedVars.push(key);
      continue;
    }
    filtered[key] = value;
  }

  return filtered;
}

describe('RunTool Environment Variable Filtering', () => {
  describe('Blocks Dangerous Variables', () => {
    it('filters LD_PRELOAD', () => {
      const result = filterEnvVars({
        LD_PRELOAD: '/tmp/evil.so',
        DEBUG: 'true',
      });
      expect(result).not.toHaveProperty('LD_PRELOAD');
      expect(result).toHaveProperty('DEBUG', 'true');
    });

    it('filters LD_LIBRARY_PATH', () => {
      const result = filterEnvVars({ LD_LIBRARY_PATH: '/tmp/evil' });
      expect(result).not.toHaveProperty('LD_LIBRARY_PATH');
    });

    it('filters NODE_OPTIONS', () => {
      const result = filterEnvVars({ NODE_OPTIONS: '--require=/tmp/evil.js' });
      expect(result).not.toHaveProperty('NODE_OPTIONS');
    });

    it('filters PYTHONSTARTUP', () => {
      const result = filterEnvVars({ PYTHONSTARTUP: '/tmp/evil.py' });
      expect(result).not.toHaveProperty('PYTHONSTARTUP');
    });

    it('filters PERL5LIB', () => {
      const result = filterEnvVars({ PERL5LIB: '/tmp/evil' });
      expect(result).not.toHaveProperty('PERL5LIB');
    });

    it('filters RUBYOPT', () => {
      const result = filterEnvVars({ RUBYOPT: '-e system("id")' });
      expect(result).not.toHaveProperty('RUBYOPT');
    });

    it('filters PATH override', () => {
      const result = filterEnvVars({ PATH: '/tmp/evil:/usr/bin' });
      expect(result).not.toHaveProperty('PATH');
    });

    it('filters HOME override', () => {
      const result = filterEnvVars({ HOME: '/tmp' });
      expect(result).not.toHaveProperty('HOME');
    });

    it('filters DYLD_INSERT_LIBRARIES (macOS)', () => {
      const result = filterEnvVars({ DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' });
      expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    });
  });

  describe('Allows Safe Variables', () => {
    it('passes DEBUG', () => {
      const result = filterEnvVars({ DEBUG: 'true' });
      expect(result).toHaveProperty('DEBUG', 'true');
    });

    it('passes NODE_ENV', () => {
      const result = filterEnvVars({ NODE_ENV: 'production' });
      expect(result).toHaveProperty('NODE_ENV', 'production');
    });

    it('passes custom app vars', () => {
      const result = filterEnvVars({
        APP_PORT: '3000',
        DATABASE_URL: 'postgres://localhost/db',
        LOG_LEVEL: 'debug',
      });
      expect(result).toHaveProperty('APP_PORT', '3000');
      expect(result).toHaveProperty('DATABASE_URL');
      expect(result).toHaveProperty('LOG_LEVEL', 'debug');
    });

    it('passes empty env', () => {
      const result = filterEnvVars({});
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe('Case Insensitive Blocking', () => {
    it('filters lowercase ld_preload', () => {
      const result = filterEnvVars({ ld_preload: '/tmp/evil.so' });
      expect(result).not.toHaveProperty('ld_preload');
    });

    it('filters mixed case Ld_Preload', () => {
      const result = filterEnvVars({ Ld_Preload: '/tmp/evil.so' });
      expect(result).not.toHaveProperty('Ld_Preload');
    });
  });

  describe('Allowlist Override via KC_ALLOW_ENV_VARS', () => {
    const originalAllowlist = process.env.KC_ALLOW_ENV_VARS;

    afterEach(() => {
      if (originalAllowlist === undefined) {
        delete process.env.KC_ALLOW_ENV_VARS;
      } else {
        process.env.KC_ALLOW_ENV_VARS = originalAllowlist;
      }
    });

    it('allows PATH when allowlisted', () => {
      process.env.KC_ALLOW_ENV_VARS = 'PATH';
      const result = filterEnvVars({ PATH: '/custom/bin:/usr/bin' });
      expect(result).toHaveProperty('PATH', '/custom/bin:/usr/bin');
    });

    it('allows HOME when allowlisted', () => {
      process.env.KC_ALLOW_ENV_VARS = 'HOME';
      const result = filterEnvVars({ HOME: '/custom/home' });
      expect(result).toHaveProperty('HOME', '/custom/home');
    });

    it('allows multiple vars when comma-separated', () => {
      process.env.KC_ALLOW_ENV_VARS = 'PATH,HOME,SHELL';
      const result = filterEnvVars({
        PATH: '/a',
        HOME: '/b',
        SHELL: '/bin/zsh',
        LD_PRELOAD: '/evil.so',
      });
      expect(result).toHaveProperty('PATH');
      expect(result).toHaveProperty('HOME');
      expect(result).toHaveProperty('SHELL');
      expect(result).not.toHaveProperty('LD_PRELOAD');
    });
  });
});
