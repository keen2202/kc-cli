# Plugin System

Contribution-based plugin architecture with 5 contribution types.

## Plugin Interface

`src/plugins/protocol.ts`:

```typescript
interface Plugin {
  name: string;
  version: string;
  description?: string;

  // Contributions
  tools?: ToolDefinition[];
  hooks?: PluginHooks;
  permissionRules?: PluginPermissionRule[];
  prompts?: PluginPrompt[];
  mcpServers?: PluginMCPConfig[];

  // Lifecycle
  onInit?(): Promise<void>;
  onShutdown?(): Promise<void>;
}
```

## Contribution Types

### 1. Tools

Plugins can register custom tools that appear alongside built-in tools:

```typescript
const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: [{
    name: 'MyCustomTool',
    description: 'Does something custom',
    inputSchema: z.object({ input: z.string() }),
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: false,
    call: async (input, context) => ({ output: 'result' }),
  }],
};
```

### 2. Hooks

Lifecycle hooks for intercepting tool execution and turns:

```typescript
interface PluginHooks {
  preToolUse?(toolName: string, input: unknown, context: ToolUseContext):
    Promise<unknown | null>;  // null = block execution

  postToolUse?(toolName: string, input: unknown, result: ToolResult, context: ToolUseContext):
    Promise<ToolResult | null>;  // null = use original result

  preTurn?(messages: ChatMessage[], context: TurnContext):
    Promise<ChatMessage[]>;  // Return modified messages

  postTurn?(messages: ChatMessage[]): Promise<void>;

  onError?(error: Error, context: ErrorContext):
    Promise<Error | null>;  // null = swallow error
}
```

### 3. Permission Rules

Custom permission rules evaluated at Step 3.5:

```typescript
interface PluginPermissionRule {
  toolPattern: string;      // Glob: "Bash", "Web*", "*"
  contentPattern?: string;  // Regex for tool input
  behavior: 'allow' | 'deny' | 'ask';
  priority: number;         // Lower = higher priority
}
```

### 4. Prompt Templates

Custom prompt fragments injected into system prompt:

```typescript
interface PluginPrompt {
  name: string;
  template: string;
  priority: number;
  conditions?: {
    tools?: string[];      // Only when these tools are active
    providers?: string[];  // Only for these LLM providers
  };
}
```

### 5. MCP Server Configs

Plugins can register MCP servers:

```typescript
interface PluginMCPConfig {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}
```

## Plugin Lifecycle

```
1. Discovery
   └─ discoverPlugins(projectDir)
      └─ Scans: node_modules/, .kc-cli/plugins/, package.json kc-cli.plugins

2. Loading
   └─ loadPlugin(dir)
      └─ Imports module, validates interface

3. Initialization
   └─ pluginManager.loadAll()
      └─ initAll()
         └─ Calls onInit() on each plugin

4. Registration
   ├─ getPluginTools()      → ToolRegistry.pluginTools
   ├─ getPluginHooks()      → Global hook registry
   ├─ getPluginPermissionRules() → Permission engine Step 3.5
   ├─ getPluginPrompts()    → Prompt builder
   └─ getPluginMCPServers() → MCPClientManager

5. Shutdown
   └─ pluginManager.shutdown()
      └─ Calls onShutdown() on each plugin
```

## Plugin Discovery Locations

1. `node_modules/` -- npm packages with `kc-cli-plugin` keyword
2. `.kc-cli/plugins/` -- Project-local plugins
3. `package.json` `kc-cli.plugins` field -- Explicit plugin paths

## Execution Order

- **Hooks**: Registered in plugin load order, executed sequentially
- **Permission rules**: Sorted by priority (lower = first), then load order
- **Tools**: Merged into registry with plugin tools taking precedence over MCP tools

## Example Plugin

```typescript
// .kc-cli/plugins/security-scanner/index.ts
import { Plugin } from 'kc-cli/plugins';

export default {
  name: 'security-scanner',
  version: '1.0.0',
  description: 'Scans commands for security issues',

  hooks: {
    preToolUse: async (toolName, input, context) => {
      if (toolName === 'Bash') {
        const cmd = (input as any).command;
        if (cmd.includes('curl') && cmd.includes('| bash')) {
          console.warn('Blocked: piped curl to bash');
          return null; // Block execution
        }
      }
      return input; // Pass through
    },
  },

  permissionRules: [{
    toolPattern: 'Bash',
    contentPattern: '.*rm\\s+-rf\\s+/.*',
    behavior: 'deny',
    priority: 0,
  }],
} satisfies Plugin;
```
