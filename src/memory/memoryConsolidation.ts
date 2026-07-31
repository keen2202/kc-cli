// Memory consolidation service - four-stage consolidation process

import * as fs from 'fs/promises';
import * as path from 'path';
import type { MemoryEntry, MemoryType } from './types';
import {
  getProjectMemoryPath,
  getConsolidateLockPath,
  ensureMemoryDir,
  validateMemoryPath,
} from './paths';
import { parseFrontmatter, composeMemoryFile, validateMemoryType } from './frontmatter';
import { scanMemoryFiles, updateMemoryEntrypoint } from './scanner';
import { FileMemoryService } from './FileMemoryService';
import { markConsolidationComplete } from './consolidationScheduler';

// Module-level memory service reference (set during initialization)
let memoryServiceRef: FileMemoryService | null = null;

// Pre-compiled regex for transcript keyword detection (single test instead of multiple includes())
const PREFERENCE_REGEX = /prefer|i\s+like/;
const DECISION_REGEX = /decided|we\s+should/;
const FEEDBACK_REGEX = /don't|avoid/;

/**
 * Initialize the consolidation service with a memory service reference
 */
export function initConsolidationService(service: FileMemoryService): void {
  memoryServiceRef = service;
}

interface ConsolidationState {
  inProgress: boolean;
  lastCompletedAt: number;
  totalConsolidations: number;
  totalMemoriesProcessed: number;
}

const state: ConsolidationState = {
  inProgress: false,
  lastCompletedAt: 0,
  totalConsolidations: 0,
  totalMemoriesProcessed: 0,
};

/**
 * Execute the complete four-stage consolidation process
 */
export async function executeConsolidation(
  projectHash: string,
  sessionTranscripts?: string[]
): Promise<{
  success: boolean;
  memoriesProcessed: number;
  memoriesUpdated: number;
  memoriesCreated: number;
  memoriesDeleted: number;
}> {
  if (state.inProgress) {
    return { success: false, memoriesProcessed: 0, memoriesUpdated: 0, memoriesCreated: 0, memoriesDeleted: 0 };
  }

  // Acquire lock
  const lockAcquired = await acquireConsolidationLock(projectHash);
  if (!lockAcquired) {
    console.log('[Consolidation] Lock already held, skipping');
    return { success: false, memoriesProcessed: 0, memoriesUpdated: 0, memoriesCreated: 0, memoriesDeleted: 0 };
  }

  state.inProgress = true;
  const result = {
    success: false,
    memoriesProcessed: 0,
    memoriesUpdated: 0,
    memoriesCreated: 0,
    memoriesDeleted: 0,
  };

  try {
    // Stage 1 & 2: Orient and Collect in parallel (both are read-only)
    const [orientResult, collectResult] = await Promise.all([
      stage_orient(projectHash),
      stage_collect(projectHash, sessionTranscripts),
    ]);
    result.memoriesProcessed += orientResult.count + collectResult.count;

    // Stage 3: Integrate
    const integrateResult = await stage_integrate(projectHash, collectResult.insights);
    result.memoriesUpdated = integrateResult.updated;
    result.memoriesCreated = integrateResult.created;

    // Stage 4: Trim
    const trimResult = await stage_trim(projectHash);
    result.memoriesDeleted = trimResult.deleted;

    state.lastCompletedAt = Date.now();
    state.totalConsolidations++;
    state.totalMemoriesProcessed += result.memoriesProcessed;

    result.success = true;
    console.log(`[Consolidation] Completed: ${result.memoriesProcessed} processed, ${result.memoriesCreated} created, ${result.memoriesUpdated} updated, ${result.memoriesDeleted} deleted`);
  } catch (err) {
    console.error('[Consolidation] Failed:', err);
    result.success = false;
  } finally {
    state.inProgress = false;
    markConsolidationComplete(projectHash);
    await releaseConsolidationLock(projectHash);
  }

  return result;
}

/**
 * Stage 1: ORIENT
 * Read existing MEMORY.md and skim topic files to understand current structure
 */
async function stage_orient(projectHash: string): Promise<{ count: number; files: string[] }> {
  const memories = await scanMemoryFiles(projectHash);
  console.log(`[Consolidation:Orient] Found ${memories.length} existing memory files`);

  // Return list of existing files for reference
  return {
    count: memories.length,
    files: memories.map((m) => m.fileName),
  };
}

/**
 * Stage 2: COLLECT
 * Scan recent sessions and look for drifted/outdated memories
 */
async function stage_collect(
  projectHash: string,
  sessionTranscripts?: string[]
): Promise<{ count: number; insights: string[] }> {
  const insights: string[] = [];

  // In the full implementation, this would:
  // 1. Scan recent session snapshots for new insights
  // 2. Look for drifted/outdated memories
  // 3. Search for specific context using keyword patterns

  // For now, we scan existing memories and identify potential issues
  const memories = await scanMemoryFiles(projectHash);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (const memory of memories) {
    const age = now - memory.mtime;

    // Flag stale memories
    if (age > thirtyDaysMs) {
      insights.push(`STALE: ${memory.fileName} - last updated ${Math.floor(age / (24 * 60 * 60 * 1000))} days ago`);
    }
  }

  // If session transcripts provided, extract potential new insights
  if (sessionTranscripts && sessionTranscripts.length > 0) {
    for (const transcript of sessionTranscripts) {
      // Simple keyword-based extraction
      const lowerTranscript = transcript.toLowerCase();

      if (PREFERENCE_REGEX.test(lowerTranscript)) {
        insights.push('POTENTIAL_USER_PREFERENCE: Found user preference in recent session');
      }

      if (DECISION_REGEX.test(lowerTranscript)) {
        insights.push('POTENTIAL_PROJECT_DECISION: Found project decision in recent session');
      }

      if (FEEDBACK_REGEX.test(lowerTranscript)) {
        insights.push('POTENTIAL_FEEDBACK: Found feedback/lesson in recent session');
      }
    }
  }

  console.log(`[Consolidation:Collect] Collected ${insights.length} insights`);

  return {
    count: insights.length,
    insights,
  };
}

/**
 * Stage 3: INTEGRATE
 * Merge related insights, update existing memories, create new files
 */
async function stage_integrate(
  projectHash: string,
  insights: string[]
): Promise<{ updated: number; created: number }> {
  let updated = 0;
  let created = 0;

  // Process insights
  for (const insight of insights) {
    if (insight.startsWith('STALE:')) {
      // Mark stale memories for review
      const fileName = insight.replace('STALE: ', '').split(' - ')[0];
      await markMemoryForReview(projectHash, fileName.trim());
      updated++;
    } else if (insight.startsWith('POTENTIAL_')) {
      // In full implementation, this would use LLM to extract and create memories
      // For now, we log the potential insight
      console.log(`[Consolidation:Integrate] Potential new memory: ${insight}`);
    }
  }

  // Merge related existing memories
  const mergeResult = await mergeRelatedMemories(projectHash);
  updated += mergeResult.merged;

  console.log(`[Consolidation:Integrate] Updated ${updated}, created ${created}`);

  return { updated, created };
}

/**
 * Stage 4: TRIM (PRUNE & INDEX)
 * Maintain MEMORY.md under limits, remove stale entries, resolve contradictions
 */
async function stage_trim(projectHash: string): Promise<{ deleted: number }> {
  let deleted = 0;

  // Use memoryServiceRef to get full MemoryEntry with content
  if (!memoryServiceRef) {
    console.log('[Consolidation:Trim] Memory service not initialized, skipping');
    return { deleted: 0 };
  }

  const memories = await memoryServiceRef.listMemories(projectHash);
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  // Remove very old, empty, or invalid memories
  for (const memory of memories) {
    const age = now - memory.mtime;

    // Remove empty memories
    if (!memory.header.description || memory.content.trim().length === 0) {
      await deleteMemory(projectHash, memory.fileName);
      deleted++;
      continue;
    }

    // Flag very old memories for review (don't auto-delete)
    if (age > ninetyDaysMs) {
      console.log(`[Consolidation:Trim] Very old memory flagged: ${memory.fileName}`);
    }
  }

  // Update MEMORY.md index
  const freshMemories = await scanMemoryFiles(projectHash);
  await updateMemoryEntrypoint(projectHash, freshMemories);

  console.log(`[Consolidation:Trim] Deleted ${deleted} memories`);

  return { deleted };
}

// ==================== Helper Functions ====================

/**
 * Acquire consolidation lock
 */
async function acquireConsolidationLock(projectHash: string): Promise<boolean> {
  const lockPath = getConsolidateLockPath(projectHash);
  const projectPath = getProjectMemoryPath(projectHash);

  await ensureMemoryDir(projectHash);

  // Check if lock exists and is stale (>1 hour old)
  try {
    const stat = await fs.stat(lockPath);
    const age = Date.now() - stat.mtimeMs;
    const oneHourMs = 60 * 60 * 1000;

    if (age < oneHourMs) {
      return false; // Lock is fresh, consolidation in progress
    }

    // Lock is stale, reclaim
    console.log('[Consolidation] Reclaiming stale lock');
  } catch {
    // Lock doesn't exist, proceed
  }

  // Write lock
  const lockContent = JSON.stringify({
    pid: process.pid,
    acquiredAt: Date.now(),
  });

  try {
    await fs.writeFile(lockPath, lockContent, 'utf-8');
    return true;
  } catch (err) {
    console.error('[Consolidation] Failed to acquire lock:', err);
    return false;
  }
}

/**
 * Release consolidation lock
 */
async function releaseConsolidationLock(projectHash: string): Promise<void> {
  const lockPath = getConsolidateLockPath(projectHash);

  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[Consolidation] Failed to release lock:', err);
    }
  }
}

/**
 * Mark a memory for review
 */
async function markMemoryForReview(projectHash: string, fileName: string): Promise<void> {
  const projectPath = getProjectMemoryPath(projectHash);
  const filePath = path.join(projectPath, fileName);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const { header, body } = parseFrontmatter(content);

    if (header.updatedAt) {
      // Add review note
      const reviewNote = `\n\n*[Marked for review during consolidation - ${new Date().toISOString()}]*`;
      const updatedContent = composeMemoryFile(
        {
          name: header.name || fileName.replace('.md', ''),
          description: header.description || '',
          type: (validateMemoryType(header.type || '') || 'project') as MemoryType,
          createdAt: header.createdAt,
          updatedAt: header.updatedAt,
        },
        body + reviewNote
      );

      await fs.writeFile(filePath, updatedContent, 'utf-8');
    }
  } catch (err) {
    console.error(`[Consolidation] Failed to mark ${fileName} for review:`, err);
  }
}

/**
 * Delete a memory file
 */
async function deleteMemory(projectHash: string, fileName: string): Promise<void> {
  const projectPath = getProjectMemoryPath(projectHash);
  const filePath = path.join(projectPath, fileName);

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[Consolidation] Failed to delete ${fileName}:`, err);
    }
  }
}

/**
 * Merge related memories (simplified implementation)
 */
async function mergeRelatedMemories(
  projectHash: string
): Promise<{ merged: number }> {
  if (!memoryServiceRef) {
    return { merged: 0 };
  }

  const memories = await memoryServiceRef.listMemories(projectHash);
  let merged = 0;

  // Group memories by type
  const byType = new Map<string, typeof memories>();
  for (const memory of memories) {
    const type = memory.header.type || 'unknown';
    if (!byType.has(type)) {
      byType.set(type, []);
    }
    byType.get(type)!.push(memory);
  }

  // Within each type, find and merge duplicates (same name or very similar content)
  for (const [type, group] of byType) {
    if (group.length < 2) continue;

    // Find memories with the same name (duplicates)
    const byName = new Map<string, typeof group>();
    for (const memory of group) {
      const name = memory.header.name;
      if (!byName.has(name)) {
        byName.set(name, []);
      }
      byName.get(name)!.push(memory);
    }

    // Merge duplicates: keep the newest, delete the rest
    for (const [name, duplicates] of byName) {
      if (duplicates.length < 2) continue;

      // Sort by update time, newest first
      duplicates.sort((a, b) => (b.header.updatedAt || 0) - (a.header.updatedAt || 0));

      // Keep the first (newest), merge content from others
      const keeper = duplicates[0];
      const additionalContent: string[] = [];

      for (let i = 1; i < duplicates.length; i++) {
        const dup = duplicates[i];
        // Only merge if content is different
        if (dup.content.trim() !== keeper.content.trim()) {
          additionalContent.push(dup.content.trim());
        }
        // Delete the duplicate
        try {
          await deleteMemory(projectHash, dup.fileName);
          merged++;
        } catch (err) {
          console.warn(`[Consolidation:Merge] Failed to delete duplicate ${dup.fileName}:`, err);
        }
      }

      // If we collected additional content, append it to the keeper
      if (additionalContent.length > 0) {
        const updatedContent = [keeper.content.trim(), ...additionalContent].join('\n\n');
        try {
          await memoryServiceRef!.addMemory(projectHash, {
            ...keeper,
            content: updatedContent,
            header: {
              ...keeper.header,
              updatedAt: Date.now(),
            },
          });
        } catch (err) {
          console.warn(`[Consolidation:Merge] Failed to update merged memory ${keeper.fileName}:`, err);
        }
      }
    }
  }

  return { merged };
}

/**
 * Get consolidation statistics
 */
export function getConsolidationStats(): {
  inProgress: boolean;
  lastCompletedAt: number;
  totalConsolidations: number;
  totalMemoriesProcessed: number;
} {
  return {
    inProgress: state.inProgress,
    lastCompletedAt: state.lastCompletedAt,
    totalConsolidations: state.totalConsolidations,
    totalMemoriesProcessed: state.totalMemoriesProcessed,
  };
}

/**
 * Check if enough time has passed since last consolidation
 */
export function canConsolidate(minHours: number = 24): boolean {
  if (state.inProgress) return false;

  const hoursSinceLast = (Date.now() - state.lastCompletedAt) / (1000 * 60 * 60);
  return hoursSinceLast >= minHours;
}
