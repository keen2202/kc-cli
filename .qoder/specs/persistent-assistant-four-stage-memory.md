# Persistent Assistant & Four-Stage Memory Integration System

## Overview

This spec implements a complete persistent assistant mode for cc-cli that enables cross-session long-term memory with automatic four-stage memory integration (Orient → Collect → Integrate → Trim). The system will automatically organize scattered session information into structured notes during idle time.

## Architecture Design

### Core Components

1. **Memory Service** - Abstract layer for memory CRUD operations
2. **Session Manager** - Session persistence and recovery
3. **Background Extraction** - Post-turn forked agent memory extraction
4. **Idle-Time Consolidation** - Four-stage memory integration during idle periods
5. **Memory Search & Injection** - Relevance-based memory recall with prompt injection

### Directory Structure

```
~/.cc-cli/
├── settings.json                    (existing config)
├── memory/
│   ├── <project-hash>/
│   │   ├── MEMORY.md                (entrypoint index)
│   │   ├── user_preferences.md      (memory topic files)
│   │   ├── feedback_patterns.md
│   │   ├── project_decisions.md
│   │   ├── reference_links.md
│   │   └── .consolidate-lock        (consolidation state)
│   └── ...                          (other projects)
└── sessions/
    ├── session_<id>.json            (session snapshots)
    └── .archive/                    (archived sessions)
```

## Implementation Phases

### Phase 1: Memory Foundation (Types, Storage, Path Management)

#### 1.1 Memory Types & Interfaces
**File**: `src/memory/types.ts`

```typescript
// Memory types enum
type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

// Memory file frontmatter
interface MemoryHeader {
  name: string;
  description: string;
  type: MemoryType;
  createdAt?: number;
  updatedAt?: number;
}

// Complete memory entry
interface MemoryEntry {
  header: MemoryHeader;
  content: string;
  filePath: string;
  mtime: number;
}

// Session snapshot
interface SessionSnapshot {
  sessionId: string;
  messages: ChatMessage[];
  state: {
    cwd: string;
    model: string;
    provider: string;
    turnCount: number;
    totalTokensUsed: number;
  };
  metadata: {
    createdAt: number;
    lastModified: number;
    toolsUsed: string[];
  };
}

// Memory service interface
interface MemoryService {
  // Memory operations
  addMemory(projectHash: string, memory: MemoryEntry): Promise<string>;
  listMemories(projectHash: string, type?: MemoryType): Promise<MemoryEntry[]>;
  getMemory(projectHash: string, fileName: string): Promise<MemoryEntry | null>;
  removeMemory(projectHash: string, fileName: string): Promise<void>;
  updateMemory(projectHash: string, fileName: string, updates: Partial<MemoryEntry>): Promise<void>;

  // Session operations
  saveSession(session: SessionSnapshot): Promise<void>;
  loadSession(sessionId: string): Promise<SessionSnapshot | null>;
  listSessions(filter?: SessionFilter): Promise<SessionSnapshot[]>;
  deleteSession(sessionId: string): Promise<void>;

  // Utility
  getProjectMemoryPath(projectHash: string): string;
  scanMemories(projectHash: string, limit?: number): Promise<MemoryEntry[]>;
}
```

#### 1.2 Path Management & Security
**File**: `src/memory/paths.ts`

Key functions:
- `getMemoryBasePath()` - Returns `~/.cc-cli/memory/`
- `getProjectMemoryPath(projectHash)` - Returns project-specific memory dir
- `getMemoryFilePath(projectHash, fileName)` - Returns full file path
- `validateMemoryPath(path)` - Security validation (prevent traversal, symlinks, Unicode normalization)
- `getConsolidateLockPath(projectHash)` - Returns lock file path
- `getSessionPath(sessionId)` - Returns session snapshot path

Security considerations:
- Prevent directory traversal (`../`)
- Validate symlinks don't escape memory dir
- Unicode normalization for cross-platform compatibility
- Whitelist allowed file extensions (`.md`, `.json`, `.lock`)

#### 1.3 YAML Frontmatter Parser
**File**: `src/memory/frontmatter.ts`

Parse and generate YAML frontmatter for memory files:
```markdown
---
name: user_preferences
description: User's coding preferences and expertise
type: user
createdAt: 1712300000000
updatedAt: 1712400000000
---

Actual memory content here...
```

Functions:
- `parseFrontmatter(content)` - Extract header and content
- `generateFrontmatter(header)` - Create frontmatter string
- `validateMemoryType(type)` - Validate against MemoryType enum

#### 1.4 Memory Service Implementation (Filesystem-based)
**File**: `src/memory/FileMemoryService.ts`

Core implementation with:
- File-based storage using `fs/promises`
- Atomic writes (write to temp, then rename)
- Frontmatter parsing/generation
- Path validation and security
- Session JSON serialization

### Phase 2: Session Persistence

#### 2.1 Session Snapshot Manager
**File**: `src/services/sessionManager.ts`

Functions:
- `saveSnapshot(queryEngine, state)` - Save current session state
- `loadSnapshot(sessionId)` - Load and restore session
- `listRecentSessions(limit)` - List recent sessions with metadata
- `archiveSession(sessionId)` - Move to archive directory
- `pruneOldSessions(days)` - Delete sessions older than N days
- `getSessionStats(sessionId)` - Get session statistics

#### 2.2 Integration with QueryEngine
**File**: `src/query/QueryEngine.ts` (modified)

Add methods:
- `saveCheckpoint(reason)` - Save session checkpoint
- `autoSaveInterval` - Periodic auto-save (every N turns)
- `loadFromSnapshot(sessionId)` - Restore from snapshot

Hook points:
- After each turn completion
- On `/clear` command (prompt to save)
- On REPL exit (graceful shutdown)

#### 2.3 REPL Commands
**File**: `src/main.ts` (modified)

New commands:
```
/resume [sessionId]  - Resume previous session (or list recent)
/sessions [filter]   - List saved sessions
/archive [sessionId] - Archive a session
/forget [sessionId]  - Delete session permanently
/memory list [type]  - List memories
/memory add <file>   - Add memory manually
/memory show <file>  - Show memory content
/memory remove <file> - Remove memory
/status              - Enhanced to show memory stats
```

### Phase 3: Memory Search & Prompt Injection

#### 3.1 Memory Scanner
**File**: `src/memory/scanner.ts`

Scan and index memory files:
- Recursive directory scan
- Frontmatter extraction
- Sort by modification time (newest first)
- Cap at 200 files (configurable)
- Format as manifest for relevance search

#### 3.2 Relevance Search
**File**: `src/memory/relevanceSearch.ts`

Two-tier approach:
1. **Heuristic search** (Phase 3) - Keyword matching, type filtering
2. **LLM-based search** (Phase 5) - Use model to select most relevant memories

Functions:
- `findRelevantMemories(query, memories, recentTools)` - Return top 5 relevant memories
- `calculateRelevanceScore(query, memory)` - Score memory relevance
- `getMemoryFreshnessText(mtime)` - Generate age warning ("last updated 3 days ago")

#### 3.3 Memory Prompt Builder
**File**: `src/memory/promptBuilder.ts`

Build memory system prompt:
- Load MEMORY.md content
- Include relevant memories based on query
- Add freshness warnings for stale memories
- Provide memory writing guidelines

Functions:
- `buildMemoryPrompt(projectHash, query)` - Build complete memory prompt
- `loadMemoryEntrypoint(projectHash)` - Load MEMORY.md
- `formatMemoryManifest(memories)` - Format memories for injection

#### 3.4 System Prompt Integration
**File**: `src/query/QueryEngine.ts` (modified)

Inject memory prompt into system:
```typescript
const memoryPrompt = await buildMemoryPrompt(projectHash, userMessage);
const systemPrompt = baseSystemPrompt + '\n\n' + memoryPrompt;
```

### Phase 4: Background Memory Extraction

#### 4.1 Post-Turn Hook System
**File**: `src/hooks/postTurnHooks.ts`

Fire-and-forget hook execution after each turn:
```typescript
interface PostTurnHookContext {
  messages: ChatMessage[];
  systemPrompt: string;
  state: AgentState;
  querySource: string;
}

type PostTurnHook = (context: PostTurnHookContext) => Promise<void>;

function registerPostTurnHook(hook: PostTurnHook): void;
async function executePostTurnHooks(context: PostTurnHookContext): Promise<void>;
```

Hooks registered:
1. Memory extraction (fire-and-forget)
2. Session checkpoint save
3. Idle detection trigger

#### 4.2 Memory Extraction Service
**File**: `src/services/memoryExtraction.ts`

Background extraction with cursor-based throttling:
- Track `lastExtractionCursor` - last processed message index
- Only extract new messages since last extraction
- Throttle: extract every N turns (configurable, default 3)
- Skip extraction if main agent already wrote memories
- Extract written file paths and update cursor

Functions:
- `executeMemoryExtraction(context)` - Main extraction function
- `shouldExtract(turnCount)` - Throttle check
- `advanceCursor(messageIndex)` - Update extraction cursor
- `getExtractedMemories()` - Get memories from current extraction

#### 4.3 Extraction Prompt
**File**: `src/services/extractionPrompts.ts`

System prompt for memory extraction agent:
```
You are a memory extraction assistant. Your job is to extract important information
from the conversation and save it as structured memory files.

Follow these guidelines:
1. Identify key insights, decisions, and patterns
2. Categorize by memory type (user, feedback, project, reference)
3. Write concise, actionable memories
4. Use YAML frontmatter
5. Avoid duplicates with existing memories

Memory type guidelines:
- user: User preferences, expertise, working style
- feedback: What works, what doesn't, lessons learned
- project: Goals, decisions, incidents, context
- reference: External system pointers, documentation links
```

#### 4.4 Extraction Mutex Design
**File**: `src/services/memoryExtraction.ts` (part of extraction service)

Prevent conflicts between:
- Main agent writing memories directly
- Background extraction agent

Logic:
- If main agent wrote memories in current turn → skip background extraction
- Track `memoryWriteUuid` - UUID of last memory-writing message
- Advance cursor past memory writes to avoid redundancy
- Use lock files for file-level coordination

### Phase 5: Idle-Time Four-Stage Memory Consolidation

#### 5.1 Idle Detection
**File**: `src/services/idleDetection.ts`

Detect when user is idle:
- Track time since last user input
- Configurable idle threshold (default: 5 minutes)
- Trigger consolidation when idle + time gate passed
- Prevent concurrent consolidations

Functions:
- `startIdleDetection()` - Start monitoring
- `checkIdleState()` - Check if currently idle
- `getLastActivityTime()` - Get timestamp of last activity
- `triggerConsolidation()` - Trigger four-stage consolidation

#### 5.2 Four-Stage Consolidation Process
**File**: `src/services/memoryConsolidation.ts`

##### Stage 1: ORIENT
- Read MEMORY.md to understand current structure
- Skim existing topic files
- Identify gaps and potential duplicates
- Review recent session transcripts

##### Stage 2: COLLECT
- Scan recent session snapshots for new insights
- Look for drifted/outdated memories
- Search for specific context using keyword patterns
- Collect raw material for consolidation

##### Stage 3: INTEGRATE
- Merge related insights into coherent memories
- Update existing memories with new information
- Convert relative dates to absolute dates
- Delete contradicted facts
- Create new memory files as needed
- Update MEMORY.md index

##### Stage 4: TRIM (PRUNE & INDEX)
- Maintain MEMORY.md under 200 lines / 25KB
- Each index entry: one line under ~150 characters
- Remove stale/superseded pointers
- Demote verbose entries (move detail to topic file)
- Resolve contradictions

Functions:
- `executeConsolidation(projectHash)` - Main consolidation function
- `stage_orient(projectHash)` - Orient stage
- `stage_collect(projectHash)` - Collect stage
- `stage_integrate(projectHash)` - Integrate stage
- `stage_trim(projectHash)` - Trim stage
- `updateMemoryIndex(projectHash, entries)` - Update MEMORY.md
- `acquireConsolidationLock(projectHash)` - Prevent concurrent consolidation
- `releaseConsolidationLock(projectHash)` - Release lock

#### 5.3 Consolidation Prompt Builder
**File**: `src/services/consolidationPrompts.ts`

Detailed prompt for consolidation agent:
```
You are a memory consolidation assistant. Your job is to organize scattered
session information into structured, long-term memories.

Current state:
${orientResults}

Recently collected insights:
${collectedInsights}

Your tasks:
1. INTEGRATE: Merge related insights, update existing memories, create new files
2. TRIM: Keep MEMORY.md under limits, remove stale entries, resolve contradictions

Guidelines:
- Write semantic, not chronological
- Use absolute dates, not relative
- Be concise and actionable
- Avoid duplicates
- Delete contradicted facts
- Update MEMORY.md index
```

#### 5.4 Consolidation Scheduling
**File**: `src/services/consolidationScheduler.ts`

Smart scheduling for consolidation:
- Time gate: Minimum hours since last consolidation (default: 24)
- Session gate: Minimum number of new sessions (default: 5)
- Scan throttle: Minimum interval between scans (default: 10 minutes)
- Lock acquisition: Prevent concurrent consolidations

Functions:
- `shouldConsolidate(projectHash)` - Check all gates
- `scheduleConsolidation(projectHash)` - Schedule if conditions met
- `cancelConsolidation(projectHash)` - Cancel scheduled consolidation
- `getConsolidationStatus(projectHash)` - Get current status

### Phase 6: Configuration & Polish

#### 6.1 Memory Configuration
**File**: `src/bootstrap/config.ts` (modified)

Add memory config options:
```typescript
interface MemoryConfig {
  enabled: boolean;                    // Enable memory system
  autoExtract: boolean;                // Auto-extract after turns
  autoConsolidate: boolean;            // Auto-consolidate during idle
  idleThresholdMinutes: number;        // Idle detection threshold
  consolidationMinHours: number;       // Min hours between consolidations
  consolidationMinSessions: number;    // Min sessions before consolidation
  extractionTurnThrottle: number;      // Extract every N turns
  maxMemoriesPerType: number;          // Max memories per type
  maxSessionSnapshots: number;         // Max snapshots to keep
  sessionRetentionDays: number;        // Days before auto-archive
  relevanceSearchLimit: number;        // Max memories to inject (default: 5)
}
```

#### 6.2 REPL Integration
**File**: `src/main.ts` (enhanced)

Enhanced REPL with:
- Memory status display on startup
- Resume prompt if previous session exists
- Idle detection loop during wait for input
- Graceful shutdown with session save
- Progress indicators for background tasks

#### 6.3 Telemetry & Logging
**File**: `src/memory/telemetry.ts`

Track memory system health:
- Extraction success/failure rates
- Consolidation frequency and duration
- Memory file counts by type
- Session snapshot counts
- Relevance search accuracy

## Integration Points

### 1. Bootstrap Phase
```
main()
├─ Initialize state (existing)
├─ Load config (existing)
├─ NEW: Initialize memory service
├─ NEW: Check for session resume
├─ NEW: Start idle detection
├─ Register tools (existing)
└─ Create query engine (existing, pass memory service)
```

### 2. Query Execution
```
QueryEngine.submitMessage()
├─ Build system prompt
│   └─ NEW: Inject memory prompt
├─ Execute LLM call
├─ Process response
├─ Execute tools (if any)
├─ NEW: Execute post-turn hooks
│   ├─ Memory extraction (fire-and-forget)
│   └─ Session checkpoint save
└─ Return result
```

### 3. REPL Loop
```
while (true)
├─ NEW: Check idle state → trigger consolidation
├─ Wait for user input
├─ Process commands
│   ├─ NEW: /resume, /sessions, /memory, /archive, /forget
│   └─ Existing: /clear, /mode, /tools, /status, /exit
├─ Submit message to query engine
└─ Display result
```

### 4. Graceful Shutdown
```
process.on('SIGINT/SIGTERM')
├─ NEW: Save session snapshot
├─ NEW: Wait for pending extractions (60s timeout)
├─ NEW: Release consolidation locks
└─ Exit
```

## File Structure

```
src/
├── memory/                           (NEW - memory system)
│   ├── types.ts                      (Type definitions)
│   ├── paths.ts                      (Path management & security)
│   ├── frontmatter.ts                (YAML frontmatter parser)
│   ├── FileMemoryService.ts          (Filesystem implementation)
│   ├── scanner.ts                    (Memory file scanner)
│   ├── relevanceSearch.ts            (Relevance-based search)
│   ├── promptBuilder.ts              (Memory prompt injection)
│   └── telemetry.ts                  (Memory system telemetry)
├── services/                         (NEW - background services)
│   ├── sessionManager.ts             (Session persistence)
│   ├── memoryExtraction.ts           (Background extraction)
│   ├── extractionPrompts.ts          (Extraction agent prompts)
│   ├── memoryConsolidation.ts        (Four-stage consolidation)
│   ├── consolidationPrompts.ts       (Consolidation prompts)
│   ├── consolidationScheduler.ts     (Smart scheduling)
│   └── idleDetection.ts              (Idle time detection)
├── hooks/                            (NEW - hook system)
│   └── postTurnHooks.ts              (Post-turn hook execution)
├── bootstrap/
│   └── config.ts                     (MODIFIED - add memory config)
├── query/
│   └── QueryEngine.ts                (MODIFIED - memory integration)
└── main.ts                           (MODIFIED - REPL enhancements)
```

## Testing Strategy

### Unit Tests
- Frontmatter parsing
- Path security validation
- Relevance search algorithms
- Memory CRUD operations
- Session save/load
- Consolidation stage logic

### Integration Tests
- End-to-end memory extraction
- Session resume workflow
- Idle-time consolidation trigger
- Memory prompt injection
- Post-turn hook execution

### Manual Tests
- Cross-session memory recall
- Long-term memory organization
- Idle-time consolidation behavior
- Memory freshness warnings
- Large memory file handling

## Migration & Backwards Compatibility

- Memory system is **optional** (feature flag in config)
- Works with existing installations (no breaking changes)
- Graceful degradation if memory service unavailable
- Can enable/disable per-project
- Existing commands unchanged

## Performance Considerations

- **File I/O**: Async operations, non-blocking
- **Memory injection**: Cap at 5 memories, 200 lines max
- **Extraction throttling**: Every 3 turns (configurable)
- **Consolidation gates**: 24 hours min, 5 sessions min
- **Idle detection**: Poll every 30 seconds
- **Session saves**: Debounced, every 5 turns
- **Lock files**: mtime-based, no polling

## Security Considerations

- **Path traversal prevention**: Validate all paths
- **Symlink validation**: Don't follow symlinks outside memory dir
- **Unicode normalization**: Cross-platform compatibility
- **File permissions**: Restrict access to memory files
- **Sensitive data warning**: Document memory contains conversations
- **Git ignore**: Auto-add `.gitignore` to memory directory

## Next Steps

1. **Phase 1**: Memory Foundation (Types, Storage, Paths)
2. **Phase 2**: Session Persistence
3. **Phase 3**: Memory Search & Prompt Injection
4. **Phase 4**: Background Extraction
5. **Phase 5**: Idle-Time Four-Stage Consolidation
6. **Phase 6**: Configuration & Polish

Each phase builds on the previous, allowing incremental implementation and testing.
