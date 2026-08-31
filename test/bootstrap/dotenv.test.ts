// loadDotEnv — project .env file loading (problem: KC_API_KEY in .env was
// never read because no loader existed; .env.example told users to create one).
//
// Contract: values load into process.env before loadEnvConfig() runs, real
// environment variables always win over .env, inline comments on unquoted
// values are stripped (matching the .env.example format), and a missing file
// is a silent no-op.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDotEnv, resetDotEnvForTesting } from '../../src/bootstrap/config';

const TEST_KEYS = [
  'DOTENV_TEST_KEY',
  'DOTENV_TEST_INLINE',
  'DOTENV_TEST_QUOTED',
  'DOTENV_TEST_SINGLE',
  'DOTENV_TEST_EXISTING',
  'DOTENV_TEST_EXPORT',
  'DOTENV_TEST_HASH_IN_QUOTES',
  'DOTENV_TEST_EMPTY',
];

let tmpDir: string;

beforeEach(() => {
  resetDotEnvForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-dotenv-'));
  for (const key of TEST_KEYS) delete process.env[key];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of TEST_KEYS) delete process.env[key];
  resetDotEnvForTesting();
});

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.env'), content, 'utf-8');
}

describe('loadDotEnv', () => {
  it('loads simple KEY=VALUE pairs into process.env', () => {
    writeEnv('DOTENV_TEST_KEY=sk-abc123\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_KEY).toBe('sk-abc123');
  });

  it('skips blank lines and comment lines', () => {
    writeEnv('# a comment\n\n   \nDOTENV_TEST_KEY=value\n# another\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_KEY).toBe('value');
  });

  it('strips inline comments from unquoted values (.env.example format)', () => {
    writeEnv('DOTENV_TEST_INLINE=anthropic          # LLM provider: anthropic, openai, ollama\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_INLINE).toBe('anthropic');
  });

  it('strips surrounding double and single quotes', () => {
    writeEnv('DOTENV_TEST_QUOTED="quoted value"\nDOTENV_TEST_SINGLE=\'single\'\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_QUOTED).toBe('quoted value');
    expect(process.env.DOTENV_TEST_SINGLE).toBe('single');
  });

  it('preserves # inside quoted values', () => {
    writeEnv('DOTENV_TEST_HASH_IN_QUOTES="value # not a comment"\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_HASH_IN_QUOTES).toBe('value # not a comment');
  });

  it('never overwrites variables already present in process.env', () => {
    process.env.DOTENV_TEST_EXISTING = 'from-real-env';
    writeEnv('DOTENV_TEST_EXISTING=from-dotenv\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_EXISTING).toBe('from-real-env');
  });

  it('supports the optional `export ` prefix', () => {
    writeEnv('export DOTENV_TEST_EXPORT=exported\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_EXPORT).toBe('exported');
  });

  it('sets empty values for KEY= lines', () => {
    writeEnv('DOTENV_TEST_EMPTY=\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_EMPTY).toBe('');
  });

  it('ignores malformed lines and invalid key names', () => {
    writeEnv('not a kv line\n=nokey\n123BAD=x\nDOTENV_TEST_KEY=ok\n');
    loadDotEnv(tmpDir);
    expect(process.env.DOTENV_TEST_KEY).toBe('ok');
    expect(process.env['123BAD']).toBeUndefined();
  });

  it('is a no-op when the .env file does not exist', () => {
    expect(() => loadDotEnv(tmpDir)).not.toThrow();
    expect(process.env.DOTENV_TEST_KEY).toBeUndefined();
  });
});

describe('loadDotEnv idempotency', () => {
  let dir: string;
  const KEY = 'KC_DOTENV_IDEMPOTENCE_PROBE';

  beforeEach(() => {
    resetDotEnvForTesting();
    delete process.env[KEY];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[KEY];
    resetDotEnvForTesting();
  });

  it('reads .env only once across repeated calls', () => {
    fs.writeFileSync(path.join(dir, '.env'), `${KEY}=first\n`);
    loadDotEnv(dir);
    expect(process.env[KEY]).toBe('first');

    // If a second call re-read the file it would be ignored anyway (env wins),
    // so prove single-read by changing the file BEFORE the second call:
    fs.writeFileSync(path.join(dir, '.env'), `${KEY}=second\n`);
    delete process.env[KEY]; // remove env precedence so a re-read would surface
    loadDotEnv(dir);
    expect(process.env[KEY]).toBeUndefined(); // no re-read happened
  });
});
