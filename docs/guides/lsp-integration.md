# LSP Integration

KC-CLI integrates with Language Server Protocol (LSP) servers to provide intelligent code assistance directly in the CLI.

## Supported Languages

| Language | Server | Install |
|----------|--------|---------|
| TypeScript/JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Python | `pylsp` | `pip install python-lsp-server` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Java | `jdtls` | See [jdtls](https://github.com/eclipse/eclipse.jdt.ls) |
| C++ | `clangd` | `apt install clangd` or `brew install llvm` |

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  LSPTool     │────▶│  LSPClientManager│────▶│ Language     │
│  (tool API)  │     │  (connection     │     │ Server       │
│              │     │   lifecycle)     │     │ (stdio)      │
└──────────────┘     └──────────────────┘     └──────────────┘
       │                     │
       ▼                     ▼
┌──────────────┐     ┌──────────────────┐
│ Completion   │     │ DocumentManager  │
│ Provider     │     │ (version sync)  │
└──────────────┘     └──────────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────────┐
│ Navigation   │     │ CodeAction       │
│ Provider     │     │ Provider         │
└──────────────┘     └──────────────────┘
```

## Components

### LSPClientManager (`src/lsp/client.ts`)

Manages connections to language servers:
- Spawns server processes via `child_process.spawn`
- Implements JSON-RPC 2.0 over stdio
- Routes `publishDiagnostics` notifications to diagnostic cache
- Handles request/response correlation with timeouts

```typescript
const manager = new LSPClientManager();
await manager.connect('typescript', 'file:///project');
const diagnostics = await manager.getDiagnostics('/project/file.ts', content);
```

### DocumentManager (`src/lsp/document-manager.ts`)

Tracks document lifecycle for reliable LSP synchronization:
- `openDocument()` — sends `textDocument/didOpen`
- `updateDocument()` — sends `textDocument/didChange` with version increment
- `closeDocument()` — sends `textDocument/didClose`
- Diagnostic cache invalidation on document change

### CompletionProvider (`src/lsp/completion.ts`)

Provides code completions:
- `textDocument/completion` requests
- Snippet expansion (`$1`, `$2` placeholder parsing)
- Results sorted by LSP `sortText`
- `completionItem/resolve` for detailed info

### NavigationProvider (`src/lsp/navigation.ts`)

Code navigation features:
- **Go to Definition** — `textDocument/definition`
- **Find References** — `textDocument/references`
- **Rename** — `textDocument/rename` (updates all references)
- **Workspace Symbols** — `workspace/symbol`

### CodeActionProvider (`src/lsp/code-actions.ts`)

Quick fixes and code actions:
- Add missing imports
- Fix spelling suggestions
- `textDocument/codeAction` integration

### DiagnosticCollector (`src/lsp/diagnostics.ts`)

Diagnostic display:
- Error/warning/info severity mapping
- Integration with Sidebar FileTree (red ⚠ markers)
- Cache with version-based invalidation

## Usage

### Via LSPTool

The LSP tool exposes LSP features to the agent:

```typescript
// Get diagnostics
const diagnostics = await lspTool.execute({
  method: 'getDiagnostics',
  filePath: '/project/src/main.ts',
  content: fileContent,
});

// Get completions
const completions = await lspTool.execute({
  method: 'getCompletions',
  filePath: '/project/src/main.ts',
  content: fileContent,
  line: 10,
  character: 15,
});

// Go to definition
const definitions = await lspTool.execute({
  method: 'getDefinition',
  filePath: '/project/src/main.ts',
  content: fileContent,
  line: 10,
  character: 15,
});
```

### Via UI

- **Sidebar**: File tree shows LSP diagnostic markers (⚠ for errors, yellow for warnings)
- **Diff preview**: LSP diagnostics appear inline during code review
- **Command palette**: Access LSP commands via `/palette`

## Configuration

```json
{
  "lsp": {
    "enabled": true,
    "languages": ["typescript", "go", "python"],
    "diagnosticDelay": 500,
    "completionTriggerChars": [".", "(", ","]
  }
}
```

## Troubleshooting

### Language server not connecting

1. Verify the server binary is installed and in PATH:
   ```bash
   which typescript-language-server
   which gopls
   ```

2. Check KC-CLI logs for connection errors (use `--verbose`)

3. Test the server directly:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | \
     typescript-language-server --stdio
   ```

### Diagnostics not appearing

- Ensure the file is opened (diagnostics require `textDocument/didOpen`)
- Check that the language server supports `textDocument/publishDiagnostics`
- Some servers have a delay before publishing — KC-CLI waits up to 5 seconds

### Performance issues

- Large projects may take time to index — first diagnostics may be slow
- Consider limiting `languages` config to only needed languages
- The DocumentManager caches diagnostics to avoid redundant requests
