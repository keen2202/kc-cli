// Tiered Compaction Engine - Barrel export
// Re-exports all compaction engines and types for convenient importing.
// The functional auto-compaction API (shouldCompact/microcompact/fullCompact/
// forceTruncate) driven by QueryEngineCompaction lives in './functional'.

export type { CompactionEngine, CompactionContext, CompactionResult, CompactionEngineError, CompactionEngineResult } from './types';
export { CachedMicroCompactionEngine } from './cached-micro';
export { SnipCompactionEngine } from './snip';
export { FullCompactionEngine } from './full';
export { ForceTruncationEngine } from './force';
