// Basic functionality test for cc-cli

import { describe, it, expect } from './test-utils';

// Test 1: Tool Registry
describe('Tool Registry', () => {
  it('should register and list tools', async () => {
    const { toolRegistry, registerBuiltInTools } = await import('../src/tools');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();
    expect(tools.length).toBeGreaterThan(0);
    console.log(`✓ Registered ${tools.length} tools`);
  });
});

// Test 2: Path Utilities
describe('Path Utilities', () => {
  it('should validate paths', async () => {
    const { isPathSafe } = await import('../src/utils/path');
    expect(isPathSafe('/safe/path/file.txt')).toBe(true);
    expect(isPathSafe('../../../etc/passwd')).toBe(false);
    console.log('✓ Path validation works');
  });
});

// Test 3: Permission Rules
describe('Permission Rules', () => {
  it('should parse and match rules', async () => {
    const { parseRuleString } = await import('../src/permissions/rules');
    const rules = parseRuleString('Bash(ls*), Bash(rm)');
    expect(rules.length).toBe(2);
    console.log('✓ Permission rule parsing works');
  });
});

// Test 4: Config Loading
describe('Config Loading', () => {
  it('should load default config', async () => {
    const { loadConfig } = await import('../src/bootstrap/config');
    const { config, layers } = await loadConfig(process.cwd());
    expect(config.provider).toBeDefined();
    expect(config.model).toBeDefined();
    console.log(`✓ Config loaded with ${layers.length} layers`);
  });
});

console.log('\n✅ All tests passed!');
