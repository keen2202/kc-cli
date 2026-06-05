# Migration Guide: v1 → v2

This guide helps you upgrade from KC-CLI v0.1.x to v2.0.0.

## Breaking Changes

### 1. Sandbox Enabled by Default

Bash and Run commands are now sandboxed by default. Commands that access the network or write outside the workspace may fail.

**Before (v1):** All commands run without isolation.
**After (v2):** Commands run in Bubblewrap/Docker sandbox with network isolation.

**Migration:**
```bash
# If you need network access in sandboxed commands:
export KC_SANDBOX_ALLOW_NETWORK=true

# Or disable sandbox entirely (not recommended):
export KC_SANDBOX_ENABLED=false
```

Or configure per-project in `.kc-cli/settings.json`:
```json
{
  "sandbox": {
    "enabled": true,
    "allowNetwork": true
  }
}
```

### 2. Token Estimation Changed

Token estimation now uses `js-tiktoken` instead of character-based heuristics. This affects:
- Context window management (compaction triggers may fire at different points)
- Budget tracking (`--max-budget`)

**Migration:** No action required. The new estimation is more accurate. If you relied on the old rough estimates, adjust your `--max-budget` values.

### 3. UI Slash Commands

New slash commands are available. Existing `/help`, `/clear`, `/mode`, `/tools`, `/status`, `/exit` still work.

**New commands:**
- `/palette` — Command palette with fuzzy search
- `/model` — Interactive model switcher
- `/sidebar` — Toggle sidebar (Tools/Files/Tasks/Memory)
- `/diff` — View pending diffs
- `/accept` / `/reject` — Accept/reject file changes
- `/permission [mode]` — View/switch permission mode

## New Features

### Sandbox Security

All shell commands now run in isolated sandboxes. See [Sandbox Security](sandbox-security.md) for details.

Key points:
- **Bubblewrap** (Linux default): namespace isolation, read-only system dirs, no network
- **Docker**: container-based isolation with resource limits
- **seccomp profile**: syscall whitelist blocks dangerous operations
- **Per-tool policies**: configure sandbox behavior per tool

### LSP Integration

KC-CLI now connects to language servers for intelligent code assistance:

- **Diagnostics**: Real-time error/warning display in sidebar
- **Completions**: Code completion suggestions
- **Navigation**: Go-to-definition, find references
- **Code Actions**: Quick fixes (missing imports, spelling)
- **Rename**: Safe rename across all references

Supported languages: TypeScript, JavaScript, Go, Python, Rust, Java, C++.

Requires language server binaries installed (e.g., `typescript-language-server`, `gopls`, `pylsp`, `rust-analyzer`).

### UI Enhancements

- **Sidebar**: File tree with LSP diagnostic markers, task list, memory browser
- **Diff Preview**: See file changes before accepting, with color-coded diff
- **Command Palette**: Quick access to all commands with fuzzy search
- **Model Selector**: Switch between providers/models interactively

### Multi-Agent Improvements

- **Permission cascading**: Child agents inherit parent permissions (never exceed)
- **Tool filtering**: Control which tools sub-agents can access
- **Result aggregation**: Automatic summary of multi-agent results

## Configuration Migration

Your existing `~/.kc-cli/settings.json` and `.kc-cli/settings.json` files are compatible. New optional fields:

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "bubblewrap",
    "allowNetwork": false,
    "maxMemoryMb": 512,
    "cpuTimeLimitSec": 60
  },
  "lsp": {
    "enabled": true,
    "languages": ["typescript", "go", "python"]
  }
}
```

## Rollback

If you need to revert to v1:
```bash
git checkout v0.1.0
npm install
```

Your configuration files and memory data are backward-compatible.

## Getting Help

- Check the [README](../README.md) for usage
- See [Architecture](architecture.md) for system design
- File issues on GitHub
