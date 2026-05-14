# Sandbox & Security

## Overview

KC-CLI v2 provides defense-in-depth sandboxing for all shell command execution. Commands run in isolated environments with restricted filesystem access, network isolation, and resource limits.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  ToolExecutor│────▶│  SandboxManager  │────▶│   Backend    │
│              │     │  (policy engine) │     │  (isolation) │
└──────────────┘     └──────────────────┘     └──────────────┘
                            │
                     ┌──────┴──────┐
                     ▼             ▼
              ┌──────────┐  ┌──────────┐
              │ Sandbox  │  │ Pattern  │
              │ Policy   │  │ Rules    │
              └──────────┘  └──────────┘
```

## Sandbox Backends

### Docker (recommended for CI/CD)
Container-based isolation with full resource control:
- `--network none` — no network access (default)
- `--read-only` — read-only filesystem
- `--memory 512m` — memory limit
- `--cpus 1` — CPU limit
- `--tmpfs /tmp` — writable temp directory
- Workspace mounted as bind mount

```bash
# Example: command wrapped in Docker
docker run --rm --network none --memory 512m --cpus 1 --read-only \
  --tmpfs /tmp --mount type=bind,source=/project,target=/work \
  -w /work node:22-alpine sh -c "echo hello"
```

### Bubblewrap (Linux default)
Namespace isolation using `bwrap`:
- Workspace directory mounted read-write
- System directories (/usr, /lib, /bin) mounted read-only
- Network namespace unshared (no network access)
- PID namespace unshared
- Resource limits enforced via cgroups

### Seccomp (fallback)
When bubblewrap is not available:
- Memory limits via `ulimit -v`
- CPU time limits via `timeout --signal=KILL`
- seccomp profile with syscall whitelist

### Noop (no sandbox)
When no sandbox backend is available. Commands run without isolation. A warning is displayed.

## seccomp Profile

The `seccomp-profile.json` defines allowed system calls:

**Allowed (whitelist):**
- File I/O: `read`, `write`, `open`, `close`, `stat`, `fstat`, `lstat`
- Memory: `mmap`, `mprotect`, `munmap`, `brk`, `mremap`
- Process: `getpid`, `getuid`, `getgid`, `exit_group`
- Time: `clock_gettime`, `nanosleep`
- Network: `socket`, `connect`, `accept` (when `allowNetwork: true`)

**Blocked (blacklist):**
- `ptrace` — process debugging/injection
- `mount`, `umount`, `umount2` — filesystem mounting
- `reboot` — system reboot
- `swapon`, `swapoff` — swap management
- `kexec_load` — kernel loading
- `init_module`, `finit_module` — kernel module loading

## Sandbox Policy System

Per-tool sandbox policies configure isolation behavior:

```json
{
  "toolPolicies": {
    "Bash": { "sandbox": true, "enforcement": "required" },
    "Run": { "sandbox": true, "enforcement": "required" },
    "FileRead": { "sandbox": false },
    "WebFetch": { "sandbox": true, "allowNetwork": true, "enforcement": "optional" }
  },
  "patternRules": [
    { "pattern": "git *", "sandbox": false },
    { "pattern": "npm install *", "sandbox": true, "allowNetwork": true }
  ]
}
```

### Policy Fields

| Field | Type | Description |
|-------|------|-------------|
| `sandbox` | boolean | Whether to sandbox this tool |
| `enforcement` | `required` \| `optional` | `required` = deny if sandbox unavailable; `optional` = warn and continue |
| `allowNetwork` | boolean | Allow network access in sandbox |
| `maxMemoryMb` | number | Memory limit override |
| `cpuTimeLimitSec` | number | CPU time limit override |

### Pattern Rules

Pattern rules match against the command string:
- `git *` — matches `git status`, `git commit`, etc.
- `npm install *` — matches npm install with any arguments
- Wildcards: `*` matches any characters

## Permission Model

KC-CLI uses a 6-step deny-first permission evaluation:

1. **Bypass mode** — If `--bypass-permissions`, allow all
2. **Always-deny rules** — Config-defined deny patterns
3. **Protected paths** — System directories always protected
4. **Always-allow rules** — Config-defined allow patterns
5. **Read-only classification** — Read-only tools auto-allowed
6. **Default** — Ask user for permission

### Protected Paths

The following paths are always protected, even in bypass mode:
- `/etc/passwd`, `/etc/shadow`
- `~/.ssh`, `~/.gnupg`
- `/sys/`, `/proc/`
- System binary directories

### Security-Critical Operations

These operations always require explicit approval:
- Sandbox escape attempts
- Direct filesystem access outside workspace
- Network access (when `allowNetwork: false`)
- `rm -rf /`, `mkfs`, `dd to /dev/`

## Configuration

### Via Settings File

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "docker",
    "allowNetwork": false,
    "maxMemoryMb": 512,
    "cpuTimeLimitSec": 60
  }
}
```

### Via Environment Variables

```bash
KC_SANDBOX_ENABLED=true|false
KC_SANDBOX_BACKEND=docker|bubblewrap|seccomp|noop
KC_SANDBOX_ALLOW_NETWORK=true|false
```

### Via CLI Flags

```bash
kc --no-sandbox          # Disable sandbox for this session
kc --sandbox-backend docker  # Use Docker backend
```

## Backend Selection

The sandbox manager selects the best available backend:

1. If a specific backend is configured, try to use it
2. If unavailable, fall back: Docker → Bubblewrap → Seccomp → Noop
3. Log warning when falling back

```typescript
const manager = new SandboxManager({
  workDir: cwd,
  enabled: true,
  backend: 'docker',  // Prefer Docker
});
// If Docker unavailable, falls back to Bubblewrap, then Seccomp, then Noop
```

## Tool Result Metadata

Sandboxed tool results include metadata:

```json
{
  "output": "command output...",
  "metadata": {
    "sandboxed": true,
    "sandboxBackend": "docker",
    "duration": 150
  }
}
```

## Multi-Agent Sandboxing

Sub-agents inherit sandbox configuration from the parent agent:
- Sandbox enabled/disabled state
- Backend selection
- Resource limits
- Network policy

Child agents cannot weaken sandbox settings (e.g., cannot enable network if parent has it disabled).

## Best Practices

1. **Keep sandbox enabled** in production — only disable for debugging
2. **Use Docker** for CI/CD pipelines — best isolation
3. **Configure pattern rules** for tools that need network (e.g., `npm install`)
4. **Monitor sandbox warnings** — they indicate degraded isolation
5. **Test with sandbox enabled** — ensure your workflows work within constraints
