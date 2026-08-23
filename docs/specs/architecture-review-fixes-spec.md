# Architecture Review Fixes Specification

**Version**: 1.0.0
**Date**: 2026-06-29
**Source**: Comprehensive Architectural Review of KC-CLI v3.2.0
**Status**: Draft

---

## 1. Issue Classification & Priority Matrix

### Priority Legend

| Level | Symbol | Criteria |
|-------|--------|----------|
| **P0-Critical** | 🔴 | Fix before production deployment — security bypass or latent crash bug |
| **P1-High** | 🟠 | Address in next sprint — security gap, missing enforcement, spec violation |
| **P2-Medium** | 🟡 | Important but not blocking — dead code, duplication, incomplete features |
| **P3-Low** | 🟢 | Nice to fix — code organization, type errors, minor UX issues |

### Summary Count

| Priority | Count | Affected Subsystems |
|----------|-------|---------------------|
| P0-Critical | 2 | Permissions |
| P1-High | 9 | Permissions, State Machine, MCP, Plugins, Orchestrator |
| P2-Medium | 15 | Orchestrator, Tools, Memory, Plugins, Permissions, Services |
| P3-Low | 10 | UI, Entry Point, API, Services, Permissions |

---

## 2. P0-Critical Fix Plans

### C1: Plugin Permission Rules Bypass Bypass-Immune Checks

**Severity**: Critical
**File**: `src/permissions/engine.ts:102-109`
**Root Cause**: Plugin rule evaluation (Step 1.5) returns before reaching Step 3 (`checkSecurityCritical`) and Step 4 (bypass immunity). A plugin rule with `behavior: allow` short-circuits the entire pipeline regardless of protected paths.

**Fix Plan**:
Move plugin permission rule evaluation to after the security-critical check (Step 3), ensuring bypass-immune protections are never skipped. Change the pipeline order from:

```
Step 1: Global Deny → Step 1.5: Plugin Rules → Step 2: Tool-Specific → Step 3: Security-Critical
```

To:

```
Step 1: Global Deny → Step 2: Tool-Specific → Step 3: Security-Critical → Step 3.5: Plugin Rules
```

**Technical Implementation**:

```typescript
// engine.ts — relocate plugin rule block from lines 102-109
// NEW LOCATION: after checkSecurityCritical() call (currently line 148)

// CURRENT (broken):
// Step 1.5: Check plugin permission rules
if (options.pluginManager) {
    const pluginRules = options.pluginManager.getPluginPermissionRules();
    const pluginMatch = matchPluginRules(pluginRules, toolName, options.content);
    if (pluginMatch) return pluginMatch; // ← bypasses security-critical
}

// FIXED: Move to after security-critical check
// Plugin rules should only augment security-critical decisions, not override them
function applyPluginRulesAfterSecurity(
    currentResult: PermissionResult,
    pluginManager: PluginManager | undefined,
    toolName: string,
    content?: string
): PermissionResult {
    if (!pluginManager) return currentResult;
    const pluginRules = pluginManager.getPluginPermissionRules();
    const pluginMatch = matchPluginRules(pluginRules, toolName, content);
    if (!pluginMatch) return currentResult;
    // Plugin can only tighten security, never loosen bypass-immune decisions
    if (currentResult.behavior === 'deny') return currentResult;
    if (pluginMatch.behavior === 'deny') return pluginMatch;
    if (pluginMatch.behavior === 'allow' && currentResult.behavior === 'allow') return currentResult;
    return pluginMatch; // 'ask' behavior or higher restriction
}
```

**Affected Files**:
- `src/permissions/engine.ts` — primary change
- `src/permissions/engine.ts` — update `hasPermissionsToUseTool()` pipeline ordering
- `test/permissions/security.test.ts` — add test case for plugin rule bypass of protected paths

**Verification**:
1. Unit test: plugin rule with `allow` on `/etc/shadow` path must still trigger deny
2. Unit test: plugin rule with `deny` on non-protected path must still deny
3. Integration test: plugin-contributed permission rules cannot override bypass-immune paths

---

### C2: Security-Critical Path Check Only Inspects Two Input Fields

**Severity**: Critical
**File**: `src/permissions/engine.ts:225`
**Root Cause**: `checkSecurityCritical()` reads only `input.path` and `input.command`. Tools with custom field names (e.g., `source`, `target`, `destination`, `files[]`, `output_dir`) can reference protected paths without triggering the check.

**Fix Plan**:
Replace the two-field check with a recursive walk of all string-valued input properties. Additionally, add per-tool path-field declarations in tool schemas for tools that don't use `path` or `command` as field names.

**Technical Implementation**:

```typescript
// engine.ts — replace line 225
// CURRENT:
const pathToCheck = (input.path as string) || (input.command as string) || '';

// FIXED: Recursive extraction of all string-valued paths
function extractAllStringValues(input: Record<string, unknown>): string[] {
    const values: string[] = [];
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') {
            values.push(value);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string') values.push(item);
            }
        } else if (value && typeof value === 'object') {
            values.push(...extractAllStringValues(value as Record<string, unknown>));
        }
    }
    return values;
}

function checkSecurityCritical(
    toolName: string,
    input: Record<string, unknown>
): PermissionResult | null {
    const stringValues = extractAllStringValues(input);

    for (const value of stringValues) {
        if (SECURITY_CRITICAL_REGEX.test(value)) {
            return {
                behavior: 'deny',
                decisionReason: {
                    type: 'security_critical',
                    message: `Protected path access detected: ${value}`,
                },
            };
        }
    }
    return null;
}
```

**Affected Files**:
- `src/permissions/engine.ts` — rewrite `checkSecurityCritical()`
- `src/permissions/protectedPaths.ts` — add per-tool path field annotations (optional enhancement)
- `test/permissions/security.test.ts` — add test cases for non-standard field names

**Verification**:
1. Unit test: `{ source: "/etc/shadow", dest: "/tmp/x" }` must trigger deny
2. Unit test: `{ files: ["/etc/passwd", "safe.txt"] }` must trigger deny
3. Unit test: nested objects `{ config: { key_path: "/etc/ssl/private/key.pem" } }` must trigger deny

---

## 3. P1-High Fix Plans

### H1: SYSTEM_WRITE_DIRECTORIES Defined But Never Enforced

**Severity**: High
**File**: `src/permissions/protectedPaths.ts:64-69`
**Root Cause**: The `SYSTEM_WRITE_DIRECTORIES` constant is exported but never imported or referenced by any permission decision code. Commands that write to system directories are not blocked.

**Fix Plan**:
Integrate `SYSTEM_WRITE_DIRECTORIES` into the security-critical check. For write operations (FileWrite, FileEdit, Bash, Run), check if the target path or command references a system write directory. Add a new check function `isSystemWriteDirectory()` and call it alongside the existing protected path regex check.

**Technical Implementation**:

```typescript
// protectedPaths.ts — add check function
export function isSystemWriteDirectory(targetPath: string): boolean {
    const normalized = path.resolve(targetPath);
    return SYSTEM_WRITE_DIRECTORIES.some(dir => normalized.startsWith(dir));
}

// engine.ts — integrate into checkSecurityCritical
function checkSecurityCritical(input: Record<string, unknown>): PermissionResult | null {
    const stringValues = extractAllStringValues(input);
    for (const value of stringValues) {
        if (SECURITY_CRITICAL_REGEX.test(value)) {
            return { behavior: 'deny', /* ... */ };
        }
        if (isSystemWriteDirectory(value)) {
            return {
                behavior: 'deny',
                decisionReason: {
                    type: 'security_critical',
                    message: `Writing to system directory not allowed: ${value}`,
                },
            };
        }
    }
    return null;
}
```

**Affected Files**:
- `src/permissions/protectedPaths.ts` — add `isSystemWriteDirectory()` export
- `src/permissions/engine.ts` — integrate the check
- `test/permissions/security.test.ts` — add system write directory test cases

---

### H2: Protected Path List Incomplete

**Severity**: High
**File**: `src/permissions/protectedPaths.ts:8-35`
**Root Cause**: Missing 10+ critical security paths used by attackers for persistence, credential theft, and privilege escalation.

**Fix Plan**:
Expand `PROTECTED_PATH_PATTERNS` to include all listed missing paths. Reorganize into logical groups with inline comments explaining each group's security rationale.

**New Entries to Add**:

```typescript
// Credential & secret paths
'/etc/ssl/private/',
'/etc/pki/',
'/run/secrets/',
'/.docker/config.json',

// Database credential paths
'/etc/mysql/',
'/etc/postgresql/',
'/etc/mongod.conf',

// Persistence paths
'/etc/cron.d/',
'/etc/cron.hourly/',
'/etc/cron.daily/',
'/etc/systemd/system/',
'/etc/ld.so.preload',

// Sudo & auth backdoors
'/etc/sudoers.d/',
'/etc/pam.d/',

// Shell/profile injection
'/etc/environment',
'/etc/profile.d/',
'/root/.bashrc',
'/root/.profile',

// Application config tokens
'~/.config/gh/',
'~/.config/hub/',
'~/.config/gcloud/',
'~/.aws/credentials',
'~/.aws/config',
```

**Affected Files**:
- `src/permissions/protectedPaths.ts` — expand the array
- `test/permissions/security.test.ts` — add test cases for each new path category

---

### H3: Dangerous Command Regex Too Narrow

**Severity**: High
**File**: `src/permissions/classifier.ts:10-11`
**Root Cause**: The regexes for destructive commands only match narrow patterns and are bypassable by flag reordering, long flags, full paths, and sudo prefixes.

**Fix Plan**:
Replace the narrow regexes with a comprehensive pattern that handles all variants. Move dangerous command patterns to a dedicated module with test coverage for each bypass technique.

**Technical Implementation**:

```typescript
// classifier.ts — rewriten dangerous command detection
const DESTRUCTIVE_PATTERNS: { pattern: RegExp; description: string }[] = [
    { pattern: /\brm\s+.*-(?:r|-recursive)\b/, description: 'Recursive delete' },
    { pattern: /\brm\s+.*-(?:f|-force)\b/, description: 'Force delete' },
    { pattern: /\b(?:mkfs|mke2fs|mkfs\.\w+)\b/, description: 'Filesystem format' },
    { pattern: /\b(dd|fdisk|parted)\b.*\bof=/, description: 'Disk write' },
    { pattern: /\bchmod\s+.*-[rR]/, description: 'Recursive chmod' },
    { pattern: /\bchown\s+.*-[rR]/, description: 'Recursive chown' },
    { pattern: /\biptables\b/, description: 'Firewall modification' },
    { pattern: /\bsystemctl\b\s+(?:start|stop|disable|mask)/, description: 'Service control' },
    { pattern: /\b(?:update-grub|grub-install)\b/, description: 'Bootloader modification' },
    { pattern: /\b(?:pvcreate|lvcreate|vgcreate)\b/, description: 'LVM creation' },
];

export function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
    const normalized = normalizeCommand(command);
    for (const { pattern, description } of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(normalized)) {
            return { dangerous: true, reason: description };
        }
    }
    return { dangerous: false };
}
```

**Affected Files**:
- `src/permissions/classifier.ts` — rewrite dangerous command detection
- `src/permissions/commandNormalizer.ts` — ensure normalization handles all bypass techniques
- `test/permissions/classifier.test.ts` — add bypass test cases

---

### H4: Sub-Command Splitting Never Applied

**Severity**: High
**File**: `src/permissions/commandNormalizer.ts:93-101`, `src/permissions/engine.ts`, `src/permissions/classifier.ts`
**Root Cause**: `splitSubCommands()` is defined but never called by the engine or classifier. Compound commands (`&&`, `;`, `|`) are checked as monolithic strings.

**Fix Plan**:
Integrate sub-command splitting into both the security-critical check and the dangerous command classifier. Each sub-command in a compound command must independently pass all checks.

**Technical Implementation**:

```typescript
// engine.ts — apply checks to each sub-command
function checkCommandSecurity(command: string): PermissionResult | null {
    const subCommands = splitSubCommands(command);
    for (const subCmd of subCommands) {
        if (SECURITY_CRITICAL_REGEX.test(subCmd)) {
            return {
                behavior: 'deny',
                decisionReason: {
                    type: 'security_critical',
                    message: `Protected path in sub-command: ${subCmd.trim()}`,
                },
            };
        }
        const dangerous = isDangerousCommand(subCmd);
        if (dangerous.dangerous) {
            return {
                behavior: 'deny',
                decisionReason: {
                    type: 'dangerous_command',
                    message: dangerous.reason,
                },
            };
        }
    }
    return null;
}
```

Also fix the `detectBypassAttempts` function to not exclude `||` chaining from detection:

```typescript
// commandNormalizer.ts:108-144
// CURRENT: if (/[;&|]/.test(command) && !/\|\|/.test(command))
// FIXED: if (/[;&|]/.test(command))  — remove || exclusion
```

**Affected Files**:
- `src/permissions/commandNormalizer.ts` — fix `detectBypassAttempts`
- `src/permissions/engine.ts` — integrate sub-command splitting
- `src/permissions/classifier.ts` — integrate sub-command splitting
- `test/permissions/security.test.ts` — add compound command tests

---

### H5: State Machine evolving→completed Transition Bug

**Severity**: High
**File**: `src/query/QueryEngine.ts:543`, `src/state/protocol.ts:107`
**Root Cause**: `QueryEngine.ts:543` calls `transitionTo('completed')` from `evolving` state, but `VALID_TRANSITIONS` only allows `evolving → idle` and `evolving → error`. This throws `InvalidTransitionError`, caught by the outer try-catch at line 572, which silently sets the machine to `error` state.

**Fix Plan**:
Add `'completed'` to the valid transitions from `evolving` state.

**Technical Implementation**:

```typescript
// state/protocol.ts:107 — change:
// CURRENT: evolving: ['idle', 'error'],
// FIXED:
evolving: ['idle', 'completed', 'error'],
```

**Alternative (if completed from evolving should go through idle)**:

```typescript
// QueryEngine.ts:543 — change to force transition
// CURRENT: this.stateMachine.transitionTo('completed');
// FIXED (if keeping tight validation):
this.stateMachine.forceTransitionTo('completed');
// Or route through idle first:
this.stateMachine.transitionTo('idle');
this.stateMachine.transitionTo('completed');
```

**Recommended**: Add `'completed'` to valid transitions — simplest, least surprising.

**Affected Files**:
- `src/state/protocol.ts` — add transition
- `test/query/QueryEngine.test.ts` — add end-of-session evolution test

---

### H6: MCP Stdio Fallback Uses Wrong Framing

**Severity**: High
**File**: `src/mcp/transports/stdio.ts:115`
**Root Cause**: The fallback transport uses newline-delimited JSON (`\n` delimiter), but the MCP specification requires `Content-Length` header framing. Spec-compliant MCP servers will not work with the fallback transport.

**Fix Plan**:
Rewrite the fallback stdio transport to use `Content-Length: N\r\n\r\n` framing, matching the LSP client's correct implementation.

**Technical Implementation**:

```typescript
// mcp/transports/stdio.ts — replace newline-split parsing
// Use the same Content-Length framing pattern as lsp/client.ts:223-245

// Parser state
let contentLength = -1;
let buffer = '';

function parseMessages(data: string, onMessage: (json: unknown) => void): void {
    buffer += data;
    while (true) {
        if (contentLength < 0) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const header = buffer.substring(0, headerEnd);
            const match = header.match(/Content-Length: (\d+)/i);
            if (!match) { buffer = ''; return; }
            contentLength = parseInt(match[1], 10);
            buffer = buffer.substring(headerEnd + 4);
        }
        if (buffer.length < contentLength) return;
        const body = buffer.substring(0, contentLength);
        buffer = buffer.substring(contentLength);
        contentLength = -1;
        onMessage(JSON.parse(body));
    }
}
```

**Affected Files**:
- `src/mcp/transports/stdio.ts` — rewrite framing logic
- `test/mcp/stdio-transport.test.ts` — add Content-Length framing tests

---

### H7: Plugin Code Runs With Full Process Access

**Severity**: High
**File**: `src/plugins/plugin-loader.ts:134`
**Root Cause**: Plugin modules are loaded via bare `import()` with no VM isolation, no Worker thread, and no sandboxing. Malicious or compromised plugins have full filesystem, network, and process access.

**Fix Plan (Phased)**:

**Phase 1 (Immediate)**: Add integrity verification — require plugin `package.json` to include `integrity` field with SHA-256 hash of plugin files, verified before loading.

**Phase 2 (Short-term)**: Load plugins in Node.js `vm` module context with a restricted sandbox exposing only the KC-CLI plugin API surface.

**Phase 3 (Long-term)**: Implement `subprocess` orchestrator backend and route plugin tool execution through it for process-level isolation.

**Phase 1 Implementation**:

```typescript
// plugin-loader.ts — add integrity check
import { createHash } from 'crypto';

async function verifyPluginIntegrity(pluginDir: string): Promise<boolean> {
    const pkg = JSON.parse(await fs.readFile(path.join(pluginDir, 'package.json'), 'utf-8'));
    if (!pkg.kcPlugin?.integrity) {
        // Allow but warn for dev-mode plugins
        if (process.env.KC_DEV_MODE === 'true') {
            logger.plugins.warn(`Plugin ${pkg.name} has no integrity hash — skipping verification in dev mode`);
            return true;
        }
        return false;
    }
    const actual = await computePluginHash(pluginDir);
    return timingSafeEqual(Buffer.from(actual), Buffer.from(pkg.kcPlugin.integrity));
}
```

**Affected Files**:
- `src/plugins/plugin-loader.ts` — add integrity verification
- `src/plugins/protocol.ts` — add `kcPlugin.integrity` field to plugin manifest type
- `docs/guides/plugin-development.md` — document integrity requirement

---

### H8: Permission Classifier Disconnected From Production Engine

**Severity**: High
**File**: `src/permissions/engine.ts:199-203`, `src/permissions/classifier.ts:58-230`
**Root Cause**: The `PermissionClassifier` class has fully implemented logic (quick-path checks, rate limiting, timeout, low/medium/dangerous pattern matching, denial tracking) but is never called from the engine. The `auto` permission mode is a stub that returns `{ behavior: 'ask' }` for everything.

**Fix Plan**:
Wire the classifier into the `auto` permission mode branch in `hasPermissionsToUseTool()`. The classifier should pre-classify operations and inform the permission decision.

**Technical Implementation**:

```typescript
// engine.ts — replace the stub at line 199-203
// CURRENT:
case 'auto':
    return { behavior: 'ask', /* ... */ };

// FIXED:
case 'auto': {
    const classification = classifier.classify({
        toolName,
        input: options.input,
        content: options.content,
    });

    switch (classification.risk) {
        case 'none':
            return { behavior: 'allow', decisionReason: { type: 'auto_readonly' } };
        case 'low':
            return { behavior: 'allow', decisionReason: { type: 'auto_low_risk' } };
        case 'medium':
            return { behavior: 'ask', message: classification.reason };
        case 'dangerous':
            return { behavior: 'deny', decisionReason: { type: 'auto_dangerous' } };
    }
}
```

**Affected Files**:
- `src/permissions/engine.ts` — wire classifier into auto mode
- `src/permissions/classifier.ts` — ensure exports match engine expectations
- `test/permissions/security.test.ts` — add auto mode classification tests

---

### H9: Bash Tool in Researcher Profile Lacks Read-Only Guard

**Severity**: High
**File**: `src/orchestrator/agent-definitions.ts:17`
**Root Cause**: The `researcher` agent profile includes `Bash` in `allowedTools` with only a comment `// Read-only commands only`. There is no enforcement — the agent can execute any bash command.

**Fix Plan**:
Implement a tool capability restriction mechanism. When an agent profile specifies tool restrictions (like "read-only bash"), the tool executor must enforce them.

**Technical Implementation**:

```typescript
// orchestrator/agent-definitions.ts — add capability restrictions
interface AgentToolRestriction {
    toolName: string;
    restrictions: Record<string, unknown>;
}

// Researcher profile:
{
    type: 'researcher',
    allowedTools: ['FileRead', 'Grep', 'Glob', 'Git', 'WebSearch', 'WebFetch', 'Bash', 'Monitor', 'Config'],
    toolRestrictions: [
        {
            toolName: 'Bash',
            restrictions: { readOnly: true },
        },
    ],
    // ...
}

// ToolExecutor.ts — apply restrictions before execution
async function applyToolRestrictions(
    toolName: string,
    input: Record<string, unknown>,
    restrictions?: AgentToolRestriction[]
): Promise<PermissionResult> {
    const toolRestriction = restrictions?.find(r => r.toolName === toolName);
    if (!toolRestriction) return { behavior: 'allow' };
    if (toolRestriction.restrictions.readOnly) {
        // For Bash: check command against read-only patterns
        const command = input.command as string;
        if (command && !isReadOnlyBashCommand(command)) {
            return {
                behavior: 'deny',
                decisionReason: {
                    type: 'agent_restriction',
                    message: `Agent restricted to read-only commands`,
                },
            };
        }
    }
    return { behavior: 'allow' };
}
```

**Affected Files**:
- `src/orchestrator/agent-definitions.ts` — add `toolRestrictions` field
- `src/orchestrator/protocol.ts` — add `AgentToolRestriction` type
- `src/executors/toolExecutor.ts` — integrate restriction enforcement
- `src/permissions/readonlyCommands.ts` — reuse `isReadOnlyBashCommand`

---

## 4. P2-Medium Fix Plans

### M1: sendMessage() No-Op in Orchestrator

**File**: `src/orchestrator/backends/in-process.ts:318-319`
**Fix**: Implement basic message forwarding via EventBus. Messages from one agent appear as events for the target agent.

### M2: Only in_process Backend Implemented

**File**: `src/orchestrator/backends/types.ts:15`
**Fix**: Implement `SubprocessBackend` using `child_process.fork()` for true isolation. Leverages existing sandbox infrastructure.

### M3: ToolName Union Not Compile-Time Checked

**File**: `src/tools/protocol.ts:104-125`, `src/tools/tools.ts:46-74`
**Fix**: Derive `ToolName` union from `TOOL_MANIFEST` keys using `keyof typeof TOOL_MANIFEST`. Single source of truth.

```typescript
// tools.ts
export const TOOL_MANIFEST = { /* ... */ } as const;
// protocol.ts
export type ToolName = keyof typeof TOOL_MANIFEST;
```

### M4: Glob/Grep Traversal Duplication

**File**: `src/tools/GlobTool/index.ts:49-78`, `src/tools/GrepTool/index.ts:46-99`
**Fix**: Extract shared `walkDirectory()` utility to `src/utils/fs-walk.ts` with configurable skip patterns and glob matching.

### M5: ConfigTool Placeholder Messages

**File**: `src/tools/ConfigTool/index.ts:47,69,83,98`
**Fix**: Implement actual config file read/write for user and project scopes using the existing config loading infrastructure.

### M6: Memory confidence Field Dead Data

**File**: `src/memory/protocol.ts:20`, `src/services/memoryExtraction.ts:290`
**Fix**: Either use `confidence` in relevance scoring (boost high-confidence memories) or remove the field. Using it is preferred — multiply relevance score by `confidence === 'high' ? 1.2 : 0.8`.

### M7: Memory Score Cache Stale on Feedback Change

**File**: `src/memory/relevanceSearch.ts:127-130,231-233`
**Fix**: Call `invalidateScoreCache()` from `markMemoriesReferenced()` and `addMemory()` in production code paths.

### M8: Archived Sessions Never Pruned

**File**: `src/memory/FileMemoryService.ts:335-349`
**Fix**: Extend `pruneOldSessions()` to scan both active and archive directories. Add `sessionArchiveRetentionDays` config (default 90 days for archive vs 30 for active).

### M9: Duplicated Frontmatter Parsing

**File**: `src/memory/promptBuilder.ts:73-85`, `src/memory/frontmatter.ts:5`
**Fix**: Replace inline regex in promptBuilder.ts with calls to `parseFrontmatter()`.

### M10: Unused Plugin Contribution Points

**File**: `src/plugins/protocol.ts:41-42` (prompts, mcpServers)
**Fix**: Either implement consumers or remove from interface. Recommended: implement MCP server registration (higher value). Remove prompts until a consumer exists.

### M11: autoReadOnly Option Dead Code

**File**: `src/permissions/interaction.ts:11,30,33`
**Fix**: Integrate with classifier's auto mode. When `autoReadOnly` is true, read-only operations get auto-approved without prompting.

### M12: Duplicated Budget Tracking

**File**: `src/ui/middleware/budget.ts`, `src/services/budget.ts`
**Fix**: UI middleware delegates to `BudgetEnforcer` service via dependency injection. Remove standalone state from the middleware.

### M13: prepare/finalize Hooks Unused

**File**: `src/tools/protocol.ts:73-87`, `src/executors/toolExecutor.ts:213-296`
**Fix**: Remove the infrastructure if no tool needs it, or add a single use case (e.g., FileEdit `prepare` hook for dry-run validation). The cost of keeping unused complexity is higher than removing it.

### M14: registry.ts / TaskStore.ts Duplicate

**File**: `src/tools/registry.ts`, `src/tools/TaskStore.ts`
**Fix**: Delete `registry.ts` (keep `TaskStore.ts`). Update any imports to use `TaskStore.ts`. The `ToolRegistry` interface in `protocol.ts` should remain.

### M15: Path Traversal Missing From GlobTool/GrepTool

**File**: `src/tools/GlobTool/index.ts:29`, `src/tools/GrepTool/index.ts:29`
**Fix**: Add `assertPathWithinWorkspace()` call at entry point of both tools, matching the pattern used in FileRead/Write/Edit.

---

## 5. P3-Low Fix Plans

### L1: App.ts Violates SRP (1,367 lines)

**File**: `src/ui/components/App.ts`
**Fix**: Extract to separate classes: `InputManager` (readline/raw-mode), `DiffManager` (worker + accept/reject), `RenderEngine` (ANSI painting). App becomes a coordinator.

### L2: Broken Discriminated Union in handleEvent

**File**: `src/ui/components/App.ts:561`
**Fix**: Normalize event types at the source (QueryEngine) rather than in the consumer. Remove the `agent:` prefix stripping hack.

### L3: Full-Screen Repaint Every Render

**File**: `src/ui/components/App.ts:362-445`
**Fix**: Implement dirty-region tracking. Only re-render panels/components that received new events since the last frame.

### L4: main.ts Monolith (811 lines)

**File**: `src/main.ts`
**Fix**: Extract to `src/bootstrap/app.ts` (orchestration), `src/bootstrap/cli-config.ts` (commander setup), `src/bootstrap/init-sequence.ts` (startup order).

### L5: getRecommendedTemperature Type Bug

**File**: `src/api/capabilities.ts:332`
**Fix**: Change parameter type from `model?: number` to `model?: string`.

### L6: OllamaClient supportsTools Contradiction

**File**: `src/api/OllamaClient.ts:120`, `src/api/capabilities.ts:177`
**Fix**: Align `getModelInfo()` with capabilities.ts. Ollama's tool support is model-dependent — query capabilities.ts instead of hardcoding.

### L7: ServiceContainer Not Active Resolution Mechanism

**File**: `src/services/ServiceContainer.ts`
**Fix**: Migrate global singletons (CacheManager, State, Orchestrator) into the container. Register at startup, resolve at call sites.

### L8: creative Task Type Maps to reasoning Template

**File**: `src/api/prompts/prompt-builder.ts:113`
**Fix**: Add a dedicated `creative` prompt template segment or remove the creative task type from the enum.

### L9: ReDoS Potential in Rule Parser

**File**: `src/permissions/ruleParser.ts:227-236`
**Fix**: Add regex complexity validation — reject patterns with nested quantifiers (`(a+)+`, `(a*)*`, `(a+)*`) or set a maximum regex length.

### L10: mergeRuleSets Dedup Loses Behavior Info

**File**: `src/permissions/rules.ts:95-111`
**Fix**: When deduplicating, preserve the most restrictive behavior (prefer `deny` over `ask` over `allow`).

---

## 6. Implementation Tracking

| ID | Issue | Phase | Owner | Status | PR |
|----|-------|-------|-------|--------|-----|
| C1 | Plugin rules bypass bypass-immune | Phase 1 | TBD | pending | - |
| C2 | Limited path field inspection | Phase 1 | TBD | pending | - |
| H1 | SYSTEM_WRITE_DIRECTORIES enforcement | Phase 1 | TBD | pending | - |
| H2 | Protected path expansion | Phase 1 | TBD | pending | - |
| H3 | Dangerous command regex | Phase 1 | TBD | pending | - |
| H4 | Sub-command splitting integration | Phase 1 | TBD | pending | - |
| H5 | State machine transition bug | Phase 2 | TBD | pending | - |
| H6 | MCP stdio framing fix | Phase 2 | TBD | pending | - |
| H7 | Plugin integrity verification | Phase 2 | TBD | pending | - |
| H8 | Classifier wiring | Phase 2 | TBD | pending | - |
| H9 | Researcher bash guard | Phase 2 | TBD | pending | - |
| M1-M5 | Orchestrator/Tools fixes | Phase 3 | TBD | pending | - |
| M6-M9 | Memory subsystem fixes | Phase 3 | TBD | pending | - |
| M10-M11 | Plugin/Permissions cleanup | Phase 3 | TBD | pending | - |
| M12-M15 | Services/Tools cleanup | Phase 3 | TBD | pending | - |
| L1-L10 | Low-priority fixes | Phase 4 | TBD | pending | - |

---

## 7. Verification & Test Plan

### 7.1 Security Regression Test Suite

A new test file `test/permissions/security-regression.test.ts` must cover:

1. **Protected path bypass attempts** via every known technique:
   - Non-standard field names (source, target, destination, files[], output_dir)
   - Nested objects ({ config: { path: "/etc/shadow" } })
   - Unicode homoglyphs (еtc vs etc, ╱etc vs /etc)
   - Command chaining (&&, ;, |)
   - Subshell escaping ($(), ``)
   - Environment variable expansion
   - Plugin rule allow on protected path → must still deny

2. **Dangerous command variants**:
   - `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`
   - `/bin/rm -rf`, `sudo rm -rf`, `sudo /bin/rm -rf`
   - `mkfs`, `mkfs.ext4`, `mke2fs`, `dd of=`, `fdisk`
   - `chmod -R 777`, `chown -R user:group`
   - `iptables -F`, `systemctl stop firewalld`

3. **System write directory detection**:
   - Write to `/etc/cron.d/evil`
   - Write to `/etc/systemd/system/backdoor.service`
   - Write to `/etc/ld.so.preload`

### 7.2 State Machine Regression Tests

- End-of-session with AGP evolution enabled must reach `completed` state
- All valid transitions exercised in integration tests

### 7.3 MCP Compliance Tests

- Stdio transport correctly parses Content-Length framed messages
- Large messages (>64KB) correctly framed and parsed
- Multiple messages in single buffer correctly split

### 7.4 Plugin Integrity Tests

- Plugin without integrity hash rejected in non-dev mode
- Plugin with valid integrity hash loads successfully
- Plugin with tampered files (hash mismatch) rejected
- Dev mode (KC_DEV_MODE=true) allows plugins without integrity hash

---

## 8. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Protected path bypass exploited | Critical file access | Low (CLI tool, user-consent mode) | Fix C1, C2, H2 in Phase 1 |
| Plugin supply chain attack | Full system compromise | Low (limited plugin ecosystem) | Fix H7 Phase 1 integrity check |
| MCP server incompatibility | Non-functional MCP tools | Medium (spec-compliant servers increasing) | Fix H6 in Phase 2 |
| State machine crash | Session loss | Low (outer try-catch catches it) | Fix H5 in Phase 2 |
| Dangerous command bypass | Unintended system modification | Medium (user may not know flags) | Fix H3, H4 in Phase 1 |
