// Environment sanitization tests — SEC-03 (round4 §2-S1/S2)
//
// These are *negative* tests: they assert secrets are absent from a child
// process that actually ran, not merely absent from a filtered object.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { buildSafeEnv, filterEnvVars } from '../../src/utils/env-sanitize';
import { LocalShell } from '../../src/services/execution-env-local';

const SECRET = 'sk-test-secret';

/** Run a child process and capture its full environment as JSON. */
function dumpChildEnv(env: Record<string, string>): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`child exited ${code}: ${err}`)); return; }
      try { resolve(JSON.parse(out) as Record<string, string>); }
      catch (e) { reject(new Error(`unparsable env dump: ${String(e)}`)); }
    });
  });
}

describe('buildSafeEnv', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['KC_API_KEY', 'KC_SEARCH_API_KEY', 'MY_TOKEN', 'KC_ALLOW_ENV_VARS'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.KC_API_KEY = SECRET;
    process.env.KC_SEARCH_API_KEY = 'sk-search-secret';
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('strips every KC_* key from the host environment', () => {
    const env = buildSafeEnv();
    expect(env).not.toHaveProperty('KC_API_KEY');
    expect(env).not.toHaveProperty('KC_SEARCH_API_KEY');
  });

  it('keeps variables a child process needs to function', () => {
    const env = buildSafeEnv();
    expect(env).toHaveProperty('PATH');
  });

  it('passes caller-declared overrides through', () => {
    const env = buildSafeEnv({ FOO: 'bar' });
    expect(env).toHaveProperty('FOO', 'bar');
  });

  it('refuses KC_* overrides even when the caller passes them deliberately', () => {
    const env = buildSafeEnv({ KC_API_KEY: 'injected' });
    expect(env).not.toHaveProperty('KC_API_KEY', 'injected');
  });

  it('refuses provider-secret and injection-vector overrides', () => {
    const env = buildSafeEnv({
      LD_PRELOAD: '/evil.so',
      NODE_OPTIONS: '--require=/evil.js',
      OPENAI_API_KEY: 'sk-openai',
      GITHUB_TOKEN: 'ghp_xxx',
    });
    expect(env).not.toHaveProperty('LD_PRELOAD');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('honours the KC_ALLOW_ENV_VARS escape hatch', () => {
    process.env.MY_TOKEN = 'tok-123';
    process.env.KC_ALLOW_ENV_VARS = 'MY_TOKEN';
    try {
      expect(buildSafeEnv()).toHaveProperty('MY_TOKEN', 'tok-123');
    } finally {
      delete process.env.MY_TOKEN;
      delete process.env.KC_ALLOW_ENV_VARS;
    }
  });
});

describe('filterEnvVars', () => {
  it('strips KC_* and dangerous vars without adding host variables', () => {
    const filtered = filterEnvVars({
      KC_API_KEY: 'leaked',
      LD_PRELOAD: '/evil.so',
      EDITOR: 'vim',
    });
    expect(filtered).not.toHaveProperty('KC_API_KEY');
    expect(filtered).not.toHaveProperty('LD_PRELOAD');
    expect(filtered).toHaveProperty('EDITOR', 'vim');
    expect(filtered).not.toHaveProperty('PATH');
  });
});

describe('child process receives no KC_* secrets', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['KC_API_KEY'] = process.env['KC_API_KEY'];
    process.env.KC_API_KEY = SECRET;
  });

  afterEach(() => {
    if (saved['KC_API_KEY'] === undefined) delete process.env['KC_API_KEY'];
    else process.env['KC_API_KEY'] = saved['KC_API_KEY']!;
  });

  it('buildSafeEnv output is a complete, secret-free environment', async () => {
    const childEnv = await dumpChildEnv(buildSafeEnv());
    const leaked = Object.keys(childEnv).filter((k) => k.toUpperCase().startsWith('KC_'));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(childEnv)).not.toContain(SECRET);
  });

  it('LocalShell no longer re-introduces process.env under a filtered env', async () => {
    // Regression guard for round4 §2-S1: the executor used to spread
    // `process.env` beneath `options.env`, undoing the caller's filter.
    const shell = new LocalShell();
    const result = await shell.exec(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify(Object.keys(process.env)))"`,
      { cwd: process.cwd(), env: buildSafeEnv() },
    );
    expect(result.exitCode).toBe(0);
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys.filter((k) => k.toUpperCase().startsWith('KC_'))).toEqual([]);
  });

  it('LocalShell falls back to a sanitized env when the caller supplies none', async () => {
    const shell = new LocalShell();
    const result = await shell.exec(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify(Object.keys(process.env)))"`,
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys.filter((k) => k.toUpperCase().startsWith('KC_'))).toEqual([]);
  });

  it('common toolchain commands still work with the sanitized env', async () => {
    const shell = new LocalShell();
    for (const command of ['node -v', 'git --version', 'npm --version']) {
      const result = await shell.exec(command, { cwd: process.cwd(), env: buildSafeEnv() });
      expect(result.exitCode, `${command} should exit 0 (stderr: ${result.stderr})`).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    }
  });
});
