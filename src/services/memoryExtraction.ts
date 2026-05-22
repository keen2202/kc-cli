// Memory extraction service - background extraction with cursor-based throttling

import { createHash } from 'crypto';
import type { ChatMessage } from '../types/message';
import type { AgentState } from '../state/types';
import type { PostTurnHookContext } from '../hooks/postTurnHooks';
import type { MemoryEntry, MemoryType } from '../memory/types';
import { FileMemoryService } from '../memory/FileMemoryService';
import { getProjectMemoryPath } from '../memory/paths';
import { buildExtractionPrompt } from './extractionPrompts';

interface ExtractionState {
  lastExtractionCursor: number; // Index of last processed message
  turnsSinceLastExtraction: number;
  inProgress: boolean;
  pendingContext: PostTurnHookContext | null;
  totalExtractions: number;
  totalMemoriesExtracted: number;
}

const state: ExtractionState = {
  lastExtractionCursor: 0,
  turnsSinceLastExtraction: 0,
  inProgress: false,
  pendingContext: null,
  totalExtractions: 0,
  totalMemoriesExtracted: 0,
};

let memoryService: FileMemoryService | null = null;
let projectHash: string | null = null;
let turnThrottle: number = 3; // Extract every 3 turns

// Content hash cache for deduplication within a session
const contentHashCache = new Set<string>();

// Quality thresholds
const MIN_CONTENT_LENGTH = 20;
const CODE_BLOCK_RATIO_THRESHOLD = 0.5;

/**
 * Generate a content hash for deduplication
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Check if content passes quality checks
 */
function passesQualityCheck(content: string): { pass: boolean; reason?: string } {
  const trimmed = content.trim();

  // Minimum length check
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { pass: false, reason: 'too_short' };
  }

  // Code-only content check
  const codeBlockMatches = trimmed.match(/```[\s\S]*?```/g) || [];
  const codeBlockLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
  if (trimmed.length > 0 && codeBlockLength / trimmed.length > CODE_BLOCK_RATIO_THRESHOLD) {
    return { pass: false, reason: 'code_only' };
  }

  return { pass: true };
}

/**
 * Check if content is a duplicate of an already-seen memory
 */
function isDuplicate(content: string): boolean {
  const hash = hashContent(content);
  return contentHashCache.has(hash);
}

/**
 * Register content hash in the dedup cache
 */
function registerContentHash(content: string): void {
  contentHashCache.add(hashContent(content));
}

/**
 * Generate a unique filename for a memory to prevent overwrites
 */
function uniqueFileName(baseName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 6);
  return `${baseName}_${timestamp}_${random}.md`;
}

/**
 * Initialize the memory extraction service
 */
export function initMemoryExtraction(
  service: FileMemoryService,
  hash: string,
  throttle: number = 3
): void {
  memoryService = service;
  projectHash = hash;
  turnThrottle = throttle;
}

/**
 * Check if extraction should run based on throttle
 */
export function shouldExtract(): boolean {
  return state.turnsSinceLastExtraction >= turnThrottle;
}

/**
 * Execute memory extraction
 * This is designed to be called as a post-turn hook
 * In the full implementation, this would spawn a forked agent
 * For now, we implement the extraction logic directly
 */
export async function executeMemoryExtraction(context: PostTurnHookContext): Promise<void> {
  if (!memoryService || !projectHash) {
    return; // Not initialized
  }

  // Throttle check
  if (!shouldExtract()) {
    state.turnsSinceLastExtraction++;
    return;
  }

  // Mutex check: skip if already in progress
  if (state.inProgress) {
    // Stash context for trailing run
    state.pendingContext = context;
    return;
  }

  state.inProgress = true;
  state.turnsSinceLastExtraction = 0;

  try {
    // Get new messages since last extraction
    const newMessages = context.messages.slice(state.lastExtractionCursor);
    if (newMessages.length === 0) {
      return; // No new messages
    }

    // Check if main agent already wrote memories (skip if so)
    const mainAgentWroteMemories = checkIfMainAgentWroteMemories(newMessages);
    if (mainAgentWroteMemories) {
      // Advance cursor past these messages
      state.lastExtractionCursor = context.messages.length;
      return;
    }

    // Extract memories from new messages
    const memories = await extractMemoriesFromMessages(newMessages);

    if (memories.length > 0) {
      // Save extracted memories
      let savedCount = 0;
      for (const memory of memories) {
        try {
          await memoryService!.addMemory(projectHash!, memory);
          savedCount++;
        } catch (err) {
          console.error('[MemoryExtraction] Failed to save memory:', err);
        }
      }

      state.totalMemoriesExtracted += savedCount;
      console.log(`[MemoryExtraction] Extracted and saved ${savedCount} memories`);
    }

    // Advance cursor
    state.lastExtractionCursor = context.messages.length;
    state.totalExtractions++;
  } catch (err) {
    console.error('[MemoryExtraction] Extraction failed:', err);
  } finally {
    state.inProgress = false;

    // Check for pending trailing context
    if (state.pendingContext) {
      const trailingContext = state.pendingContext;
      state.pendingContext = null;
      // Run trailing extraction without throttle
      state.turnsSinceLastExtraction = turnThrottle;
      // Fire-and-forget with error boundary
      executeMemoryExtraction(trailingContext).catch(err => {
        console.error('[MemoryExtraction] Trailing extraction failed:', err);
      });
    }
  }
}

// Pre-compiled regex for memory-related keywords (single test instead of 4 sequential includes)
const MEMORY_WRITE_REGEX = /memory file|wrote to memory|saved memory|updated memory/;

/**
 * Check if the main agent already wrote memories in these messages
 */
function checkIfMainAgentWroteMemories(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.content) {
      // Single regex test instead of 4 sequential includes() calls
      if (MEMORY_WRITE_REGEX.test(msg.content.toLowerCase())) {
        return true;
      }
    }

    // Check tool results for memory file writes
    if (msg.role === 'tool' && msg.toolResults) {
      for (const result of msg.toolResults) {
        if (result.output.toLowerCase().includes('memory') && !result.isError) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract memories from conversation messages
 * In the full implementation, this would use a forked LLM agent
 * For now, we implement a heuristic-based extraction
 */
export async function extractMemoriesFromMessages(
  messages: ChatMessage[]
): Promise<MemoryEntry[]> {
  const memories: MemoryEntry[] = [];

  // Look for patterns that indicate important information
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      // Extract user preferences
      const preferences = extractUserPreferences(msg.content);
      if (preferences) {
        memories.push(preferences);
      }

      // Extract project decisions
      const decisions = extractProjectDecisions(msg.content);
      if (decisions) {
        memories.push(decisions);
      }
    }

    if (msg.role === 'assistant' && msg.content) {
      // Extract feedback/lessons
      const feedback = extractFeedback(msg.content);
      if (feedback) {
        memories.push(feedback);
      }
    }
  }

  return memories;
}

/**
 * Extract user preferences from a message
 */
function extractUserPreferences(content: string): MemoryEntry | null {
  // Look for preference indicators
  const preferencePatterns = [
    /i prefer\s+(.+)/i,
    /i (?:like|want|need)\s+(.+)/i,
    /my (?:role|expertise|background)\s+is\s+(.+)/i,
    /i (?:work|specialize)\s+in\s+(.+)/i,
  ];

  for (const pattern of preferencePatterns) {
    const match = content.match(pattern);
    if (match) {
      const extracted = match[1].trim();
      const quality = passesQualityCheck(extracted);
      if (!quality.pass) continue;
      if (isDuplicate(extracted)) continue;

      registerContentHash(extracted);
      return {
        header: {
          name: 'user_preferences',
          description: 'Extracted user preferences',
          type: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          confidence: 'low',
        },
        content: extracted,
        filePath: '',
        fileName: uniqueFileName('user_preferences'),
        mtime: Date.now(),
      };
    }
  }

  return null;
}

/**
 * Extract project decisions from a message
 */
function extractProjectDecisions(content: string): MemoryEntry | null {
  const decisionPatterns = [
    /we (?:should|will|decided to|are going to)\s+(.+)/i,
    /the (?:goal|objective|target)\s+is\s+(.+)/i,
    /the (?:deadline|timeline)\s+is\s+(.+)/i,
  ];

  for (const pattern of decisionPatterns) {
    const match = content.match(pattern);
    if (match) {
      const extracted = match[1].trim();
      const quality = passesQualityCheck(extracted);
      if (!quality.pass) continue;
      if (isDuplicate(extracted)) continue;

      registerContentHash(extracted);
      return {
        header: {
          name: 'project_decisions',
          description: 'Extracted project decisions',
          type: 'project',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          confidence: 'low',
        },
        content: extracted,
        filePath: '',
        fileName: uniqueFileName('project_decisions'),
        mtime: Date.now(),
      };
    }
  }

  return null;
}

/**
 * Extract feedback/lessons from a message
 */
function extractFeedback(content: string): MemoryEntry | null {
  const feedbackPatterns = [
    /don't\s+(.+)/i,
    /avoid\s+(.+)/i,
    /(?:remember|note)\s+(?:that\s+)?(.+)/i,
    /(?:lesson|insight)\s*:\s*(.+)/i,
  ];

  for (const pattern of feedbackPatterns) {
    const match = content.match(pattern);
    if (match) {
      const extracted = match[1].trim();
      const quality = passesQualityCheck(extracted);
      if (!quality.pass) continue;
      if (isDuplicate(extracted)) continue;

      registerContentHash(extracted);
      return {
        header: {
          name: 'feedback_lessons',
          description: 'Extracted feedback and lessons',
          type: 'feedback',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          confidence: 'low',
        },
        content: extracted,
        filePath: '',
        fileName: uniqueFileName('feedback_lessons'),
        mtime: Date.now(),
      };
    }
  }

  return null;
}

/**
 * Advance the extraction cursor
 */
export function advanceCursor(messageIndex: number): void {
  state.lastExtractionCursor = Math.max(state.lastExtractionCursor, messageIndex);
}

/**
 * Get extraction statistics
 */
export function getExtractionStats(): {
  totalExtractions: number;
  totalMemoriesExtracted: number;
  lastCursor: number;
  turnsSinceLastExtraction: number;
  inProgress: boolean;
} {
  return {
    totalExtractions: state.totalExtractions,
    totalMemoriesExtracted: state.totalMemoriesExtracted,
    lastCursor: state.lastExtractionCursor,
    turnsSinceLastExtraction: state.turnsSinceLastExtraction,
    inProgress: state.inProgress,
  };
}

/**
 * Reset extraction state
 */
export function resetExtractionState(): void {
  state.lastExtractionCursor = 0;
  state.turnsSinceLastExtraction = 0;
  state.inProgress = false;
  state.pendingContext = null;
  contentHashCache.clear();
}
