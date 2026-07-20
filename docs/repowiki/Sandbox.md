# Sandbox

Namespace-based command isolation with multiple backends, HMAC signing, and per-tool policies.

## Backend Fallback Chain

```
bubblewrap (preferred)
    ↓ (not available)
seccomp
    ↓ (not available)
docker
    ↓ (not available)
windows-sandbox (Windows only)
    ↓ (not available)
noop (no isolation, logs warning)
```

Selection happens at startup via `SandboxManager`. Each backend implements the same interface:
- `wrapCommand(command, options)` -- Returns isolated command string
- `isAvailable()` -- Runtime capability check
- `getBackendName()` -- For metadata

## SandboxManager

`src/services/sandbox.ts`:

### Core Responsibilities
- Backend selection and fallback chain execution
- Per-tool policy resolution
- HMAC-signed sandbox markers
- Resource limit enforcement

### Command Wrapping

```typescript
// Before sandbox
"rm -rf /tmp/test"

// After bubblewrap wrapCommand()
"bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --unshare-net --die-with-parent -- rm -rf /tmp/test"
```

### HMAC Signing

```typescript
const SANDBOX_WRAPPED_MARKER = '__KC_SANDBOX_WRAPPED__';
const SANDBOX_SIGNATURE_KEY = process.pid + '-' + crypto.randomUUID();

// Signature prevents external code from forging the wrapped state
const signature = hmacSHA256(command + marker, signatureKey);
```

The tool executor verifies the signature before trusting that a command was sandbox-wrapped.

## Backends

### BubblewrapSandbox (`sandbox-profiles.ts`)
- Lightweight namespace isolation
- Filesystem: read-only bind mount of `/`, writable `/tmp`
- Network: `--unshare-net` disables networking
- Process: `--unshare-pid` isolates process tree
- Resource: `--cap-drop ALL` removes capabilities

### SeccompSandbox (`sandbox-profiles.ts`)
- Syscall whitelist filtering
- Blocks: `ptrace`, `mount`, `umount`, `reboot`, `swapon`, `pivot_root`
- Profile: `seccomp-profile.json`
- Works with both bubblewrap and Docker

### DockerSandbox (`sandbox-docker.ts`)
- Full container isolation
- `--network none` -- Network isolation
- `--read-only` -- Read-only root filesystem
- `--memory 512m` -- Memory limit (configurable)
- `--cpus 1` -- CPU limit
- `--security-opt seccomp=profile.json` -- Seccomp profile
- Lazy-loaded (only instantiated when Docker is available)

### WindowsSandbox (`sandbox-windows.ts`)
- Native Windows job objects
- Process isolation via `CreateJobObject`
- Resource limits via `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`
- Lazy-loaded (Windows only)

### NoopSandbox (`sandbox-profiles.ts`)
- No isolation, passes commands through
- Logs warning about missing sandbox
- Used when `failIfNoSandbox` is false and no backend available

## Platform Isolation Strength

Isolation guarantees vary significantly by platform:

| Platform | Available Backends | Isolation Strength | Notes |
|----------|-------------------|-------------------|-------|
| **Linux** | bubblewrap, seccomp, Docker | **Strong** | Namespace isolation (PID, IPC, network, mount), syscall filtering, resource limits, capabilities dropping. Native, no extra dependencies beyond `apt install bubblewrap`. |
| **macOS** | Docker only | **Container** | Requires Docker Desktop. Set `KC_SANDBOX_BACKEND=docker`. Without Docker, the process will **hard-fail on startup** (since `failIfNoSandbox` defaults to `true`). To develop without a sandbox, explicitly opt out: `KC_SANDBOX_FAIL_IF_NO_SANDBOX=false`. |
| **Windows** | Docker, windows-sandbox (job objects) | **Container / Partial** | Docker Desktop recommended for strong isolation. The native `windows-sandbox` backend provides process-level isolation via `CreateJobObject` with resource limits but no filesystem or network isolation. |

### Platform Setup

**Linux** (recommended for production):
```bash
sudo apt install bubblewrap
# Ready — no further configuration needed
```

**macOS**:
```bash
# Required: Docker Desktop
brew install --cask docker
# Then configure:
export KC_SANDBOX_BACKEND=docker
# Or if developing without a sandbox (NOT for production):
export KC_SANDBOX_FAIL_IF_NO_SANDBOX=false
```

**Windows**:
```bash
# Option A: Docker Desktop (recommended)
winget install Docker.DockerDesktop
export KC_SANDBOX_BACKEND=docker

# Option B: Native job objects (partial isolation)
# Enabled automatically, no extra setup
```

**Recommendation**: Use Linux for production and security-sensitive workloads. Docker Desktop provides adequate isolation on macOS/Windows for development. Never set `failIfNoSandbox=false` when processing untrusted input.

## Per-Tool Policies

`src/services/sandbox-policy.ts`:

### Enforcement Levels

| Level | Behavior |
|-------|----------|
| `required` | Must be sandboxed, fail if no sandbox |
| `preferred` | Use sandbox if available, warn if not |
| `optional` | Use sandbox if available, silent if not |
| `excluded` | Never sandbox (e.g., tools that need full access) |
| `inherit` | Use `defaultEnforcement` setting |

### Policy Resolution

```
1. Exact tool name match in toolPolicies
2. Pattern match in patternRules
3. Default enforcement level
```

### Configuration

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "bubblewrap",
    "allowNetwork": false,
    "maxMemoryMb": 512,
    "cpuTimeLimitSec": 60,
    "failIfNoSandbox": false,
    "defaultEnforcement": "preferred",
    "toolPolicies": {
      "Bash": "required",
      "Agent": "excluded"
    },
    "patternRules": [
      { "pattern": "Web*", "enforcement": "excluded" }
    ]
  }
}
```

## Runtime Monitoring

### SandboxProbe (`sandbox-probe.ts`)
4 verification tests for escape detection:
1. **Filesystem isolation** -- Cannot read host files outside bind mounts
2. **Network isolation** -- Cannot make outbound connections (if `--unshare-net`)
3. **Process isolation** -- Cannot see host processes
4. **Privilege escalation** -- Cannot escalate privileges

### SandboxMonitor (`sandbox-monitor.ts`)
Runtime resource tracking:
- Docker: `docker stats` for CPU, memory, network, I/O
- Host: `/proc/self/cgroup`, `/proc/self/status` for resource usage
- Alerts on resource limit approaches

## Compaction

Four-tier compaction engine in `src/services/compaction/`:

| Engine | Priority | LLM Call | Strategy |
|--------|----------|----------|----------|
| CachedMicro | 0 | No | Hash-cached strip of tool results |
| Snip | 10 | No | Remove middle messages (>5000 chars) |
| Full | 20 | Yes | LLM summarization with retry |
| Force | 30 | No | Hard truncation to token limit |

Engines are tried in priority order. If one reduces tokens but not enough, the next engine chains. Circuit breaker disables compaction after repeated failures.

### CachedMicroCompaction
- Computes hash of conversation state
- Returns cached result if hash matches
- Strips tool result content (keeps tool calls)
- Cheapest option, no LLM call

### SnipCompaction
- Identifies large messages (>5000 chars)
- Removes from the middle of conversation (preserves recent context)
- No LLM call, preserves conversation flow

### FullCompaction
- Sends conversation to LLM for summarization
- Preserves key decisions, tool results, and user intent
- Retry logic with exponential backoff
- Most expensive but highest quality

### ForceTruncation
- Absolute last resort
- Hard truncation to fit within token limit
- Preserves system prompt and last N messages
- Data loss is expected
