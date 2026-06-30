// Security regression test suite
// Covers: C1 (plugin bypass), C2 (all-field path detection),
//         H1 (system write directories), H3 (dangerous commands),
//         H4 (sub-command splitting), H2 (expanded paths)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';
import { containsProtectedPath, isSystemWriteDirectory, PROTECTED_PATH_PATTERNS } from '../../src/permissions/protectedPaths';
import { isDangerousCommand, isDangerousCompoundCommand } from '../../src/permissions/classifier';
import { splitSubCommands, normalizeCommand, detectBypassAttempts } from '../../src/permissions/commandNormalizer';
import { isReadOnlyBashCommand } from '../../src/permissions/readonlyCommands';

// ── Mock state ──────────────────────────────────────────────────────────

vi.mock('../../src/bootstrap/state', () => ({
  getState: () => ({
    permissionMode: 'default',
    cwd: '/workspace',
  }),
}));

// ── Plugin rule bypass prevention (C1 regression) ─────────────────────

describe('C1 — Plugin rules cannot bypass security-critical checks', () => {
  it('plugin allow rule on /etc/shadow path must still trigger security deny', async () => {
    const mockPluginManager = {
      getPluginPermissionRules: () => [
        { toolPattern: 'FileRead', contentPattern: '/etc/shadow', behavior: 'allow' as const, priority: 1 },
      ],
    };

    const result = await hasPermissionsToUseTool(
      'FileRead',
      { path: '/etc/shadow' },
      { pluginManager: mockPluginManager }
    );

    // Security-critical MUST override plugin allow
    expect(result.behavior).toBe('ask');
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('plugin deny rule on non-protected path must still deny', async () => {
    const mockPluginManager = {
      getPluginPermissionRules: () => [
        { toolPattern: 'FileRead', behavior: 'deny' as const, priority: 1 },
      ],
    };

    const result = await hasPermissionsToUseTool(
      'FileRead',
      { path: '/tmp/test.txt' },
      { pluginManager: mockPluginManager }
    );

    expect(result.behavior).toBe('deny');
  });

  it('plugin allow rule on non-protected, non-security-critical path should allow', async () => {
    const mockPluginManager = {
      getPluginPermissionRules: () => [
        { toolPattern: 'FileRead', behavior: 'allow' as const, priority: 1 },
      ],
    };

    const result = await hasPermissionsToUseTool(
      'FileRead',
      { path: '/workspace/src/index.ts' },
      { pluginManager: mockPluginManager }
    );

    expect(result.behavior).toBe('allow');
  });

  it('plugin cannot loosen security-critical ask to allow', async () => {
    const mockPluginManager = {
      getPluginPermissionRules: () => [
        { toolPattern: 'Bash', contentPattern: '*', behavior: 'allow' as const, priority: 1 },
      ],
    };

    const result = await hasPermissionsToUseTool(
      'Bash',
      { command: 'cat /etc/passwd' },
      { pluginManager: mockPluginManager }
    );

    // Protected path must still be flagged regardless of plugin allow
    expect(result.decisionReason?.type).toBe('security_critical');
  });
});

// ── C2 — Recursive path extraction from all input fields ──────────────

describe('C2 — Security-critical path detection in all input fields', () => {
  it('detects protected path in non-standard field: source', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { source: '/etc/shadow', dest: '/tmp/x' }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in non-standard field: target', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { target: '/etc/sudoers' }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in non-standard field: destination', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { destination: '/etc/passwd' }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in array field: files[]', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { files: ['/etc/passwd', 'safe.txt', 'normal.md'] }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in nested object', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { config: { key_path: '/etc/ssl/private/key.pem' } }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in deeply nested object', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { settings: { credentials: { path: '/etc/shadow' } } }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('detects protected path in array of objects with path fields', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { configs: [{ name: 'a', path: '/workspace/src' }, { name: 'b', path: '/etc/passwd' }] }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('does not flag normal tool invocations', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { command: 'ls -la /workspace/src' }
    );
    // /workspace/src is not a protected path
    if (result.decisionReason?.type === 'security_critical') {
      expect(result.decisionReason.reason).not.toContain('/workspace');
    }
  });

  it('detects protected path in output_dir field', async () => {
    const result = await hasPermissionsToUseTool(
      'Bash',
      { output_dir: '/etc/cron.d/' }
    );
    expect(result.decisionReason?.type).toBe('security_critical');
  });
});

// ── H1 — System write directory enforcement ───────────────────────────

describe('H1 — System write directory detection', () => {
  it('isSystemWriteDirectory detects /etc/ paths', () => {
    expect(isSystemWriteDirectory('/etc/cron.d/evil')).toBe(true);
    expect(isSystemWriteDirectory('/etc/systemd/system/backdoor.service')).toBe(true);
    expect(isSystemWriteDirectory('/etc/ld.so.preload')).toBe(true);
  });

  it('isSystemWriteDirectory detects /usr/ paths', () => {
    expect(isSystemWriteDirectory('/usr/local/bin/evil')).toBe(true);
  });

  it('isSystemWriteDirectory detects /bin/ paths', () => {
    expect(isSystemWriteDirectory('/bin/evil')).toBe(true);
  });

  it('isSystemWriteDirectory detects /sbin/ paths', () => {
    expect(isSystemWriteDirectory('/sbin/evil')).toBe(true);
  });

  it('isSystemWriteDirectory does NOT flag normal paths', () => {
    expect(isSystemWriteDirectory('/home/user/project/src/main.ts')).toBe(false);
    expect(isSystemWriteDirectory('/tmp/output.log')).toBe(false);
    expect(isSystemWriteDirectory('/var/log/app.log')).toBe(false);
  });

  it('write tools trigger system write directory deny', async () => {
    // FileWrite to /etc/ should be denied
    const result = await hasPermissionsToUseTool(
      'FileWrite',
      { path: '/etc/cron.d/evil' }
    );
    expect(result.behavior).toBe('deny');
    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('write tools detect system write directory in file path', async () => {
    // FileWrite directly to a system write directory should be denied
    const result = await hasPermissionsToUseTool(
      'FileWrite',
      { path: '/etc/systemd/system/backdoor.service' }
    );
    // Contains both system write directory AND protected path
    expect(result.behavior).toBe('deny');
  });

  it('read-only tools do NOT trigger system write directory check', async () => {
    // FileRead to /etc/cron.d/ is allowed to read (but may flag protected path ask)
    const result = await hasPermissionsToUseTool(
      'FileRead',
      { path: '/etc/cron.d/somefile' }
    );
    // Should NOT be denied for system write (read-only tool)
    expect(result.behavior).not.toBe('deny');
  });
});

// ── H2 — Expanded protected path coverage ─────────────────────────────

describe('H2 — Expanded protected path detection', () => {
  describe('Credential & secret paths', () => {
    it.each([
      '/etc/ssl/private/key.pem',
      '/etc/pki/ca.crt',
      '/run/secrets/db_password',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Database credential paths', () => {
    it.each([
      '/etc/mysql/my.cnf',
      '/etc/postgresql/pg_hba.conf',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Persistence paths', () => {
    it.each([
      '/etc/cron.d/evil',
      '/etc/cron.hourly/backdoor',
      '/etc/cron.daily/persist',
      '/etc/cron.weekly/task',
      '/etc/systemd/system/backdoor.service',
      '/etc/ld.so.preload',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Sudo & auth backdoors', () => {
    it.each([
      '/etc/sudoers.d/admin',
      '/etc/pam.d/sshd',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Shell & profile injection', () => {
    it.each([
      '/etc/environment',
      '/etc/profile.d/evil.sh',
      '/root/.bashrc',
      '/root/.profile',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Application config tokens', () => {
    it.each([
      '/home/user/.aws/credentials',
      '/home/user/.aws/config',
      '/home/user/.config/gcloud/credentials.db',
      '/home/user/.config/gh/hosts.yml',
      '/home/user/.config/hub/config',
      '/home/user/.docker/config.json',
    ])('detects: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(true);
    });
  });

  describe('Normal paths not flagged', () => {
    it.each([
      '/home/user/project/src/index.ts',
      '/tmp/test.txt',
      '/var/log/app.log',
      './src/main.ts',
    ])('allows: %s', (path) => {
      expect(containsProtectedPath(path)).toBe(false);
    });
  });
});

// ── H3 — Dangerous command detection (comprehensive) ──────────────────

describe('H3 — Dangerous command detection', () => {
  describe('rm variants', () => {
    it.each([
      'rm -rf /',
      'rm -fr /tmp',
      'rm -r -f /tmp',
      'rm --recursive --force /tmp',
      'rm  -rf /tmp',
    ])('detects: %s', (cmd) => {
      const result = isDangerousCommand(cmd);
      expect(result.dangerous).toBe(true);
    });
  });

  describe('sudo-prefixed rm', () => {
    it('detects sudo rm -rf', () => {
      expect(isDangerousCommand('sudo rm -rf /').dangerous).toBe(true);
    });

    it('detects sudo /bin/rm -rf', () => {
      const normalized = normalizeCommand('sudo /bin/rm -rf /');
      expect(isDangerousCommand(normalized).dangerous).toBe(true);
    });
  });

  describe('mkfs variants', () => {
    it.each([
      'mkfs /dev/sda1',
      'mkfs.ext4 /dev/sda1',
      'mke2fs /dev/sda1',
      'mkfs.xfs /dev/sda1',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });

  describe('disk write operations', () => {
    it('detects dd with of=', () => {
      expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda').dangerous).toBe(true);
    });

    it('detects fdisk', () => {
      expect(isDangerousCommand('fdisk /dev/sda').dangerous).toBe(true);
    });

    it('detects parted', () => {
      expect(isDangerousCommand('parted /dev/sda').dangerous).toBe(true);
    });
  });

  describe('recursive permission changes', () => {
    it.each([
      'chmod -R 777 /tmp',
      'chmod -r 777 /tmp',
      'chown -R user:group /tmp',
      'chown -r user:group /tmp',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });

  describe('firewall modification', () => {
    it.each([
      'iptables -F',
      'iptables -A INPUT -j DROP',
      'iptables -t nat -A PREROUTING',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });

  describe('service control', () => {
    it.each([
      'systemctl stop firewalld',
      'systemctl disable sshd',
      'systemctl mask ufw',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });

  describe('safe commands are not flagged', () => {
    it.each([
      'rm file.txt',
      'ls -la',
      'cat /tmp/test.txt',
      'grep pattern file.txt',
      'echo hello',
      'git status',
      'npm test',
    ])('allows: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(false);
    });
  });

  describe('LVM creation', () => {
    it.each([
      'pvcreate /dev/sdb',
      'lvcreate -L 10G vg0',
      'vgcreate vg0 /dev/sdb',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });

  describe('bootloader and shutdown', () => {
    it.each([
      'update-grub',
      'grub-install /dev/sda',
      'shutdown -h now',
      'reboot',
      'halt',
      'poweroff',
    ])('detects: %s', (cmd) => {
      expect(isDangerousCommand(cmd).dangerous).toBe(true);
    });
  });
});

// ── H4 — Sub-command splitting for compound commands ─────────────────

describe('H4 — Compound command sub-command splitting', () => {
  describe('splitSubCommands', () => {
    it('splits on &&', () => {
      const parts = splitSubCommands('echo safe && rm -rf /');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some(p => p.includes('rm'))).toBe(true);
    });

    it('splits on ;', () => {
      const parts = splitSubCommands('ls; rm -rf /');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some(p => p.includes('rm'))).toBe(true);
    });

    it('splits on |', () => {
      const parts = splitSubCommands('cat file | grep pattern');
      expect(parts.length).toBe(2);
    });

    it('splits on ||', () => {
      const parts = splitSubCommands('safe_cmd || rm -rf /');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some(p => p.includes('rm'))).toBe(true);
    });

    it('returns single element for simple commands', () => {
      const parts = splitSubCommands('ls -la');
      expect(parts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isDangerousCompoundCommand', () => {
    it('detects dangerous sub-command in && chain', () => {
      const result = isDangerousCompoundCommand('echo safe && rm -rf /');
      expect(result.dangerous).toBe(true);
    });

    it('detects dangerous sub-command in ; chain', () => {
      const result = isDangerousCompoundCommand('ls; chmod -R 777 /tmp');
      expect(result.dangerous).toBe(true);
    });

    it('detects dangerous sub-command in || chain (regression)', () => {
      const result = isDangerousCompoundCommand('safe_cmd || rm -rf /');
      expect(result.dangerous).toBe(true);
    });

    it('detects dangerous sub-command in piped commands', () => {
      const result = isDangerousCompoundCommand('cat file | sudo dd of=/dev/sda');
      expect(result.dangerous).toBe(true);
    });

    it('allows safe compound commands', () => {
      const result = isDangerousCompoundCommand('ls -la && echo hello && pwd');
      expect(result.dangerous).toBe(false);
    });
  });

  describe('detectBypassAttempts (regression: || no longer excluded)', () => {
    it('detects chaining in || commands', () => {
      const result = detectBypassAttempts('safe_cmd || rm -rf /');
      expect(result.hasBypass).toBe(true);
      expect(result.vectors).toContain('command-chaining');
    });

    it('detects chaining in && commands', () => {
      const result = detectBypassAttempts('ls && rm -rf /');
      expect(result.hasBypass).toBe(true);
      expect(result.vectors).toContain('command-chaining');
    });

    it('detects multi-space bypass', () => {
      const result = detectBypassAttempts('ls   /etc');
      expect(result.hasBypass).toBe(true);
      expect(result.vectors).toContain('multi-space');
    });
  });
});

// ── Cross-cutting: engine integration ────────────────────────────────

describe('Security engine integration', () => {
  it('security-critical check runs before plugin rules', async () => {
    const mockPluginManager = {
      getPluginPermissionRules: () => [
        { toolPattern: '*', contentPattern: '*', behavior: 'allow' as const, priority: 0 },
      ],
    };

    // Even with universal plugin allow, protected paths must be flagged
    const result = await hasPermissionsToUseTool(
      'FileEdit',
      { path: '/etc/passwd' },
      { pluginManager: mockPluginManager }
    );

    expect(result.decisionReason?.type).toBe('security_critical');
  });

  it('compound commands with dangerous sub-command trigger security check', async () => {
    // echo is safe, but rm -rf targets a directory under /etc/
    const result = await hasPermissionsToUseTool(
      'Bash',
      { command: 'echo hello && rm -rf /etc/cron.d' }
    );

    // Either system write directory or dangerous command should trigger
    const isSecurityRelated =
      result.behavior === 'deny' ||
      result.decisionReason?.type === 'security_critical' ||
      result.decisionReason?.type === 'dangerous_command';
    expect(isSecurityRelated).toBe(true);
  });

  it('read-only commands are NOT flagged as dangerous', async () => {
    const safeCommands = ['ls -la', 'cat README.md', 'grep pattern *.ts', 'find . -name "*.ts"'];
    for (const cmd of safeCommands) {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
      expect(isDangerousCommand(cmd).dangerous).toBe(false);
    }
  });

  it('SYSTEM_WRITE_DIRECTORIES function is exported and functional', () => {
    expect(typeof isSystemWriteDirectory).toBe('function');
    // Spot check
    expect(isSystemWriteDirectory('/etc/anything')).toBe(true);
    expect(isSystemWriteDirectory('/usr/local/bin/x')).toBe(true);
    expect(isSystemWriteDirectory('/home/user/project/file')).toBe(false);
  });
});
