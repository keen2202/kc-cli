# Sandbox & Security

## Permission Model

KC-CLI uses a 6-step deny-first permission evaluation:

1. **Bypass mode** -- If `--bypass-permissions`, allow all
2. **Always-deny rules** -- Config-defined deny patterns
3. **Protected paths** -- System directories always protected
4. **Always-allow rules** -- Config-defined allow patterns
5. **Read-only classification** -- Read-only tools auto-allowed
6. **Default** -- Ask user for permission

## Sandbox Backends

### Bubblewrap (Linux, default)
Namespace isolation using `bwrap`:
- Workspace directory mounted read-write
- System directories (/usr, /lib, /bin) mounted read-only
- Network namespace unshared (no network access)
- PID namespace unshared
- Resource limits enforced (memory, CPU)

### Seccomp (fallback)
When bubblewrap is not available:
- Memory limits via `ulimit -v`
- CPU time limits via `timeout --signal=KILL`

### Noop (no sandbox)
When no sandbox backend is available. Commands run without isolation. A warning is displayed.

## Configuration

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "bubblewrap",
    "allowNetwork": false,
    "maxMemoryMb": 512,
    "cpuTimeLimitSec": 60
  }
}
```

Environment variables:
- `KC_SANDBOX_ENABLED=true|false`
- `KC_SANDBOX_BACKEND=bubblewrap|seccomp|noop`
- `KC_SANDBOX_ALLOW_NETWORK=true|false`

## Protected Operations

The following are always denied even in bypass mode:
- Sandbox escape attempts
- Direct filesystem access outside workspace
- Network access (when `allowNetwork: false`)
