# Permission System

6-step deny-first security engine with plugin extensibility and bypass-immune protections.

## Decision Flow

```
Input: (toolName, toolInput, permissionMode)

Step 1: Global deny rules (alwaysDenyRules)
  └─ MATCH → DENY (cannot be bypassed)

Step 1.5: Plugin permission rules
  └─ MATCH → DENY/ALLOW/ASK (priority-ordered)

Step 2: Tool-specific check (tool.checkPermissions)
  └─ Returns PermissionResult directly

Step 3: Security-critical checks (bypass-immune)
  └─ Protected path access → always ASK

Step 4: Bypass mode check
  └─ bypassPermissions mode → ALLOW (except security-critical)

Step 5: Global allow rules (alwaysAllowRules)
  └─ MATCH → ALLOW

Step 5.5: Always-ask rules (alwaysAskRules)
  └─ MATCH → ASK (overrides mode defaults)

Step 6: Mode-based default
  └─ default: read-only → ALLOW, write → ASK
  └─ plan: read-only → ALLOW, write → DENY
  └─ acceptEdits: edits → ALLOW, others → ASK
  └─ dontAsk: ASK → DENY
  └─ auto: LLM classifier
```

## Permission Modes

| Mode | Read-Only | Writes | Destructive | Security-Critical |
|------|-----------|--------|-------------|-------------------|
| `default` | Allow | Ask | Ask | Ask |
| `bypassPermissions` | Allow | Allow | Allow | Ask |
| `plan` | Allow | Deny | Deny | Ask |
| `acceptEdits` | Allow | Allow | Ask | Ask |
| `dontAsk` | Allow | Deny | Deny | Ask |
| `auto` | Allow | Classifier | Classifier | Ask |

## Rule System

### Rule Sources (6 priority levels)

1. `policySettings` -- System-level policies
2. `flagSettings` -- CLI flag overrides
3. `projectSettings` -- `.kc-cli/settings.json`
4. `userSettings` -- `~/.kc-cli/settings.json`
5. `localSettings` -- Local overrides
6. `cliArg` / `session` -- Runtime overrides

### Rule Format

```json
{
  "tool": "Bash",
  "pattern": "rm *",
  "behavior": "deny",
  "reason": "Block rm commands"
}
```

Fields:
- `tool` -- Tool name (supports `*` wildcard)
- `pattern` -- Input pattern (glob-style matching)
- `behavior` -- `allow` | `deny` | `ask`
- `reason` -- Human-readable explanation

### Read-Only Command Detection

`src/permissions/readonlyCommands.ts` defines patterns for auto-allowing safe commands:
- **Bash**: `ls`, `cat`, `grep`, `find`, `wc`, `head`, `tail`, `echo`, `pwd`, `env`, `which`, `whoami`, `date`, `uname`
- **Git**: `git status`, `git log`, `git diff`, `git show`, `git branch` (read-only)
- **File tools**: FileRead, Glob, Grep are always read-only

## Protected Paths

`src/permissions/protectedPaths.ts` -- Bypass-immune paths that always require explicit approval:

```
/etc/passwd, /etc/shadow, /etc/sudoers
~/.ssh/, ~/.gnupg/, ~/.aws/, ~/.kube/
*.key, *.pem, *.p12, *.pfx
.env, .env.*, credentials.json, secrets.json
```

Even in `bypassPermissions` mode, accessing these paths triggers an ASK.

## Plugin Permission Rules

Plugins can contribute rules via `PluginPermissionRule`:

```typescript
interface PluginPermissionRule {
  toolPattern: string;      // Glob pattern for tool name
  contentPattern?: string;  // Regex for tool input
  behavior: 'allow' | 'deny' | 'ask';
  priority: number;         // Lower = higher priority
}
```

These are evaluated at Step 1.5, after global deny rules but before tool-specific checks.

## Permission Cascading (Multi-Agent)

Sub-agents inherit permissions from their parent with constraints:
- Child permission mode cannot exceed parent's permissiveness
- If parent is `plan`, child cannot be `bypassPermissions`
- Protected paths remain bypass-immune regardless of inheritance

## Auto Classifier

`src/permissions/classifier.ts` -- Rule-based classifier for `auto` mode:
- Quick path: exact rule matches
- Heuristics: command pattern analysis, file path inspection
- Falls back to ASK for ambiguous cases

## Interactive Mode

`src/permissions/interaction.ts` -- Handles ASK decisions:
- Terminal prompt with tool name, input preview, and options
- `always allow` / `always deny` for session-level overrides
- Timeout with default deny
