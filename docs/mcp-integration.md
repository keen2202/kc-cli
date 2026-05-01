# MCP Integration

## Overview

KC-CLI supports the Model Context Protocol (MCP) for connecting to external tool servers. MCP servers provide additional tools that the agent can use.

## Configuration

### Project config: `.mcp.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"],
      "enabled": true
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/sse",
      "enabled": true
    }
  }
}
```

### User config: `~/.kc-cli/mcp.json`

Same format. Project config overrides user config for same server names.

## Transport Types

### stdio
Spawns a child process and communicates via JSON-RPC over stdin/stdout.

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
  "env": { "KEY": "value" }
}
```

### http
Connects to an HTTP+SSE endpoint.

```json
{
  "type": "http",
  "url": "https://mcp.example.com/sse"
}
```

## Tool Naming

MCP tools are registered with the prefix `mcp_{serverId}_{toolName}`. For example, a tool named `read_file` on server `filesystem` becomes `mcp_filesystem_read_file`.

## Troubleshooting

- **Server fails to connect**: Check that the command exists and the args are correct. Use `--verbose` to see connection errors.
- **Tools not appearing**: Ensure `enabled: true` is set. Check that the server advertises tools in its `tools/list` response.
- **Timeout errors**: MCP requests timeout after 30 seconds. Check server responsiveness.
