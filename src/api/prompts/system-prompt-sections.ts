// Shared system-prompt sections — round4 §6-M3 (T28)
//
// The Guidelines and Available-capabilities blocks were byte-identical copies
// in two places (Bootstrap's buildSystemPrompt and the AGP prompt adapter).
// Editing one left the other stale. Both templates now interpolate these
// constants so the sections can never drift again.
//
// Note: the capabilities list remains a static string by design — the AGP
// adapter emits prompts for resources outside any live tool registry, so a
// registry-derived list would be wrong there.

export const GUIDELINES_SECTION = `Guidelines:
1. Always think step-by-step before taking action
2. Use tools to gather information before making changes
3. Be careful with destructive operations
4. Explain what you're doing and why
5. Ask for clarification when needed
6. Follow best practices for code quality and security`;

export const CAPABILITIES_SECTION = `Available capabilities:
- Read, write, and edit files
- Execute bash commands
- Search code and files
- Git operations
- Web search and fetch
- Database queries
- Docker operations
- Application deployment
- System monitoring
- Compile, test, and run programs`;
