// Tests for permission engine - 6-step decision flow

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  initializeState();
});

describe('PermissionEngine', () => {
  describe('Step 1: deny rules take priority', () => {
    it('should deny tool matching alwaysDenyRules', async () => {
      const result = await hasPermissionsToUseTool('Bash', {}, {
        config: { alwaysDenyRules: ['Bash'] },
      });
      expect(result.behavior).toBe('deny');
    });

    it('should deny with content-specific deny rule', async () => {
      const result = await hasPermissionsToUseTool('Bash', { command: 'rm -rf /' }, {
        content: 'rm -rf /',
        config: { alwaysDenyRules: ['Bash(rm *)'] },
      });
      expect(result.behavior).toBe('deny');
    });

    it('deny rules should override allow rules', async () => {
      const result = await hasPermissionsToUseTool('Bash', {}, {
        config: {
          alwaysDenyRules: ['Bash'],
          alwaysAllowRules: ['Bash'],
        },
      });
      expect(result.behavior).toBe('deny');
    });
  });

  describe('Step 2: tool-specific permission check', () => {
    it('should use tool checkPermissions result', async () => {
      const toolCheckPermissions = vi.fn().mockReturnValue({
        behavior: 'deny',
        message: 'Tool says no',
      });

      const result = await hasPermissionsToUseTool('CustomTool', {}, { toolCheckPermissions });
      expect(result.behavior).toBe('deny');
      expect(toolCheckPermissions).toHaveBeenCalled();
    });

    it('should pass through tool allow result', async () => {
      const toolCheckPermissions = vi.fn().mockReturnValue({
        behavior: 'allow',
        updatedInput: {},
      });

      const result = await hasPermissionsToUseTool('CustomTool', {}, { toolCheckPermissions });
      expect(result.behavior).toBe('allow');
    });

    it('should continue to security check when tool says ask', async () => {
      const toolCheckPermissions = vi.fn().mockReturnValue({
        behavior: 'ask',
        message: 'Tool needs permission',
      });

      const result = await hasPermissionsToUseTool('Bash', { command: 'ls' }, { toolCheckPermissions });
      // Should proceed through the engine, not immediately return
      expect(result.behavior).toBeDefined();
    });
  });

  describe('Step 3: security-critical checks (bypass-immune)', () => {
    it('should ask for protected path even in bypass mode', async () => {
      const result = await hasPermissionsToUseTool('FileRead', { path: '/etc/passwd' });
      expect(result.behavior).toBe('ask');
    });

    it('should ask for .ssh access', async () => {
      const result = await hasPermissionsToUseTool('FileRead', { path: '/home/user/.ssh/id_rsa' });
      expect(result.behavior).toBe('ask');
    });

    it('should ask for .env access', async () => {
      const result = await hasPermissionsToUseTool('FileRead', { path: '/project/.env' });
      expect(result.behavior).toBe('ask');
    });
  });

  describe('Step 4: bypass permission mode', () => {
    it('should allow non-security-critical tools in bypass mode', async () => {
      initializeState({ permissionMode: 'bypassPermissions' });
      const result = await hasPermissionsToUseTool('FileRead', { path: '/project/src/index.ts' });
      expect(result.behavior).toBe('allow');
    });

    it('should still ask for protected paths in bypass mode', async () => {
      initializeState({ permissionMode: 'bypassPermissions' });
      const result = await hasPermissionsToUseTool('FileRead', { path: '/etc/passwd' });
      expect(result.behavior).toBe('ask');
    });
  });

  describe('Step 5: allow rules', () => {
    it('should allow tool matching alwaysAllowRules', async () => {
      const result = await hasPermissionsToUseTool('FileRead', {}, {
        config: { alwaysAllowRules: ['FileRead'] },
      });
      expect(result.behavior).toBe('allow');
    });

    it('should allow with content-specific allow rule', async () => {
      const result = await hasPermissionsToUseTool('Bash', { command: 'ls -la' }, {
        content: 'ls -la',
        config: { alwaysAllowRules: ['Bash(ls *)'] },
      });
      expect(result.behavior).toBe('allow');
    });

    it('allow rules should not override security checks', async () => {
      const result = await hasPermissionsToUseTool('FileRead', { path: '/etc/passwd' }, {
        config: { alwaysAllowRules: ['FileRead'] },
      });
      // Security check (protected path) should still trigger
      expect(result.behavior).toBe('ask');
    });
  });

  describe('Step 6: mode defaults', () => {
    it('should deny in dontAsk mode when no rules match', async () => {
      initializeState({ permissionMode: 'dontAsk' });
      const result = await hasPermissionsToUseTool('UnknownTool', {});
      expect(result.behavior).toBe('deny');
    });

    it('should ask in default mode when no rules match', async () => {
      initializeState({ permissionMode: 'default' });
      const result = await hasPermissionsToUseTool('UnknownTool', {});
      expect(result.behavior).toBe('ask');
    });
  });

  describe('edge cases', () => {
    it('should handle empty config', async () => {
      const result = await hasPermissionsToUseTool('Bash', {});
      expect(result.behavior).toBeDefined();
    });

    it('should handle undefined toolCheckPermissions', async () => {
      const result = await hasPermissionsToUseTool('Bash', { command: 'echo hello' });
      expect(result.behavior).toBeDefined();
    });

    it('should handle multiple deny rules', async () => {
      const result = await hasPermissionsToUseTool('Bash', {}, {
        config: { alwaysDenyRules: ['Bash', 'FileWrite', 'Agent'] },
      });
      expect(result.behavior).toBe('deny');
    });

    it('should handle multiple allow rules', async () => {
      const result = await hasPermissionsToUseTool('FileRead', {}, {
        config: { alwaysAllowRules: ['FileRead', 'Glob', 'Grep'] },
      });
      expect(result.behavior).toBe('allow');
    });
  });
});
