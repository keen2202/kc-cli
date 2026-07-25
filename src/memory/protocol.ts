// Memory system type definitions

import type { ChatMessage } from '../query/protocol';

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
  confidence?: 'low' | 'high';
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
  confidence?: 'low' | 'high';
}

/**
 * Consolidation lock state
 */
export interface ConsolidationLock {
  pid: number;
  acquiredAt: number;
}

/**
 * LLM semantic extraction configuration (hybrid tier).
 * Disabled by default so behaviour is identical to the heuristic tier until
 * explicitly enabled (gray rollout). See spec T6/GR8.
 */
export interface MemoryLlmExtractionConfig {
  /** Master switch for the LLM extraction tier (default false). */
  enabled: boolean;
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
  sessionArchiveRetentionDays: number;
  relevanceSearchLimit: number;
  // ── LLM semantic extraction (T6) ──
  /** LLM extraction tier toggle (default disabled). */
  llmExtraction: MemoryLlmExtractionConfig;
  /** Model override for the extraction call (defaults to the main model). */
  llmExtractionModel?: string;
  /** Token-set similarity threshold above which a candidate is a duplicate. */
  semanticDedupThreshold: number;
  /** Trigger the LLM tier immediately on high-signal feedback/correction cues. */
  llmTriggerOnFeedbackSignal: boolean;
  /** Optional per-session USD cap for extraction calls. */
  maxExtractionCostUsdPerSession?: number;
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
  sessionArchiveRetentionDays: 90,
  relevanceSearchLimit: 5,
  // ── LLM semantic extraction (T6) — off by default (zero behaviour change) ──
  llmExtraction: { enabled: false },
  semanticDedupThreshold: 0.85,
  llmTriggerOnFeedbackSignal: true,
};
