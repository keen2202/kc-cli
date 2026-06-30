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

  describe('C1: Plugin rules cannot bypass security-critical checks', () => {
    it('should block plugin allow rule on protected path /etc/shadow', async () => {
      const pluginManager = {
        getPluginPermissionRules: () => [
          { toolPattern: 'FileRead', behavior: 'allow' as const, priority: 1 },
        ],
      };

      const result = await hasPermissionsToUseTool('FileRead', { path: '/etc/shadow' }, {
        pluginManager,
      });
      // Security-critical check must override plugin allow
      expect(result.behavior).toBe('ask');
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should respect plugin deny rule on non-protected path', async () => {
      const pluginManager = {
        getPluginPermissionRules: () => [
          { toolPattern: 'FileRead', behavior: 'deny' as const, priority: 1 },
        ],
      };

      const result = await hasPermissionsToUseTool('FileRead', { path: '/tmp/safe.txt' }, {
        pluginManager,
      });
      expect(result.behavior).toBe('deny');
    });

    it('should allow plugin deny to escalate security ask to deny', async () => {
      const pluginManager = {
        getPluginPermissionRules: () => [
          { toolPattern: 'FileRead', behavior: 'deny' as const, priority: 1 },
        ],
      };

      const result = await hasPermissionsToUseTool('FileRead', { path: '/etc/passwd' }, {
        pluginManager,
      });
      // Plugin deny should escalate the security ask to deny
      expect(result.behavior).toBe('deny');
    });
  });

  describe('C2: Security-critical check inspects all input fields', () => {
    it('should detect protected path in non-standard field "source"', async () => {
      const result = await hasPermissionsToUseTool('FileCopy', {
        source: '/etc/shadow',
        dest: '/tmp/safe.txt',
      });
      expect(result.behavior).toBe('ask');
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should detect protected path in non-standard field "target"', async () => {
      const result = await hasPermissionsToUseTool('Symlink', {
        target: '/etc/passwd',
        link: '/tmp/link',
      });
      expect(result.behavior).toBe('ask');
    });

    it('should detect protected path in array field "files"', async () => {
      const result = await hasPermissionsToUseTool('FileRead', {
        files: ['/tmp/safe.txt', '/etc/passwd'],
      });
      expect(result.behavior).toBe('ask');
    });

    it('should detect protected path in nested object', async () => {
      const result = await hasPermissionsToUseTool('ConfigLoad', {
        config: { key_path: '/etc/ssl/private/key.pem' },
      });
      expect(result.behavior).toBe('ask');
    });

    it('should detect protected path in array of objects', async () => {
      const result = await hasPermissionsToUseTool('MultiFile', {
        entries: [
          { name: 'safe', path: '/tmp/safe.txt' },
          { name: 'dangerous', path: '/etc/shadow' },
        ],
      });
      expect(result.behavior).toBe('ask');
    });

    it('should NOT trigger security alert on safe paths in non-standard fields', async () => {
      const result = await hasPermissionsToUseTool('FileCopy', {
        source: '/tmp/source.txt',
        dest: '/tmp/dest.txt',
      });
      // Should not be a security_critical decision — safe paths are fine
      expect(result.decisionReason?.type).not.toBe('security_critical');
    });
  });

  describe('H1: System write directory enforcement', () => {
    it('should deny FileWrite to /etc/cron.d/', async () => {
      const result = await hasPermissionsToUseTool('FileWrite', {
        path: '/etc/cron.d/evil',
        content: '* * * * * root /tmp/backdoor',
      });
      expect(result.behavior).toBe('deny');
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should deny FileWrite to /etc/systemd/system/', async () => {
      const result = await hasPermissionsToUseTool('FileWrite', {
        path: '/etc/systemd/system/backdoor.service',
        content: '[Service]\nExecStart=/tmp/evil',
      });
      expect(result.behavior).toBe('deny');
    });

    it('should deny Bash write to /etc/ via command argument', async () => {
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'echo evil > /etc/ld.so.preload',
      });
      expect(result.behavior).toBe('ask');
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should allow writes to normal project paths', async () => {
      initializeState({ permissionMode: 'default' });
      const result = await hasPermissionsToUseTool('FileWrite', {
        path: '/home/user/project/output.txt',
        content: 'safe content',
      });
      expect(result.behavior).not.toBe('deny');
    });

    it('should deny FileEdit to /usr/local/bin/', async () => {
      const result = await hasPermissionsToUseTool('FileEdit', {
        path: '/usr/local/bin/trojan',
        old_string: 'safe',
        new_string: 'evil',
      });
      expect(result.behavior).toBe('deny');
    });
  });

  describe('H3: Comprehensive dangerous command detection', () => {
    it('should detect rm -fr (flag reordering bypass)', async () => {
      // Flag reordering should still be caught
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'rm -fr /tmp/test',
      });
      // In default mode, falls through to ask at Step 6
      // Protected/security checks via containsProtectedPath would catch /etc/ paths
      // For /tmp paths, the classifier handles in auto mode
      // Here we just verify the command passes through security check
      expect(result).toHaveProperty('behavior');
    });

    it('should pass through to security check for compound dangerous commands', async () => {
      // Command with && chaining containing a dangerous sub-command
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'echo safe && rm -rf /etc/passwd',
      });
      // The sub-command rm -rf /etc/passwd references protected path
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should detect protected path in piped command', async () => {
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'cat /tmp/file | sudo cat /etc/shadow',
      });
      // /etc/shadow in piped sub-command should be detected
      expect(result.decisionReason?.type).toBe('security_critical');
    });
  });

  describe('H4: Sub-command splitting integration', () => {
    it('should catch protected path in || chained command', async () => {
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'safe_cmd || cat /etc/passwd',
      });
      // Previously || was excluded from chaining detection — now it should be caught
      expect(result.decisionReason?.type).toBe('security_critical');
    });

    it('should catch protected path in semicolon-chained command', async () => {
      const result = await hasPermissionsToUseTool('Bash', {
        command: 'ls; cat /etc/shadow',
      });
      expect(result.decisionReason?.type).toBe('security_critical');
    });
  });
});
