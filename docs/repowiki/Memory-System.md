# Memory System

File-based persistent memory with YAML frontmatter, relevance search, and LLM auto-extraction. (Scheduled consolidation is PARKED — removed in audit round3 T10; see docs/specs/memory-consolidation-pending.md.)

## Storage

```
~/.kc-cli/memory/
  <project-hash>/
    user/
      user_preferences.md
      coding_style.md
    feedback/
      testing_approach.md
    project/
      architecture_decisions.md
      sprint_goals.md
    reference/
      api_endpoints.md
    sessions/
      <session-id>.json
    archives/
      <archived-session>.json.gz
```

## Memory Types

| Type | Purpose | Examples |
|------|---------|---------|
| `user` | User preferences, habits, expertise | "Prefers TypeScript over JavaScript", "Senior dev, 10yr Go experience" |
| `feedback` | Guidance on agent behavior | "Don't mock DB in tests", "Prefer single bundled PRs" |
| `project` | Ongoing work context | "Merge freeze after Thursday", "Auth rewrite for compliance" |
| `reference` | External resource pointers | "Bugs tracked in Linear INGEST project", "Grafana dashboard URL" |

## MemoryEntry Structure

```typescript
interface MemoryEntry {
  header: {
    name: string;           // kebab-case slug
    description: string;    // One-line summary
    type: 'user' | 'feedback' | 'project' | 'reference';
    createdAt: string;      // ISO timestamp
    updatedAt: string;
    confidence: number;     // 0-1 relevance score
  };
  content: string;          // Markdown body
  filePath: string;         // Absolute path
  fileName: string;         // Filename only
  mtime: number;            // Last modified timestamp
}
```

## File Format

```markdown
---
name: testing-approach
description: Integration tests must use real DB, not mocks
metadata:
  type: feedback
  confidence: 0.95
---

Integration tests must hit a real database, not mocks.

**Why:** Mock tests passed but prod migration failed in Q3 2025.

**How to apply:** Always use the test database fixture in `test/utils/db.ts`.
See also: [[architecture_decisions]] for the DB migration strategy.
```

## FileMemoryService

`src/memory/FileMemoryService.ts`:

### CRUD Operations
- `create(entry)` -- Atomic write (temp file + rename)
- `read(filePath)` -- Parse YAML frontmatter + markdown body
- `update(filePath, changes)` -- Merge changes, update timestamp
- `delete(filePath)` -- Remove file
- `list(type?)` -- Scan directory for memory files

### Session Snapshots
- `saveSnapshot(sessionId, messages)` -- Persist conversation state
- `loadSnapshot(sessionId)` -- Restore conversation
- `listSnapshots()` -- List all snapshots
- `deleteSnapshot(sessionId)` -- Remove snapshot
- `archiveSnapshot(sessionId)` -- Compress and move to archives
- `pruneSnapshots(retentionDays)` -- Clean old snapshots

### Security
- Path validation prevents directory traversal
- Symlink resolution before access
- Unicode normalization to prevent homoglyph attacks

## Relevance Search

`src/memory/relevanceSearch.ts`:

Keyword-scored retrieval with recency boost:
1. Extract keywords from current conversation context
2. Score each memory by keyword match count
3. Apply recency boost (newer memories score higher)
4. Return top N results (configurable, default 5)

```typescript
function findRelevantMemories(
  context: string,
  memories: MemoryEntry[],
  limit: number
): MemoryEntry[];
```

### Multilingual Retrieval (CJK-aware)

Both the query and each memory are tokenized with the shared CJK-aware
tokenizer (`src/utils/tokenize.ts`) instead of a plain whitespace split, so
Chinese/Japanese/Korean queries retrieve matching memories. Scoring combines:

- exact-substring match (high weight),
- per-token description / filename matches,
- a **token-overlap ratio bonus** rewarding higher query coverage,
- the existing type / recency / feedback / confidence multipliers.

An unrelated query that shares no tokens still scores `0` (relevance is never
inflated). The score cache key is a normalized, order-independent token
signature, so case- and word-order variants of the same query share cache
entries. A `SemanticScorer` seam (`setSemanticScorer`) is available as an
optional extension point; returning `undefined` falls back to the keyword path
(no embedding implementation ships in this phase).

## Memory Integration

`src/memory/integration.ts`:

Pre-query memory loading into system prompt:
1. Extract keywords from user message
2. Run relevance search
3. Format memories as context block
4. Inject into system prompt via `promptBuilder`

```
<relevant_memories>
[user] user_preferences: Prefers concise code, no comments unless necessary
[feedback] testing_approach: Integration tests must use real DB
[project] sprint_goals: Focus on auth module this week
</relevant_memories>
```

## Consolidation

### Auto-Extraction
`src/services/memoryExtraction.ts`:
- Triggered after idle threshold (5 min default)
- LLM-based extraction from conversation turns
- Confidence scoring and deduplication
- Only saves memories above confidence threshold

### Consolidation
`src/services/memoryConsolidation.ts`:
- [PARKED] Scheduled consolidation threshold (24 hours, 5 sessions minimum) — feature removed in audit round3 T10, pending a dedicated spec (docs/specs/memory-consolidation-pending.md)
- Merges related memories
- Prunes low-confidence entries
- Updates descriptions and cross-references

### Quality Assessment
`src/services/memoryQuality.ts`:
- Scores memories on: relevance, specificity, actionability, freshness
- Prunes memories below quality threshold
- Detects and removes duplicates

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "autoExtract": true,
    "autoConsolidate": true,
    "idleThresholdMinutes": 5,
    "consolidationMinHours": 24,
    "consolidationMinSessions": 5,
    "maxMemoriesPerType": 50,
    "maxSessionSnapshots": 100,
    "sessionRetentionDays": 30,
    "relevanceSearchLimit": 5
  }
}
```

## Telemetry

`src/memory/telemetry.ts`:
- Tracks: memories created, loaded, searched, consolidated
- Per-type counts and confidence distributions
- Session snapshot sizes and retention stats
