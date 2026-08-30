// Environment secrets filtering tests — SEC-03

import { describe, it, expect, beforeAll } from 'vitest';

describe('Env secrets filtering', () => {
  beforeAll(() => {
    process.env.KC_API_KEY = 'test-api-key-123';
    process.env.KC_SEARCH_API_KEY = 'test-search-key-456';
    process.env.KC_IM_FEISHU_APP_SECRET = 'test-feishu-secret';
  });

  it('should filter KC_* prefixed vars from user-supplied env', async () => {
    const { filterEnvVars } = await import('../../src/utils/env-sanitize');
    const filtered = filterEnvVars({
      KC_API_KEY: 'leaked-key',
      EDITOR: 'vim',
      LANG: 'en_US.UTF-8',
    });
    expect(filtered).not.toHaveProperty('KC_API_KEY');
    expect(filtered).toHaveProperty('EDITOR', 'vim');
    expect(filtered).toHaveProperty('LANG', 'en_US.UTF-8');
  });

  it('should filter all KC_* prefixed vars dynamically', async () => {
    const { filterEnvVars } = await import('../../src/utils/env-sanitize');
    const filtered = filterEnvVars({
      KC_API_KEY: 'key1',
      KC_SEARCH_API_KEY: 'key2',
      KC_IM_FEISHU_APP_SECRET: 'secret1',
      KC_CUSTOM_SETTING: 'custom',
      MY_APP_KEY: 'mykey',
      EDITOR: 'vim',
    });
    expect(filtered).not.toHaveProperty('KC_API_KEY');
    expect(filtered).not.toHaveProperty('KC_SEARCH_API_KEY');
    expect(filtered).not.toHaveProperty('KC_IM_FEISHU_APP_SECRET');
    expect(filtered).not.toHaveProperty('KC_CUSTOM_SETTING');
    expect(filtered).toHaveProperty('MY_APP_KEY', 'mykey');
    expect(filtered).toHaveProperty('EDITOR', 'vim');
  });

  it('should filter system-level dangerous vars from user input', async () => {
    const { filterEnvVars } = await import('../../src/utils/env-sanitize');
    const filtered = filterEnvVars({
      LD_PRELOAD: '/evil.so',
      EDITOR: 'vim',
    });
    expect(filtered).not.toHaveProperty('LD_PRELOAD');
    expect(filtered).toHaveProperty('EDITOR', 'vim');
  });

  it('buildSafeEnv should strip KC_* but preserve system vars', async () => {
    const { buildSafeEnv } = await import('../../src/utils/env-sanitize');
    const env = buildSafeEnv();
    expect(env).not.toHaveProperty('KC_API_KEY');
    expect(env).not.toHaveProperty('KC_SEARCH_API_KEY');
    // System vars like PATH, HOME should survive
    expect(env).toHaveProperty('PATH');
  });
});
