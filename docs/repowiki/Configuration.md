# Configuration

5-layer configuration system with Zod validation and parallel file loading.

## Priority Order (Ascending)

```
1. System defaults        (Zod schema defaults)
2. User config            (~/.kc-cli/settings.json)
3. Project config         (.kc-cli/settings.json in CWD)
4. Environment variables  (KC_*)
5. CLI arguments          (passed at invocation)
```

Higher priority overrides lower. All layers are merged at startup.

## File Locations

| Layer | Path | Scope |
|-------|------|-------|
| User | `~/.kc-cli/settings.json` | All projects |
| Project | `.kc-cli/settings.json` | Current project |

Both files are read in parallel for reduced latency.

## Environment Variables

| Variable | Maps To | Example |
|----------|---------|---------|
| `KC_API_KEY` | `api.apiKey` | `sk-xxx` |
| `KC_PROVIDER` | `api.provider` | `anthropic` |
| `KC_MODEL` | `api.model` | `claude-sonnet-4-6` |
| `KC_API_BASE_URL` | `api.apiBaseUrl` | `https://api.openai.com/v1` |
| `KC_PERMISSION_MODE` | `permissions.mode` | `default` |
| `KC_SANDBOX_ENABLED` | `sandbox.enabled` | `true` |
| `KC_SANDBOX_BACKEND` | `sandbox.backend` | `docker` |
| `KC_MEMORY_ENABLED` | `memory.enabled` | `true` |
| `KC_SEARCH_PROVIDER` | `web.searchProvider` | `tavily` |
| `KC_SEARCH_API_KEY` | `web.searchApiKey` | `xxx` |
| `KC_VERBOSE` | `general.verbose` | `true` |

## Config Schema

`src/bootstrap/config.ts` -- Zod-validated:

### API Config
```typescript
{
  api: {
    apiKey: string;
    apiBaseUrl?: string;
    model: string;           // Default: "deepseek-v4-pro"
    provider: string;        // Default: "deepseek"
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  }
}
```

### Permission Config
```typescript
{
  permissions: {
    mode: PermissionMode;    // Default: "default"
    alwaysAllowRules: Rule[];
    alwaysDenyRules: Rule[];
    alwaysAskRules: Rule[];
  }
}
```

### Tool Config
```typescript
{
  tools: {
    toolTimeout: number;     // Default: 30 (seconds)
    maxFileReadSize: number; // Default: 100000 (bytes)
    maxOutputSize: number;   // Default: 10000 (bytes)
  }
}
```

### Sandbox Config
```typescript
{
  sandbox: {
    enabled: boolean;        // Default: true
    backend: string;         // Default: "bubblewrap"
    allowNetwork: boolean;   // Default: false
    maxMemoryMb: number;     // Default: 512
    cpuTimeLimitSec: number; // Default: 60
    failIfNoSandbox: boolean; // Default: false
    defaultEnforcement: string; // Default: "preferred"
    toolPolicies: Record<string, string>;
    patternRules: Array<{ pattern: string; enforcement: string }>;
  }
}
```

### Memory Config
```typescript
{
  memory: {
    enabled: boolean;        // Default: true
    autoExtract: boolean;    // Default: true
    autoConsolidate: boolean; // Default: true
    idleThresholdMinutes: number;   // Default: 5
    consolidationMinHours: number;  // Default: 24
    consolidationMinSessions: number; // Default: 5
    maxMemoriesPerType: number;     // Default: 50
    maxSessionSnapshots: number;    // Default: 100
    sessionRetentionDays: number;   // Default: 30
    relevanceSearchLimit: number;   // Default: 5
  }
}
```

### Web Config
```typescript
{
  web: {
    searchProvider: string;  // Default: "tavily"
    searchApiKey?: string;
  }
}
```

### General Config
```typescript
{
  general: {
    verbose: boolean;        // Default: false
    color: boolean;          // Default: true
  }
}
```

## Config Loading Flow

```
1. Read user config (~/.kc-cli/settings.json)  ─┐
2. Read project config (.kc-cli/settings.json)  ─┤ (parallel)
                                                  │
3. Parse env vars (KC_*)                         ◄┘
4. Parse CLI arguments
5. Merge: defaults < user < project < env < CLI
6. Validate with Zod schema
7. Return ConfigSchema
```

## CLI Arguments

```
-c, --cwd <directory>       Working directory
-m, --mode <mode>           Permission mode
--model <model>             LLM model
--provider <provider>       LLM provider
--max-turns <number>        Maximum agent turns
--max-budget <amount>       Maximum budget (USD)
-v, --verbose               Verbose output
--print                     Print response and exit
--bare                      Minimal mode
--bypass-permissions        Bypass permission checks
--profile                   Show startup profile
--acp                       ACP server mode (JSON-RPC over stdio)
--json                      NDJSON event output
--json-pretty               Pretty-printed JSON output
```

## Auto-Configuration

`src/bootstrap/autoConfig.ts`:

On first run, detects project type and generates initial config:
- `package.json` → Node.js project
- `requirements.txt` / `pyproject.toml` → Python project
- `go.mod` → Go project
- `Cargo.toml` → Rust project
- `pom.xml` / `build.gradle` → Java project

Generates `.kc-cli/settings.json` with appropriate defaults for the detected project type.
