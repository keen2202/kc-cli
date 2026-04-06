// Memory system type definitions

import type { ChatMessage } from '../types/message';

/**
 * Memory types - constrained to 4 discrete types
 * Excludes derivable information (code patterns, architecture, git history, etc.)
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * Memory file frontmatter - YAML header for memory files
 */
export interface MemoryHeader {
  name: string;
  description: string;
  type: MemoryType;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Complete memory entry with parsed frontmatter and content
 */
export interface MemoryEntry {
  header: MemoryHeader;
  content: string;
  filePath: string;
  fileName: string;
  mtime: number;
}

/**
 * Session filter for listing sessions
 */
export interface SessionFilter {
  newerThan?: number;
  olderThan?: number;
  limit?: number;
}

/**
 * Session snapshot - complete session state for persistence
 */
export interface SessionSnapshot {
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

/**
 * Memory service interface - abstract layer for memory operations
 */
export interface MemoryService {
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

/**
 * Memory manifest entry - formatted summary for relevance search
 */
export interface MemoryManifestEntry {
  fileName: string;
  description: string;
  type: MemoryType;
  mtime: number;
}

/**
 * Consolidation lock state
 */
export interface ConsolidationLock {
  pid: number;
  acquiredAt: number;
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  enabled: boolean;
  autoExtract: boolean;
  autoConsolidate: boolean;
  idleThresholdMinutes: number;
  consolidationMinHours: number;
  consolidationMinSessions: number;
  extractionTurnThrottle: number;
  maxMemoriesPerType: number;
  maxSessionSnapshots: number;
  sessionRetentionDays: number;
  relevanceSearchLimit: number;
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  autoExtract: true,
  autoConsolidate: true,
  idleThresholdMinutes: 5,
  consolidationMinHours: 24,
  consolidationMinSessions: 5,
  extractionTurnThrottle: 3,
  maxMemoriesPerType: 50,
  maxSessionSnapshots: 100,
  sessionRetentionDays: 30,
  relevanceSearchLimit: 5,
};
