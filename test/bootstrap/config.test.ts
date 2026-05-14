// Configuration Loading System Tests
// Covers: ConfigSchema validation, file loading, env var loading, layer merging
//
// Uses vi.mock('os') to override os.homedir for user config path tests.
// Uses mutable hoisted homedir state so tests can change the mock at runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── os.homedir mocking ───────────────────────────────────────────────────
// We must mock the entire 'os' module because ESM module namespace objects
// are read-only.  The mock preserves all real os exports but overrides
// homedir with a mutable function we can change per-test.

const homedirMock = vi.hoisted(() => {
  let _value = '/tmp/kc-cli-test-default-home';
  return {
    getHomedir: () => _value,
    setHomedir: (v: string) => {
      _value = v;
    },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: homedirMock.getHomedir,
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────

const KC_PREFIX_RE = /^KC_/;

function cleanEnvVars(): void {
  for (const key of Object.keys(process.env)) {
    if (KC_PREFIX_RE.test(key)) {
      delete process.env[key];
    }
  }
}

function mkdir(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(data));
}

// ── 1. ConfigSchema Validation ──────────────────────────────────────────

describe('ConfigSchema', () => {
  it('should parse empty input with all defaults correct', async () => {
    const { ConfigSchema } = await import('../../src/bootstrap/config');
    const config = ConfigSchema.parse({});

    expect(config.model).toBe('deepseek-v4-pro');
    expect(config.provider).toBe('deepseek');
    expect(config.permissionMode).toBe('default');
    expect(config.permissions).toEqual({ allow: [], deny: [], ask: [] });
    expect(config.additionalDirectories).toEqual([]);
    expect(config.toolTimeout).toBe(30);
    expect(config.maxFileReadSize).toBe(100000);
    expect(config.maxOutputSize).toBe(10000);
    expect(config.searchProvider).toBe('tavily');
    expect(config.searchApiKey).toBeUndefined();
    expect(config.verbose).toBe(false);
    expect(config.color).toBe(true);

    // Memory defaults
    expect(config.memory.enabled).toBe(true);
    expect(config.memory.autoExtract).toBe(true);
    expect(config.memory.autoConsolidate).toBe(true);
    expect(config.memory.idleThresholdMinutes).toBe(5);
    expect(config.memory.consolidationMinHours).toBe(24);
    expect(config.memory.consolidationMinSessions).toBe(5);
    expect(config.memory.extractionTurnThrottle).toBe(3);
    expect(config.memory.maxMemoriesPerType).toBe(50);
    expect(config.memory.maxSessionSnapshots).toBe(100);
    expect(config.memory.sessionRetentionDays).toBe(30);
    expect(config.memory.relevanceSearchLimit).toBe(5);

    // Sandbox defaults
    expect(config.sandbox.enabled).toBe(true);
    expect(config.sandbox.backend).toBe('bubblewrap');
    expect(config.sandbox.allowNetwork).toBe(false);
    expect(config.sandbox.maxMemoryMb).toBe(512);
    expect(config.sandbox.cpuTimeLimitSec).toBe(60);
    expect(config.sandbox.defaultEnforcement).toBe('preferred');
    expect(config.sandbox.toolPolicies).toEqual({});
    expect(config.sandbox.patternRules).toEqual([]);

    // MCP defaults
    expect(config.mcp.enabled).toBe(true);

    // Database defaults
    expect(config.databaseConnections).toEqual({});
  });

  it('should reject invalid provider values', async () => {
    const { ConfigSchema } = await import('../../src/bootstrap/config');
    expect(() => ConfigSchema.parse({ provider: 'invalid-provider' })).toThrow();
  });

  it('should reject invalid permissionMode values', async () => {
    const { ConfigSchema } = await import('../../src/bootstrap/config');
    expect(() => ConfigSchema.parse({ permissionMode: 'invalid-mode' })).toThrow();
  });

  it('should accept all 7 valid provider values', async () => {
    const { ConfigSchema } = await import('../../src/bootstrap/config');
    const validProviders = ['anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible', 'qwen', 'glm'] as const;
    for (const provider of validProviders) {
      const config = ConfigSchema.parse({ provider });
      expect(config.provider).toBe(provider);
    }
  });

  it('should accept all 6 valid permissionMode values', async () => {
    const { ConfigSchema } = await import('../../src/bootstrap/config');
    const validModes = ['default', 'bypassPermissions', 'dontAsk', 'plan', 'acceptEdits', 'auto'] as const;
    for (const mode of validModes) {
      const config = ConfigSchema.parse({ permissionMode: mode });
      expect(config.permissionMode).toBe(mode);
    }
  });
});

// ── 2. loadConfigFile ───────────────────────────────────────────────────

describe('loadConfigFile', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a valid JSON config file', async () => {
    tmpDir = fs.mkdtempSync('/tmp/loadconfigfile-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'claude-opus', provider: 'anthropic' });

    const { loadConfigFile } = await import('../../src/bootstrap/config');
    const result = await loadConfigFile(path.join(tmpDir, '.kc-cli', 'settings.json'));

    expect(result).not.toBeNull();
    expect(result!.model).toBe('claude-opus');
    expect(result!.provider).toBe('anthropic');
  });

  it('should return null when config file does not exist', async () => {
    tmpDir = fs.mkdtempSync('/tmp/loadconfigfile-');

    const { loadConfigFile } = await import('../../src/bootstrap/config');
    const result = await loadConfigFile(path.join(tmpDir, 'nonexistent.json'));

    expect(result).toBeNull();
  });

  it('should return null on JSON parse error', async () => {
    tmpDir = fs.mkdtempSync('/tmp/loadconfigfile-');
    const kcDir = mkdir(tmpDir, '.kc-cli');
    fs.writeFileSync(path.join(kcDir, 'settings.json'), '{ invalid json }');

    const { loadConfigFile } = await import('../../src/bootstrap/config');
    const result = await loadConfigFile(path.join(kcDir, 'settings.json'));

    expect(result).toBeNull();
  });

  it('should return partial config without validation', async () => {
    tmpDir = fs.mkdtempSync('/tmp/loadconfigfile-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), {
      model: 'gpt-4',
      extraField: 'should-be-ignored-at-load-time',
    });

    const { loadConfigFile } = await import('../../src/bootstrap/config');
    const result = await loadConfigFile(path.join(tmpDir, '.kc-cli', 'settings.json'));

    expect(result).not.toBeNull();
    expect(result!.model).toBe('gpt-4');
    expect((result! as any).extraField).toBe('should-be-ignored-at-load-time');
  });

  it('should handle empty JSON object', async () => {
    tmpDir = fs.mkdtempSync('/tmp/loadconfigfile-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), {});

    const { loadConfigFile } = await import('../../src/bootstrap/config');
    const result = await loadConfigFile(path.join(tmpDir, '.kc-cli', 'settings.json'));

    expect(result).not.toBeNull();
    expect(result).toEqual({});
  });
});

// ── 3. loadEnvConfig ────────────────────────────────────────────────────

describe('loadEnvConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    cleanEnvVars();
  });

  afterEach(() => {
    cleanEnvVars();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should read KC_API_KEY', async () => {
    process.env.KC_API_KEY = 'sk-test-key';
    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();
    expect(config.apiKey).toBe('sk-test-key');
  });

  it('should read KC_API_BASE_URL', async () => {
    process.env.KC_API_BASE_URL = 'https://custom.api.com';
    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();
    expect(config.apiBaseUrl).toBe('https://custom.api.com');
  });

  it('should read KC_MODEL', async () => {
    process.env.KC_MODEL = 'gpt-4-turbo';
    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();
    expect(config.model).toBe('gpt-4-turbo');
  });

  it('should read KC_PROVIDER', async () => {
    process.env.KC_PROVIDER = 'openai';
    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();
    expect(config.provider).toBe('openai');
  });

  it('should read KC_SEARCH_PROVIDER and KC_SEARCH_API_KEY', async () => {
    process.env.KC_SEARCH_PROVIDER = 'google';
    process.env.KC_SEARCH_API_KEY = 'search-key-abc';
    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();
    expect(config.searchProvider).toBe('google');
    expect(config.searchApiKey).toBe('search-key-abc');
  });

  it('should parse KC_VERBOSE as true for "true" and "1", false otherwise', async () => {
    const { loadEnvConfig } = await import('../../src/bootstrap/config');

    process.env.KC_VERBOSE = 'true';
    expect(loadEnvConfig().verbose).toBe(true);

    process.env.KC_VERBOSE = '1';
    expect(loadEnvConfig().verbose).toBe(true);

    process.env.KC_VERBOSE = 'false';
    expect(loadEnvConfig().verbose).toBe(false);

    process.env.KC_VERBOSE = '0';
    expect(loadEnvConfig().verbose).toBe(false);

    process.env.KC_VERBOSE = 'anything';
    expect(loadEnvConfig().verbose).toBe(false);
  });

  it('should read all sandbox env vars', async () => {
    process.env.KC_SANDBOX_ENABLED = 'true';
    process.env.KC_SANDBOX_BACKEND = 'docker';
    process.env.KC_SANDBOX_ALLOW_NETWORK = 'true';
    process.env.KC_SANDBOX_MAX_MEMORY_MB = '2048';
    process.env.KC_SANDBOX_CPU_TIME_LIMIT_SEC = '300';
    process.env.KC_SANDBOX_DEFAULT_ENFORCEMENT = 'required';

    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();

    expect(config.sandbox!.enabled).toBe(true);
    expect(config.sandbox!.backend).toBe('docker');
    expect(config.sandbox!.allowNetwork).toBe(true);
    expect(config.sandbox!.maxMemoryMb).toBe(2048);
    expect(config.sandbox!.cpuTimeLimitSec).toBe(300);
    expect(config.sandbox!.defaultEnforcement).toBe('required');
  });

  it('should parse KC_SANDBOX_TOOL_POLICIES valid JSON', async () => {
    process.env.KC_SANDBOX_TOOL_POLICIES = JSON.stringify({
      Bash: { allowNetwork: true, maxMemoryMb: 256 },
      FileRead: { enforcement: 'required' },
    });

    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();

    expect(config.sandbox!.toolPolicies).toEqual({
      Bash: { allowNetwork: true, maxMemoryMb: 256 },
      FileRead: { enforcement: 'required' },
    });
  });

  it('should fall back silently on invalid KC_SANDBOX_TOOL_POLICIES JSON', async () => {
    process.env.KC_SANDBOX_TOOL_POLICIES = 'not valid json';

    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();

    // toolPolicies should be undefined since the catch block doesn't set it
    expect(config.sandbox!.toolPolicies).toBeUndefined();
  });

  it('should read memory env vars', async () => {
    process.env.KC_MEMORY_ENABLED = 'true';
    process.env.KC_MEMORY_AUTO_EXTRACT = 'false';

    const { loadEnvConfig } = await import('../../src/bootstrap/config');
    const config = loadEnvConfig();

    expect(config.memory!.enabled).toBe(true);
    expect(config.memory!.autoExtract).toBe(false);
  });
});

// ── 4. loadConfig — integration ─────────────────────────────────────────

describe('loadConfig — integration', () => {
  let tmpDir: string;
  let tmpUserDir: string;

  afterEach(() => {
    cleanEnvVars();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (tmpUserDir) fs.rmSync(tmpUserDir, { recursive: true, force: true });
    homedirMock.setHomedir('/tmp/kc-cli-test-default-home');
  });

  it('should load user config from ~/.kc-cli/settings.json', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), { model: 'user-specific-model' });

    homedirMock.setHomedir(tmpUserDir);
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-proj-');

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.model).toBe('user-specific-model');
  });

  it('should load project config from .kc-cli/settings.json', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'project-specific-model' });

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.model).toBe('project-specific-model');
  });

  it('should return full defaults when no config files exist', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-empty-');
    homedirMock.setHomedir('/tmp/kc-cli-nonexistent-home');

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config, layers } = await loadConfig(tmpDir);

    expect(config.model).toBe('deepseek-v4-pro');
    expect(config.provider).toBe('deepseek');
    // Only defaults and env layers
    expect(layers.filter((l) => l.source === 'user').length).toBe(0);
    expect(layers.filter((l) => l.source === 'project').length).toBe(0);
  });

  it('should handle JSON parse errors gracefully via loadConfig', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-bad-json-');
    fs.writeFileSync(
      path.join(mkdir(tmpDir, '.kc-cli'), 'settings.json'),
      'this is not valid json',
    );

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    // Should not throw and return defaults
    expect(config.model).toBe('deepseek-v4-pro');
  });

  it('should include correct sources in layers array', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-layers-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), { model: 'user' });

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-layers-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'project' });

    process.env.KC_MODEL = 'env';
    homedirMock.setHomedir(tmpUserDir);

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { layers } = await loadConfig(tmpDir);

    expect(layers.length).toBe(4);
    expect(layers[0].source).toBe('defaults');
    expect(layers[1].source).toBe('user');
    expect(layers[2].source).toBe('project');
    expect(layers[3].source).toBe('env');
  });

  it('should apply env vars on top of file configs', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-env-override-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'from-file', verbose: true });

    process.env.KC_MODEL = 'from-env';

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.model).toBe('from-env');
    expect(config.verbose).toBe(true);
  });

  it('should read KC_PERMISSION_MODE env var', async () => {
    process.env.KC_PERMISSION_MODE = 'dontAsk';

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-perm-');

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.permissionMode).toBe('dontAsk');
  });
});

// ── 5. Config Layer Merging ─────────────────────────────────────────────

describe('Config Layer Merging', () => {
  let tmpDir: string;
  let tmpUserDir: string;

  afterEach(() => {
    cleanEnvVars();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (tmpUserDir) fs.rmSync(tmpUserDir, { recursive: true, force: true });
    homedirMock.setHomedir('/tmp/kc-cli-test-default-home');
  });

  it('project config should override user config', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-merge1-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), { model: 'user-model', verbose: true });

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-merge1-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'project-model' });

    homedirMock.setHomedir(tmpUserDir);

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.model).toBe('project-model');
    expect(config.verbose).toBe(true); // inherited from user config
  });

  it('env config should override all file configs', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-merge2-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), { model: 'user-model' });

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-merge2-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'project-model' });

    process.env.KC_MODEL = 'env-model';
    homedirMock.setHomedir(tmpUserDir);

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.model).toBe('env-model');
  });

  it('should produce all 4 layers in correct priority order', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-merge3-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), { model: 'a' });

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-merge3-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), { model: 'b' });

    process.env.KC_MODEL = 'c';
    homedirMock.setHomedir(tmpUserDir);

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { layers } = await loadConfig(tmpDir);

    expect(layers.length).toBe(4);
    expect(layers[0].source).toBe('defaults');
    expect(layers[1].source).toBe('user');
    expect(layers[2].source).toBe('project');
    expect(layers[3].source).toBe('env');
    // Priority: later layers win
    expect(layers[3].config.model).toBe('c');
  });

  it('should deep merge nested sandbox config (partial override preserves defaults)', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-dmerge-sb-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), {
      sandbox: { enabled: false, maxMemoryMb: 256 },
    });

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.sandbox.enabled).toBe(false);
    expect(config.sandbox.maxMemoryMb).toBe(256);
    // Unset fields should retain defaults from schema
    expect(config.sandbox.backend).toBe('bubblewrap');
    expect(config.sandbox.allowNetwork).toBe(false);
    expect(config.sandbox.cpuTimeLimitSec).toBe(60);
    expect(config.sandbox.defaultEnforcement).toBe('preferred');
    expect(config.sandbox.toolPolicies).toEqual({});
  });

  it('should deep merge nested memory config', async () => {
    tmpDir = fs.mkdtempSync('/tmp/kc-cli-dmerge-mem-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), {
      memory: { enabled: false, autoExtract: false },
    });

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    expect(config.memory.enabled).toBe(false);
    expect(config.memory.autoExtract).toBe(false);
    // Unset fields should retain defaults
    expect(config.memory.autoConsolidate).toBe(true);
    expect(config.memory.idleThresholdMinutes).toBe(5);
    expect(config.memory.consolidationMinHours).toBe(24);
  });

  it('should replace arrays, not merge them', async () => {
    tmpUserDir = fs.mkdtempSync('/tmp/kc-cli-array-merge-user-');
    writeConfig(mkdir(tmpUserDir, '.kc-cli'), {
      permissions: { allow: ['Bash', 'FileRead'] },
      additionalDirectories: ['/dir1', '/dir2'],
    });

    tmpDir = fs.mkdtempSync('/tmp/kc-cli-array-merge-proj-');
    writeConfig(mkdir(tmpDir, '.kc-cli'), {
      permissions: { allow: ['FileWrite'] },
      additionalDirectories: ['/dir3'],
    });

    homedirMock.setHomedir(tmpUserDir);

    const { loadConfig } = await import('../../src/bootstrap/config');
    const { config } = await loadConfig(tmpDir);

    // Arrays from project should replace arrays from user (not concatenated)
    expect(config.permissions.allow).toEqual(['FileWrite']);
    expect(config.additionalDirectories).toEqual(['/dir3']);
  });
});

// ── 6. deepMerge & mergeConfigLayers (unit) ─────────────────────────────

describe('deepMerge', () => {
  it('should merge flat objects', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should deep merge nested objects', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const result = deepMerge(
      { outer: { a: 1, b: 2 } },
      { outer: { b: 3, c: 4 } },
    );
    expect(result).toEqual({ outer: { a: 1, b: 3, c: 4 } });
  });

  it('should replace arrays, not merge them', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const result = deepMerge(
      { items: [1, 2, 3], name: 'old' },
      { items: [4, 5], name: 'new' },
    );
    expect(result.items).toEqual([4, 5]);
    expect(result.name).toBe('new');
  });

  it('should skip undefined values in source', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const result = deepMerge(
      { a: 1, b: 2 },
      { a: undefined, b: 3 },
    );
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('should handle null values', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const result = deepMerge(
      { a: { nested: 'keep' } },
      { a: null } as any,
    );
    // null is typeof 'object' but value is null → the type guard catches it
    expect(result.a).toBeNull();
  });

  it('should not mutate the target object', async () => {
    const { deepMerge } = await import('../../src/bootstrap/config');
    const target = { a: 1, nested: { b: 2 } };
    const source = { a: 2, nested: { c: 3 } };

    const result = deepMerge(target, source);

    expect(target).toEqual({ a: 1, nested: { b: 2 } }); // unchanged
    expect(result).toEqual({ a: 2, nested: { b: 2, c: 3 } });
  });
});

describe('mergeConfigLayers', () => {
  it('should merge layers in ascending priority order', async () => {
    const { mergeConfigLayers } = await import('../../src/bootstrap/config');
    const result = mergeConfigLayers([
      { source: 'defaults', config: { model: 'default-model', verbose: false } },
      { source: 'project', config: { model: 'project-model' } },
      { source: 'env', config: { verbose: true } },
    ]);
    expect(result).toEqual({
      model: 'project-model',
      verbose: true,
    });
  });

  it('should handle empty layers array', async () => {
    const { mergeConfigLayers } = await import('../../src/bootstrap/config');
    const result = mergeConfigLayers([]);
    expect(result).toEqual({});
  });

  it('should handle single layer', async () => {
    const { mergeConfigLayers } = await import('../../src/bootstrap/config');
    const result = mergeConfigLayers([
      { source: 'user', config: { model: 'only', provider: 'ollama' } },
    ]);
    expect(result).toEqual({ model: 'only', provider: 'ollama' });
  });
});
