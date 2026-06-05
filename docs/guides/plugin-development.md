# Plugin Development Guide

KC-CLI supports plugins that extend its functionality with custom tools and hooks.

## Plugin Interface Overview

A KC-CLI plugin is an npm package that exports a `Plugin` object:

```typescript
interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: PluginHooks;
  onInit?(): Promise<void>;
  onShutdown?(): Promise<void>;
}
```

## Creating a Plugin

### Directory Structure

```
kc-plugin-hello/
  package.json
  index.js
```

### package.json Manifest

```json
{
  "name": "kc-plugin-hello",
  "version": "1.0.0",
  "description": "A hello-world plugin for KC-CLI",
  "main": "index.js",
  "kcPlugin": true
}
```

The `kcPlugin: true` field (or a package name starting with `kc-plugin-`) signals KC-CLI to load this package as a plugin.

### Entry Module

```javascript
// index.js
const { z } = require('zod');

const plugin = {
  name: 'hello',
  version: '1.0.0',
  description: 'A simple hello-world plugin',

  tools: [
    {
      name: 'Hello',
      description: 'Say hello to someone',
      inputSchema: z.object({
        name: z.string().describe('Name to greet'),
      }),
      call: async (input, context) => ({
        output: `Hello, ${input.name}!`,
        isError: false,
      }),
      checkPermissions: () => ({ behavior: 'allow' }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    },
  ],

  hooks: {
    preToolUse: async (toolName, input, context) => {
      console.log(`[hello-plugin] Tool called: ${toolName}`);
      return input; // Return modified input or null to block
    },
    postToolUse: async (toolName, input, result, context) => {
      console.log(`[hello-plugin] Tool completed: ${toolName}`);
    },
    postTurn: async (messages) => {
      console.log(`[hello-plugin] Turn completed`);
    },
  },

  async onInit() {
    console.log('Hello plugin initialized');
  },

  async onShutdown() {
    console.log('Hello plugin shutting down');
  },
};

module.exports = { plugin };
```

## Registering Tools from a Plugin

Plugins can register tools by including them in the `tools` array. Each tool must follow the `ToolDefinition` interface:

- `name`: Unique tool name
- `description`: Human-readable description
- `inputSchema`: Zod schema for input validation
- `call`: Async function that executes the tool
- `checkPermissions`: Permission check function
- `isReadOnly`: Whether the tool modifies state
- `isConcurrencySafe`: Whether the tool can run in parallel

Plugin tools are automatically registered when the plugin loads. They appear in the tool list alongside built-in tools.

## Adding Hooks

Plugins can hook into the tool execution lifecycle:

### preToolUse

Called before a tool executes. Can modify input or block execution:

```typescript
preToolUse?: (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolUseContext
) => Promise<Record<string, unknown> | null>
```

- Return modified `input` to pass to the tool
- Return `null` to block tool execution

### postToolUse

Called after a tool completes:

```typescript
postToolUse?: (
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  context: ToolUseContext
) => Promise<void>
```

### postTurn

Called after each conversation turn completes:

```typescript
postTurn?: (messages: ChatMessage[]) => Promise<void>
```

## Publishing Plugins

Publish your plugin as an npm package with the `kc-plugin-` prefix:

```bash
npm publish kc-plugin-hello
```

Users install it normally:

```bash
npm install kc-plugin-hello
```

KC-CLI discovers plugins in three ways:

1. **Project dependencies**: Packages in `node_modules/` matching `kc-plugin-*`
2. **Project package.json**: Entries in `dependencies` or `devDependencies` starting with `kc-plugin-`
3. **Local plugins**: Directories in `.kc-cli/plugins/` or `~/.kc-cli/plugins/`

## Plugin Sandboxing and Security

- Plugin tools default to `isConcurrencySafe: false` unless explicitly set
- Plugin tools that read files are auto-classified as read-only
- Plugin tools that spawn processes enforce sandbox wrapping
- Plugin hook failures log a warning but never crash the main loop
- Each plugin runs in the same process; there is no process isolation

### Best Practices

- Always validate input in your tool's `call` function
- Use `checkPermissions` to implement access controls
- Set `isReadOnly: true` for tools that do not modify state
- Handle errors gracefully; never throw from hooks
- Keep hook execution fast; long-running hooks block the agent loop
