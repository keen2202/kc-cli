// Tiered Compaction Engine types
// Defines the interface for pluggable compaction strategies.

import type { ChatMessage } from '../../query/protocol';

/**
 * Context passed to each compaction engine.
 * Provides budget information for deciding which strategy to use.
 */
export interface CompactionContext {
  /** Total token budget for the conversation */
  tokenBudget: number;
  /** Current estimated token count */
  currentTokens: number;
  /** Tokens reserved for system prompt */
  systemPromptTokens: number;
}

/**
 * Result of a successful compaction operation.
 */
export interface CompactionResult {
  /** Compacted message array */
  messages: ChatMessage[];
  /** Number of tokens saved by compaction */
  tokensSaved: number;
  /** Identifier of the compaction method used */
  method: string;
}

/**
 * Error type for compaction failures.
 */
export interface CompactionEngineError {
  code: string;
  message: string;
}

/**
 * Success variant carrying a compaction result.
 */
export interface CompactionOk {
  readonly ok: true;
  readonly value: CompactionResult;
}

/**
 * Error variant carrying a compaction engine error.
 */
export interface CompactionErr {
  readonly ok: false;
  readonly error: CompactionEngineError;
}

/**
 * Discriminated union representing either success or failure of a compaction operation.
 * (Previously aliased from Result<T,E>; now self-contained per A4 dead-code removal.)
 */
export type CompactionEngineResult = CompactionOk | CompactionErr;

/**
 * Create a success result wrapping the given compaction result.
 */
export function ok(value: CompactionResult): CompactionOk {
  return { ok: true, value };
}

/**
 * Create an error result wrapping the given compaction engine error.
 */
export function err(error: CompactionEngineError): CompactionErr {
  return { ok: false, error };
}

/**
 * Interface for a pluggable compaction engine.
 * Each engine implements a specific compaction strategy with a priority
 * that determines the order in which engines are tried.
 */
export interface CompactionEngine {
  /** Human-readable name for this engine */
  name: string;
  /** Priority order (lower = tried first) */
  priority: number;
  /**
   * Check if this engine can handle the current compaction situation.
   * Returns true if the engine should be attempted.
   */
  canHandle(messages: ChatMessage[], context: CompactionContext): boolean;
  /**
   * Execute compaction on the messages.
   * Returns a CompactionEngineResult with compacted messages or an error.
   */
  compact(messages: ChatMessage[], context: CompactionContext): Promise<CompactionEngineResult>;
}
