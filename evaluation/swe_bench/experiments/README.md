# KC-CLI v3.0.0 — SWE-bench Verified Submission

## System

**KC-CLI** is an open-source intelligent CLI agent system for software development.

- **Repository**: https://github.com/kc-cli/kc-cli
- **Version**: 3.0.0
- **License**: MIT

## Architecture

KC-CLI uses a state machine-driven agent loop:

```
idle → compacting → streaming → deciding → executing → (loop) → completed
```

Key components:
- **QueryEngine**: State machine managing the agent lifecycle
- **ToolExecutor**: 21 built-in tools with sandbox isolation
- **PermissionEngine**: 6-step deny-first security system
- **SandboxManager**: 4-backend isolation (Docker/Bubblewrap/Seccomp/WSB)
- **LSP Integration**: 7-language code intelligence

## Model

- **Provider**: Anthropic
- **Model**: Claude Sonnet 4 (`claude-sonnet-4-20250514`)
- **Max turns**: 30 per instance
- **Timeout**: 300s per instance

## Approach

1. **Issue Analysis**: Parse the problem statement to understand the bug
2. **Code Exploration**: Use FileRead/Grep/Glob tools to explore the codebase
3. **Root Cause Identification**: Analyze code to find the bug
4. **Minimal Fix**: Apply the smallest possible code change
5. **Verification**: Run relevant tests to confirm the fix
6. **Patch Generation**: Generate `git diff` as the final output

## Scaffolding

KC-CLI provides several scaffolding advantages over bare LLM calls:

- **Sandbox isolation**: Commands run in Docker containers, preventing side effects
- **Permission system**: Dangerous commands are blocked or require approval
- **Context management**: Auto-compaction prevents context window overflow
- **Token optimization**: tiktoken-based precise estimation with caching
- **Error recovery**: Automatic retry on transient failures

## Results

Run ID: `kc-cli-v3-20260514`

(Predictions and results will be added by the SWE-bench team)
