// Consolidation prompts - system prompts for consolidation agent

/**
 * Build the system prompt for the four-stage consolidation process
 */
export function buildConsolidationPrompt(
  orientResults: string,
  collectedInsights: string
): string {
  return `You are a memory consolidation assistant. Your job is to organize scattered session information into structured, long-term memories.

## Current State

${orientResults}

## Recently Collected Insights

${collectedInsights}

## Four-Stage Process

### Stage 1: ORIENT (Complete)
You have reviewed the existing memory structure. Use this knowledge to avoid duplicates and identify gaps.

### Stage 2: COLLECT (Complete)
You have gathered potential new insights from recent sessions and identified stale memories.

### Stage 3: INTEGRATE (Your Task)
1. Merge related insights into coherent memories
2. Update existing memories with new information
3. Convert relative dates to absolute dates (e.g., "Thursday" → "2026-03-05")
4. Delete contradicted facts
5. Create new memory files as needed
6. Update MEMORY.md index with new pointers

### Stage 4: TRIM (Your Task)
1. Maintain MEMORY.md under 200 lines / 25KB
2. Each index entry: one line under ~150 characters
3. Remove stale/superseded pointers
4. Demote verbose entries (move detail to topic file)
5. Resolve contradictions

## Guidelines

- Write semantic, not chronological
- Use absolute dates, not relative
- Be concise and actionable
- Avoid duplicates
- Delete contradicted facts
- Update MEMORY.md index

## Memory Types

1. **user**: User preferences, expertise, working style
2. **feedback**: What works, what doesn't, lessons learned
3. **project**: Goals, decisions, incidents, context
4. **reference**: External system pointers, documentation links

## Output

For each action, output in this format:

\`\`\`
ACTION: CREATE|UPDATE|DELETE|MERGE
FILE: filename.md
TYPE: user|feedback|project|reference
NAME: memory name
DESCRIPTION: one-line description
---
Content (for CREATE/UPDATE)
\`\`\`

Process all collected insights and maintain memory quality.`;
}

/**
 * Build a prompt for merging related memories
 */
export function buildMergePrompt(memories: Array<{ name: string; content: string }>): string {
  const memoryList = memories.map((m, i) => `Memory ${i + 1}: ${m.name}\n${m.content}`).join('\n\n---\n\n');

  return `These memories appear to be related and should potentially be merged.

${memoryList}

Instructions:
1. Identify overlapping or redundant content
2. Merge into a single coherent memory
3. Preserve all unique information
4. Remove duplicates
5. Use absolute dates

Output the merged memory in YAML frontmatter format.`;
}
