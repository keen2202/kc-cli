// CachePrefixService — Guarantee byte-stable prompt prefixes across consecutive API calls
// Inspired by DeepSeek-Reasonix's three-zone context model:
//   Immutable Prefix (frozen) → Append-Only Log (messages) → Ephemeral Zone (per-turn)

import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../types/tools';

/**
 * Provider-specific cache strategy.
 * Determines how the client should place cache breakpoints / ensure prefix stability.
 */
export type CacheStrategy = 'explicit-breakpoints' | 'auto-prefix' | 'prompt-cache' | 'none';

/**
 * Frozen prefix: the immutable portion of the prompt, serialized with canonical JSON.
 * Computed once at session start and reused for all turns.
 */
export interface FrozenPrefix {
  /** Canonical serialized system prompt */
  systemPrompt: string;
  /** Canonical serialized tool definitions */
  toolsJson: string;
  /** SHA-256 fingerprint of the combined prefix */
  fingerprint: string;
  /** Provider this prefix was frozen for */
  provider: string;
}

/**
 * Ephemeral content that changes per-turn but must NOT break the cache prefix.
 * Injected after the cache boundary (appended to last user message, or as a separate block).
 */
export interface EphemeralContent {
  /** Memory context from relevant memories */
  memoryContext: string;
  /** Level adaptation from behavioral adapter */
  levelAdaptation: string;
}

/**
 * Canonical JSON serialization with deterministic key ordering.
 * Recursively sorts all object keys to guarantee identical output for identical input.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalStringify(item)).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map(key => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`);
    return '{' + pairs.join(',') + '}';
  }

  return JSON.stringify(value);
}

/**
 * Compute SHA-256 fingerprint of a string.
 */
function fingerprint(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Deep-freeze an object (shallow freeze of all nested objects).
 */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

/**
 * Serialize a tool definition to canonical JSON format.
 * Sorts schema properties and freezes the result.
 */
export function serializeToolCanonical(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: canonicalStringify(extractSchemaParams(tool.inputSchema)),
  };
}

/**
 * Extract parameters from a tool's inputSchema (Zod or plain object).
 */
function extractSchemaParams(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }

  const s = schema as Record<string, unknown>;
  const req = Array.isArray(s.required) ? [...(s.required as string[])].sort() : [];
  return {
    type: s.type || 'object',
    properties: s.properties || {},
    required: req,
  };
}

export class CachePrefixService {
  private frozenPrefix: FrozenPrefix | null = null;
  private lastFingerprint: string = '';
  private frozenToolSpecs: string = '';

  constructor(
    private readonly provider: string,
    private readonly strategy: CacheStrategy,
  ) {}

  /**
   * Freeze the prefix (system prompt + tool definitions) for this session.
   * Must be called once at session start. Subsequent calls are no-ops.
   */
  freezePrefix(systemPrompt: string, tools: ToolDefinition[]): FrozenPrefix {
    if (this.frozenPrefix) {
      return this.frozenPrefix;
    }

    const toolsJson = this.serializeToolsCanonical(tools);
    this.frozenToolSpecs = toolsJson;

    const combined = systemPrompt + '\n---TOOLS---\n' + toolsJson;
    const fp = fingerprint(combined);

    this.frozenPrefix = {
      systemPrompt,
      toolsJson,
      fingerprint: fp,
      provider: this.provider,
    };

    this.lastFingerprint = fp;
    return this.frozenPrefix;
  }

  /**
   * Get the stable (frozen) system prompt.
   * This portion never changes between turns.
   */
  getStableSystemPrompt(): string {
    return this.frozenPrefix?.systemPrompt ?? '';
  }

  /**
   * Get the stable (frozen) tool specs in canonical JSON.
   */
  getStableToolSpecs(): string {
    return this.frozenPrefix?.toolsJson ?? this.frozenToolSpecs;
  }

  /**
   * Get ephemeral (per-turn) content that should NOT be in the cached prefix.
   * Returns null if both are empty.
   */
  getEphemeralAugmentations(memoryContext: string, levelAdaptation: string): EphemeralContent | null {
    if (!memoryContext && !levelAdaptation) {
      return null;
    }
    return { memoryContext, levelAdaptation };
  }

  /**
   * Get the cache strategy for this provider.
   */
  getCacheStrategy(): CacheStrategy {
    return this.strategy;
  }

  /**
   * Check if the current prefix fingerprint matches the last request.
   * Returns true if the prefix is stable (same bytes as previous call).
   */
  isPrefixStable(): boolean {
    if (!this.frozenPrefix) return false;
    return this.frozenPrefix.fingerprint === this.lastFingerprint;
  }

  /**
   * Get the current prefix fingerprint.
   */
  getFingerprint(): string {
    return this.frozenPrefix?.fingerprint ?? '';
  }

  /**
   * Check if the prefix has been frozen.
   */
  isFrozen(): boolean {
    return this.frozenPrefix !== null;
  }

  /**
   * Serialize tools in canonical (deterministic) JSON format.
   */
  private serializeToolsCanonical(tools: ToolDefinition[]): string {
    const serialized = tools.map(t => serializeToolCanonical(t));
    // Sort by name for deterministic ordering
    serialized.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return canonicalStringify(serialized);
  }
}

/**
 * Build the cache strategy for a given provider.
 */
export function buildCacheStrategy(provider: string): CacheStrategy {
  switch (provider) {
    case 'anthropic':
      return 'explicit-breakpoints';
    case 'deepseek':
      return 'auto-prefix';
    case 'openai':
      return 'prompt-cache';
    case 'qwen':
    case 'glm':
    case 'mimo':
    case 'kimi':
    case 'step':
    case 'gemini':
    case 'ollama':
    case 'openai-compatible':
    default:
      return 'none';
  }
}
