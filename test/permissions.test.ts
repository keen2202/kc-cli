// Permission System Tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRuleString, formatRuleString, matchRuleContent } from '../src/permissions/rules.js';
import { containsProtectedPath, isProtectedPath } from '../src/permissions/protectedPaths.js';
import { PermissionClassifier } from '../src/permissions/classifier.js';
import { initializeState } from '../src/bootstrap/state.js';

beforeEach(() => {
  initializeState();
});

describe('Permission Rules', () => {
  it('should parse simple tool name', () => {
    const result = parseRuleString('Bash');
    expect(result.toolName).toBe('Bash');
    expect(result.ruleContent).toBeUndefined();
  });

  it('should parse tool name with content pattern', () => {
    const result = parseRuleString('Bash(ls *)');
    expect(result.toolName).toBe('Bash');
    expect(result.ruleContent).toBe('ls *');
  });

  it('should parse tool name with file path pattern', () => {
    const result = parseRuleString('FileWrite(/src/*)');
    expect(result.toolName).toBe('FileWrite');
    expect(result.ruleContent).toBe('/src/*');
  });

  it('should format simple rule', () => {
    const ruleValue = { toolName: 'Bash', ruleContent: undefined };
    expect(formatRuleString(ruleValue)).toBe('Bash');
  });

  it('should format rule with content', () => {
    const ruleValue = { toolName: 'Bash', ruleContent: 'ls *' };
    expect(formatRuleString(ruleValue)).toBe('Bash(ls *)');
  });

  it('should match exact content', () => {
    expect(matchRuleContent('ls -la', 'ls -la')).toBe(true);
    expect(matchRuleContent('ls -la', 'cat file.txt')).toBe(false);
  });

  it('should match wildcard pattern', () => {
    expect(matchRuleContent('ls *', 'ls -la')).toBe(true);
    expect(matchRuleContent('ls *', 'ls')).toBe(false);
  });

  it('should match prefix pattern', () => {
    expect(matchRuleContent('git:*', 'git status')).toBe(true);
    expect(matchRuleContent('git:*', 'git commit')).toBe(true);
    expect(matchRuleContent('git:*', 'npm run')).toBe(false);
  });
});

describe('Protected Paths', () => {
  it('should detect /etc/passwd', () => {
    expect(containsProtectedPath('/etc/passwd')).toBe(true);
    expect(isProtectedPath('/etc/passwd')).toBe(true);
  });

  it('should detect /etc/shadow', () => {
    expect(containsProtectedPath('/etc/shadow')).toBe(true);
    expect(isProtectedPath('/etc/shadow')).toBe(true);
  });

  it('should detect .ssh directory', () => {
    expect(containsProtectedPath('/home/user/.ssh/key')).toBe(true);
    expect(isProtectedPath('/home/user/.ssh/key')).toBe(true);
  });

  it('should detect .gnupg directory', () => {
    expect(containsProtectedPath('/home/user/.gnupg/gpg.conf')).toBe(true);
  });

  it('should allow normal paths', () => {
    expect(containsProtectedPath('/home/user/project/file.txt')).toBe(false);
    expect(isProtectedPath('/home/user/project/file.txt')).toBe(false);
  });

  it('should allow src directory', () => {
    expect(containsProtectedPath('/project/src/index.ts')).toBe(false);
    expect(isProtectedPath('/project/src/index.ts')).toBe(false);
  });
});

describe('Permission Classifier', () => {
  it('should allow safe read-only tools', async () => {
    const classifier = new PermissionClassifier();

    const result = await classifier.classify('FileRead', { path: 'test.txt' }, {} as any);
    expect(result.behavior).toBe('allow');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('should deny dangerous commands', async () => {
    const classifier = new PermissionClassifier();

    const result = await classifier.classify('Bash', { command: 'rm -rf /' }, {} as any);
    expect(result.behavior).toBe('deny');
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it('should ask for unknown commands', async () => {
    const classifier = new PermissionClassifier();

    const result = await classifier.classify('Bash', { command: 'unknown-command' }, {} as any);
    expect(result.behavior).toBe('ask');
  });

  it('should track denial count', () => {
    const classifier = new PermissionClassifier();

    classifier.trackDenial({ behavior: 'deny', confidence: 0.99, reason: 'test' });
    classifier.trackDenial({ behavior: 'deny', confidence: 0.99, reason: 'test' });

    const stats = classifier.getStats();
    expect(stats.consecutiveDenials).toBe(2);
    expect(stats.totalDenials).toBe(2);
  });

  it('should reset consecutive count on allow', () => {
    const classifier = new PermissionClassifier();

    classifier.trackDenial({ behavior: 'deny', confidence: 0.99, reason: 'test' });
    classifier.trackDenial({ behavior: 'deny', confidence: 0.99, reason: 'test' });
    classifier.trackDenial({ behavior: 'allow', confidence: 0.99, reason: 'test' });

    const stats = classifier.getStats();
    expect(stats.consecutiveDenials).toBe(0);
    expect(stats.totalDenials).toBe(2);
  });

  it('should reset all counters', () => {
    const classifier = new PermissionClassifier();

    classifier.trackDenial({ behavior: 'deny', confidence: 0.99, reason: 'test' });
    classifier.reset();

    const stats = classifier.getStats();
    expect(stats.consecutiveDenials).toBe(0);
    expect(stats.totalDenials).toBe(0);
  });
});

describe('Permission Engine Config', () => {
  it('should accept config with rules', async () => {
    const { hasPermissionsToUseTool } = await import('../src/permissions/engine.js');

    const config = {
      alwaysDenyRules: ['DangerousTool'],
      alwaysAllowRules: ['FileRead'],
    };

    // FileRead should be allowed due to alwaysAllowRules
    const result = await hasPermissionsToUseTool('FileRead', {}, { config });
    expect(result.behavior).toBe('allow');
  });

  it('should deny tools in alwaysDenyRules', async () => {
    const { hasPermissionsToUseTool } = await import('../src/permissions/engine.js');

    const config = {
      alwaysDenyRules: ['Bash'],
    };

    const result = await hasPermissionsToUseTool('Bash', {}, { config });
    expect(result.behavior).toBe('deny');
  });
});
