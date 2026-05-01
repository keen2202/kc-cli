# Configuration Reference

## Config Sources (priority ascending)

1. **Defaults** -- Zod schema defaults
2. **User config** -- `~/.kc-cli/settings.json`
3. **Project config** -- `.kc-cli/settings.json`
4. **Environment variables** -- `KC_*` prefix
5. **CLI arguments** -- Command-line flags

## Settings

### API
| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| apiKey | KC_API_KEY | -- | LLM API key |
| apiBaseUrl | KC_API_BASE_URL | -- | Custom API endpoint |
| model | KC_MODEL | deepseek-v4-pro | Model identifier |
| provider | KC_PROVIDER | deepseek | LLM provider |

### Providers
`anthropic`, `openai`, `deepseek`, `qwen`, `glm`, `openai-compatible`, `ollama`

### Permissions
| Key | Default | Description |
|-----|---------|-------------|
| permissionMode | default | default, bypassPermissions, dontAsk, plan, acceptEdits, auto |
| permissions.allow | [] | Always-allow tool patterns |
| permissions.deny | [] | Always-deny tool patterns |
| permissions.ask | [] | Always-ask tool patterns |

### Sandbox
| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| sandbox.enabled | KC_SANDBOX_ENABLED | true | Enable sandbox |
| sandbox.backend | KC_SANDBOX_BACKEND | bubblewrap | Sandbox backend |
| sandbox.allowNetwork | KC_SANDBOX_ALLOW_NETWORK | false | Allow network in sandbox |
| sandbox.maxMemoryMb | -- | 512 | Memory limit (MB) |
| sandbox.cpuTimeLimitSec | -- | 60 | CPU time limit (sec) |

### Memory
| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| memory.enabled | KC_MEMORY_ENABLED | true | Enable memory system |
| memory.autoExtract | KC_MEMORY_AUTO_EXTRACT | true | Auto-extract memories |

### Web Search
| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| searchProvider | KC_SEARCH_PROVIDER | tavily | Search provider |
| searchApiKey | KC_SEARCH_API_KEY | -- | Search API key |

Providers: `tavily`, `brave`

### MCP
MCP servers are configured in `.mcp.json` (project) or `~/.kc-cli/mcp.json` (user):
```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "enabled": true
    }
  }
}
```

### General
| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| verbose | KC_VERBOSE | false | Verbose output |
| color | -- | true | Colored output |
