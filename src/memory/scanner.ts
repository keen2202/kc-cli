// Memory file scanner - scans and indexes memory files

import * as path from 'path';
import * as fs from 'fs/promises';
import type { MemoryEntry, MemoryType, MemoryManifestEntry } from '../memory/types';
import { getProjectMemoryPath } from '../memory/paths';
import { parseFrontmatter, validateMemoryType } from '../memory/frontmatter';
import { getAgeText } from '../utils/format';

const MAX_MEMORY_FILES = 200;

/**
 * Scan memory directory and return indexed memory files
 */
export async function scanMemoryFiles(
  projectHash: string,
  limit: number = MAX_MEMORY_FILES
): Promise<MemoryManifestEntry[]> {
  const projectPath = getProjectMemoryPath(projectHash);

  try {
    await fs.access(projectPath);
  } catch {
    return [];
  }

  const files = await fs.readdir(projectPath);
  const mdFiles = files.filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('.')
  );

  const entries: MemoryManifestEntry[] = [];

  for (const file of mdFiles) {
    try {
      const filePath = path.join(projectPath, file);
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const { header } = parseFrontmatter(content);

      if (!header.name || !header.type) continue;

      const memoryType = validateMemoryType(header.type);
      if (!memoryType) continue;

      entries.push({
        fileName: file,
        description: header.description || '',
        type: memoryType,
        mtime: stat.mtimeMs,
      });
    } catch {
      // Skip invalid files
      continue;
    }

    if (entries.length >= limit) break;
  }

  // Sort by mtime descending (newest first)
  entries.sort((a, b) => b.mtime - a.mtime);

  return entries;
}

/**
 * Format memory manifest entries as a string for LLM relevance search
 */
export function formatMemoryManifest(entries: MemoryManifestEntry[]): string {
  if (entries.length === 0) {
    return 'No existing memories found.';
  }

  const lines = entries.map((entry) => {
    const age = getAgeText(entry.mtime);
    return `- [${entry.type}] ${entry.fileName} (${age}): ${entry.description}`;
  });

  return `Existing memories:\n${lines.join('\n')}`;
}

/**
 * Get human-readable age text for a memory file
 */
export { getAgeText } from '../utils/format';

/**
 * Load the MEMORY.md entrypoint file
 */
export async function loadMemoryEntrypoint(projectHash: string): Promise<string | null> {
  const projectPath = getProjectMemoryPath(projectHash);
  const entrypointPath = path.join(projectPath, 'MEMORY.md');

  try {
    const content = await fs.readFile(entrypointPath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}

/**
 * Update the MEMORY.md entrypoint file
 */
export async function updateMemoryEntrypoint(
  projectHash: string,
  entries: MemoryManifestEntry[],
  maxLines: number = 200,
  maxBytes: number = 25 * 1024 // 25KB
): Promise<void> {
  const projectPath = getProjectMemoryPath(projectHash);

  // Ensure directory exists
  await fs.mkdir(projectPath, { recursive: true });

  const entrypointPath = path.join(projectPath, 'MEMORY.md');

  // Build index content
  const lines = ['# Memory Index', ''];

  // Group by type
  const byType = new Map<MemoryType, MemoryManifestEntry[]>();
  for (const entry of entries) {
    const existing = byType.get(entry.type) || [];
    existing.push(entry);
    byType.set(entry.type, existing);
  }

  const typeOrder: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

  for (const type of typeOrder) {
    const typeEntries = byType.get(type) || [];
    if (typeEntries.length === 0) continue;

    lines.push(`## ${capitalizeType(type)}`);
    lines.push('');

    for (const entry of typeEntries) {
      const line = `- [${entry.fileName.replace('.md', '')}](${entry.fileName}) — ${entry.description}`;

      // Truncate long lines
      if (line.length > 150) {
        lines.push(line.substring(0, 147) + '...');
      } else {
        lines.push(line);
      }

      // Check limits
      if (lines.length >= maxLines) {
        lines.push('', '... (truncated)');
        break;
      }
    }

    lines.push('');

    if (lines.length >= maxLines) break;
  }

  let content = lines.join('\n');

  // Truncate by bytes if needed
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.length > maxBytes) {
    // Truncate and decode back
    const truncated = bytes.slice(0, maxBytes);
    const decoder = new TextDecoder();
    content = decoder.decode(truncated);

    // Remove partial line
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline > 0) {
      content = content.substring(0, lastNewline);
    }

    content += '\n\n... (truncated - exceeded 25KB limit)';
  }

  // Atomic write
  const tempPath = `${entrypointPath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, entrypointPath);
}

function capitalizeType(type: MemoryType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
