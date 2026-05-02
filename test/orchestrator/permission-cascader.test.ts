import { describe, it, expect } from 'vitest';
import {
  deriveChildPermissions,
  buildChildToolAllowList,
  createChildPermissionContext,
  isSecurityCritical,
  isValidChildPermission,
} from '../../src/orchestrator/permission-cascader';

describe('deriveChildPermissions', () => {
  it('should inherit parent mode when no request', () => {
    expect(deriveChildPermissions('default')).toBe('default');
  });

  it('should use requested mode if allowed', () => {
    expect(deriveChildPermissions('bypassPermissions', 'auto')).toBe('auto');
  });

  it('should downgrade to most permissive allowed when requested exceeds parent', () => {
    // parent=default, allowed children=[default, plan], request=bypassPermissions -> default
    expect(deriveChildPermissions('default', 'bypassPermissions')).toBe('default');
  });

  it('should handle dontAsk parent mode', () => {
    expect(deriveChildPermissions('dontAsk')).toBe('dontAsk');
    expect(deriveChildPermissions('dontAsk', 'auto')).toBe('dontAsk');
  });

  it('should handle bypassPermissions parent', () => {
    expect(deriveChildPermissions('bypassPermissions')).toBe('bypassPermissions');
    expect(deriveChildPermissions('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions');
  });

  it('should handle auto parent', () => {
    expect(deriveChildPermissions('auto')).toBe('auto');
    expect(deriveChildPermissions('auto', 'default')).toBe('default');
    expect(deriveChildPermissions('auto', 'bypassPermissions')).toBe('auto'); // downgrade
  });

  it('should handle plan parent', () => {
    expect(deriveChildPermissions('plan')).toBe('plan');
    expect(deriveChildPermissions('plan', 'default')).toBe('plan'); // downgrade
  });

  it('should handle acceptEdits parent', () => {
    expect(deriveChildPermissions('acceptEdits', 'default')).toBe('default');
    expect(deriveChildPermissions('acceptEdits', 'plan')).toBe('plan');
  });
});

describe('buildChildToolAllowList', () => {
  const parentTools = ['FileRead', 'Bash', 'Grep', 'FileWrite', 'Agent'] as any[];

  it('should inherit all parent tools except Agent', () => {
    const result = buildChildToolAllowList(parentTools);
    expect(result).toContain('FileRead');
    expect(result).toContain('Bash');
    expect(result).toContain('Grep');
    expect(result).toContain('FileWrite');
    expect(result).not.toContain('Agent');
  });

  it('should filter to whitelisted tools', () => {
    const result = buildChildToolAllowList(parentTools, {
      tools: ['FileRead' as any, 'Grep' as any],
    });
    expect(result).toEqual(['FileRead', 'Grep']);
  });

  it('should remove blacklisted tools', () => {
    const result = buildChildToolAllowList(parentTools, {
      deniedTools: ['Bash' as any, 'FileWrite' as any],
    });
    expect(result).toContain('FileRead');
    expect(result).toContain('Grep');
    expect(result).not.toContain('Bash');
    expect(result).not.toContain('FileWrite');
    expect(result).not.toContain('Agent');
  });

  it('should apply whitelist then blacklist', () => {
    const result = buildChildToolAllowList(parentTools, {
      tools: ['FileRead' as any, 'Bash' as any, 'Grep' as any],
      deniedTools: ['Bash' as any],
    });
    expect(result).toEqual(['FileRead', 'Grep']);
  });

  it('should handle empty parent tools', () => {
    expect(buildChildToolAllowList([])).toEqual([]);
  });
});

describe('createChildPermissionContext', () => {
  it('should create child context from parent', () => {
    const parentContext = {
      mode: 'auto' as const,
      cwd: '/home/user/project',
      toolName: 'Bash',
      input: { command: 'ls' },
      alwaysDenyRules: ['rm -rf'],
      alwaysAskRules: ['git push'],
      alwaysAllowRules: ['ls'],
      bypassPermissions: false,
    };
    const child = createChildPermissionContext(parentContext, 'default');
    expect(child.mode).toBe('default');
    expect(child.cwd).toBe('/home/user/project');
    expect(child.alwaysDenyRules).toEqual(['rm -rf']);
    expect(child.alwaysAskRules).toEqual(['git push']);
    expect(child.alwaysAllowRules).toEqual(['ls']);
    expect(child.bypassPermissions).toBe(false);
  });

  it('should set bypassPermissions for bypassPermissions mode', () => {
    const parentContext = {
      mode: 'default' as const,
      cwd: '/project',
      toolName: '',
      input: {},
      bypassPermissions: false,
    };
    const child = createChildPermissionContext(parentContext, 'bypassPermissions');
    expect(child.bypassPermissions).toBe(true);
  });
});

describe('isSecurityCritical', () => {
  it('should detect /etc/passwd', () => {
    expect(isSecurityCritical('FileRead', { path: '/etc/passwd' })).toBe(true);
  });

  it('should detect .ssh', () => {
    expect(isSecurityCritical('Bash', { command: 'cat ~/.ssh/id_rsa' })).toBe(true);
  });

  it('should detect /sys/', () => {
    expect(isSecurityCritical('FileRead', { path: '/sys/class/net' })).toBe(true);
  });

  it('should detect /proc/', () => {
    expect(isSecurityCritical('Bash', { file_path: '/proc/1/status' })).toBe(true);
  });

  it('should return false for normal paths', () => {
    expect(isSecurityCritical('FileRead', { path: '/home/user/project/file.ts' })).toBe(false);
  });

  it('should return false for empty input', () => {
    expect(isSecurityCritical('Bash', {})).toBe(false);
  });

  it('should check command field', () => {
    expect(isSecurityCritical('Bash', { command: 'cat /etc/shadow' })).toBe(true);
  });
});

describe('isValidChildPermission', () => {
  it('should validate allowed child modes', () => {
    expect(isValidChildPermission('bypassPermissions', 'bypassPermissions')).toBe(true);
    expect(isValidChildPermission('bypassPermissions', 'auto')).toBe(true);
    expect(isValidChildPermission('default', 'default')).toBe(true);
    expect(isValidChildPermission('default', 'plan')).toBe(true);
  });

  it('should reject disallowed child modes', () => {
    expect(isValidChildPermission('default', 'bypassPermissions')).toBe(false);
    expect(isValidChildPermission('plan', 'default')).toBe(false);
    expect(isValidChildPermission('dontAsk', 'auto')).toBe(false);
  });
});
