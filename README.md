# CC-CLI: Intelligent CLI Agent System

An AI-powered intelligent CLI assistant for software development, inspired by Claude Code's architecture.

## Features

- 🔧 **Modular Tools**: Bash execution, file operations, web search with extensible architecture
- 🔒 **Permission System**: Three-layer security (allow/deny/ask) with bypass-immune safety checks
- 🤖 **LLM-Powered**: Supports Anthropic Claude, OpenAI GPT, Google Gemini, and Ollama
- 💻 **Terminal UI**: Interactive REPL with beautiful output
- ⚡ **Node.js Compatible**: Works with Node.js 16+ (no Bun required)

## Quick Start

### Prerequisites

- Node.js 16.20.2 or higher
- npm or yarn
- API key for your chosen LLM provider

### Installation

```bash
# Navigate to the project
cd cc-cli

# Install dependencies
npm install

# Run with a prompt
npm run cc -- "List all files in the current directory"

# Or run interactively
npm run cc
```

### Configuration

Set your API key:

```bash
# Anthropic (default)
export CC_API_KEY=sk-ant-xxx
export CC_PROVIDER=anthropic

# Or OpenAI
export CC_API_KEY=sk-xxx
export CC_PROVIDER=openai
export CC_API_BASE_URL=https://api.openai.com/v1

# Or Ollama (local)
export CC_PROVIDER=ollama
export CC_API_BASE_URL=http://localhost:11434
```

## Usage

### Interactive Mode

```bash
npm run cc
```

### Single Prompt Mode

```bash
npm run cc -- "Find all TypeScript files"
npm run cc -- "Create a simple HTTP server"
npm run cc -- "Search for 'TODO' in the codebase"
```

### Show Configuration

```bash
npm run cc -- config
```

### List Available Tools

```bash
npm run cc -- tools
```

### Options

```
Options:
  -c, --cwd <directory>       Working directory
  -m, --mode <mode>           Permission mode (default/bypassPermissions/auto)
  --model <model>             LLM model to use
  --provider <provider>       LLM provider (anthropic/openai/ollama)
  --max-turns <number>        Maximum number of agent turns
  --max-budget <amount>       Maximum budget in USD
  -v, --verbose               Enable verbose output
  --print                     Print response and exit
  --bare                      Minimal mode
  --bypass-permissions        Bypass all permission
  --profile                   Show startup profile
```

### Commands (in REPL)

- `/help` - Show available commands
- `/clear` - Clear conversation
- `/mode <mode>` - Set permission mode
- `/tools` - List available tools
- `/status` - Show current status
- `/exit` - Exit

## Architecture

```
src/
├── main.ts                    # Entry point
├── Tool.ts                    # Tool base type
├── tools.ts                   # Tool registry
├── bootstrap/                 # Initialization
│   ├── state.ts               # Global state
│   ├── config.ts              # Configuration
│   └── profiler.ts            # Performance tracking
├── permissions/               # Security system
│   ├── engine.ts              # Permission engine
│   ├── rules.ts               # Rule matching
│   ├── classifier.ts          # Auto classifier
│   ├── readonlyCommands.ts    # Shared read-only command patterns
│   └── protectedPaths.ts      # Shared protected path definitions
├── query/
│   └── QueryEngine.ts         # LLM query engine
├── tools/                     # Tool implementations
│   ├── TaskStore.ts           # Shared task storage
│   ├── BashTool/              # Shell execution
│   ├── FileReadTool/          # File reading
│   ├── FileWriteTool/         # File writing
│   └── ...                    # More tools
├── types/                     # Type definitions
│   ├── orchestrator.ts        # Shared orchestrator types
│   └── ...
└── utils/                     # Utilities
    ├── format.ts              # Shared formatting helpers
    ├── path.ts                # Path validation
    └── tokenEstimation.ts     # Token estimation
```

### Placeholder Directories

The following directories are reserved for future development and currently contain only `.gitkeep` files:

- `src/api/` — LLM API client implementations (Anthropic, OpenAI, Ollama)
- `src/commands/` — Additional CLI subcommands
- `src/server/` — HTTP/WebSocket server for remote access
- `src/terminal/` — Advanced terminal UI (ink-based)
- `src/services/skills/` — Skill system for specialized workflows
- `src/services/tools/` — Service-level tool implementations

## Available Tools

| Tool | Description | Read-Only |
|------|-------------|-----------|
| Bash | Execute shell commands | ✗ |
| FileRead | Read files | ✓ |
| FileWrite | Write files | ✗ |
| WebSearch | Web search | ✓ |

**Note**: Additional tools (FileEdit, Glob, Grep, WebFetch, Sql, Docker, Deploy, etc.) are defined as stubs and can be implemented as needed.

## Permission Modes

- `default` - Standard interactive mode, asks for unknown operations
- `bypassPermissions` - Skip all permission checks
- `auto` - Use classifier for automatic decisions
- `plan` - Plan mode, read-only operations only
- `acceptEdits` - Accept all edits, ask for others
- `dontAsk` - Convert asks to denies

## Security

The permission system implements defense-in-depth:

1. **Deny-first**: Deny rules are checked first and cannot be bypassed
2. **Tool-specific**: Each tool can implement custom permission checks
3. **Security-critical**: Protected paths and dangerous commands always require approval
4. **Bypass-immune**: Certain safety checks cannot be bypassed even in bypass mode

## Development

```bash
# Type check
npm run typecheck

# Run in development
npm run dev

# Run tests
npx tsx test/run-tests.ts
```

## License

MIT
