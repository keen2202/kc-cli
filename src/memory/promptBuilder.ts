// Memory prompt builder - constructs memory system prompt for injection

import * as path from 'path';
import * as fs from 'fs/promises';
import type { MemoryEntry } from './types';
import { getProjectMemoryPath } from './paths';
import { scanMemoryFiles, loadMemoryEntrypoint, formatMemoryManifest } from './scanner';
import { findRelevantMemories, getMemoryFreshnessText } from './relevanceSearch';
import { parseFrontmatter } from './frontmatter';

/**
 * Build the complete memory prompt for injection into the system prompt
 */
export async function buildMemoryPrompt(
  projectHash: string,
  query: string,
  recentTools?: string[],
  maxRelevant: number = 5
): Promise<string> {
  const sections: string[] = [];

  // 1. Load MEMORY.md entrypoint
  const entrypoint = await loadMemoryEntrypoint(projectHash);
  if (entrypoint) {
    sections.push(buildEntrypointSection(entrypoint));
  }

  // 2. Find and inject relevant memories
  const relevantMemories = await loadRelevantMemories(projectHash, query, recentTools, maxRelevant);
  if (relevantMemories.length > 0) {
    sections.push(buildRelevantMemoriesSection(relevantMemories));
  }

  // 3. Add memory writing guidelines
  sections.push(buildMemoryGuidelines());

  if (sections.length === 0) {
    return ''; // No memories available
  }

  return `## Memory System\n\n${sections.join('\n\n')}`;
}

/**
 * Load relevant memory files with full content
 */
async function loadRelevantMemories(
  projectHash: string,
  query: string,
  recentTools?: string[],
  maxRelevant: number = 5
): Promise<MemoryEntry[]> {
  // Get manifest entries
  const manifest = await scanMemoryFiles(projectHash);
  if (manifest.length === 0) return [];

  // Find relevant file names
  const relevantFileNames = findRelevantMemories(query, manifest, recentTools, maxRelevant);
  if (relevantFileNames.length === 0) return [];

  // Load full content for relevant files in parallel
  const projectPath = getProjectMemoryPath(projectHash);
  const entries: MemoryEntry[] = [];

  const loadResults = await Promise.allSettled(
    relevantFileNames.map(async (fileName) => {
      const filePath = path.join(projectPath, fileName);
      const [content, stat] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);

      // Parse frontmatter using shared parser
      const { header, body } = parseFrontmatter(content);
      if (!header.name || !header.type) return null;

      return {
        header: {
          name: header.name,
          description: header.description || '',
          type: header.type,
        },
        content: body,
        filePath,
        fileName,
        mtime: stat.mtimeMs,
      };
    })
  );

  for (const result of loadResults) {
    if (result.status === 'fulfilled' && result.value) {
      entries.push(result.value);
    }
  }

  return entries;
}

// Reusable encoder/decoder instances (avoid allocation per call)
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Build the entrypoint section from MEMORY.md
 */
function buildEntrypointSection(entrypoint: string): string {
  // Truncate to first 200 lines / 25KB
  const lines = entrypoint.split('\n');
  let truncated = lines.slice(0, 200).join('\n');

  if (textEncoder.encode(truncated).length > 25 * 1024) {
    const bytes = textEncoder.encode(truncated).slice(0, 25 * 1024);
    truncated = textDecoder.decode(bytes);
    truncated += '\n\n*(Index truncated - some memories not shown)*';
  }

  return `<memory_index>\n${truncated}\n</memory_index>`;
}

/**
 * Build the relevant memories section with freshness warnings
 */
function buildRelevantMemoriesSection(memories: MemoryEntry[]): string {
  const sections: string[] = [];

  for (const memory of memories) {
    const header = `### Memory: ${memory.header.name}`;
    const type = `Type: ${memory.header.type}`;
    const freshness = getMemoryFreshnessText(memory.mtime);
    const freshnessText = freshness ? `\n**Note:** ${freshness}` : '';

    sections.push(`${header}\n${type}${freshnessText}\n\n${memory.content}`);
  }

  return `<relevant_memories>\n${sections.join('\n\n---\n\n')}\n</relevant_memories>`;
}

/**
 * Build memory writing guidelines for the system prompt
 */
function buildMemoryGuidelines(): string {
  return `<memory_guidelines>
You have a long-term memory system. You can read and write memory files to persist important information across sessions.

## Memory Types

1. **User** (always private)
   - User's role, expertise, preferences, knowledge
   - How to tailor collaboration approach
   - When to use: User shares preferences or expertise

2. **Feedback** (private or team)
   - Guidance on approach: what to avoid, what works
   - Structured as: rule → Why → How to apply
   - When to use: User corrects you, provides feedback, or you learn a lesson

3. **Project** (private or team, bias toward team)
   - Work context: goals, deadlines, incidents, decisions
   - Non-derivable from code/git history
   - When to use: Important project decisions, goals, or context discovered

4. **Reference** (usually team)
   - Pointers to external systems (Linear, Grafana, Slack, docs)
   - Where to find current information
   - When to use: User shares links, system names, or documentation locations

## What NOT to save
- Code patterns derivable from the codebase
- Architecture visible in file structure
- Git history or CLAUDE.md content
- Ephemeral task details

## How to write
- Use YAML frontmatter (name, description, type)
- Be concise and actionable
- Use absolute dates, not relative
- Avoid duplicates with existing memories
</memory_guidelines>`;
}
