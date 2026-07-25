// Memory extraction service - background extraction with cursor-based throttling

import { createHash } from 'crypto';
import type { ChatMessage } from '../query/protocol';
import type { AgentState } from '../state/types';
import type { PostTurnHookContext } from '../hooks/postTurnHooks';
import type { MemoryEntry, MemoryType, MemoryConfig, MemoryManifestEntry } from '../memory/types';
import { FileMemoryService } from '../memory/FileMemoryService';
import { getProjectMemoryPath } from '../memory/paths';
import { buildExtractionPrompt } from './extractionPrompts';
import { parseAndValidateWithStats } from './memory-extraction-guard';
import { classifyApiError } from './error-classifier';
import { tokenSetSimilarity } from '../memory/relevanceSearch';
import { estimateTokens } from '../utils/tokenEstimation';
import { logger } from './logger';
import type { LLMRequestConfig, LLMResponse } from '../api/protocol';
import type { BudgetEnforcer } from './budget';
import { recordLlmExtraction, recordDedupSkipped, recordCircuitBroken } from '../memory/telemetry';

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

/** Maximum entries in content hash cache before trimming */
const CONTENT_HASH_CACHE_MAX = 10000;

/**
 * Register content hash in the dedup cache
 * Automatically trims when cache exceeds maximum size.
 */
function registerContentHash(content: string): void {
  if (contentHashCache.size >= CONTENT_HASH_CACHE_MAX) {
    // Trim oldest half by clearing and repopulating is not possible with Set,
    // so clear entirely under memory pressure
    contentHashCache.clear();
  }
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

// ─── Hybrid LLM extraction tier (T2/T3/T5) ─────────────────────────────────
//
// The functions below add an OPTIONAL second tier on top of the deterministic
// heuristic extraction above. When `config.llmExtraction.enabled` is false the
// pipeline is byte-for-byte equivalent to the pure heuristic path (zero
// behaviour change / zero cost). All LLM interaction is dependency-injected so
// the tier is fully mockable in contract tests.

/** Minimal client surface the isolated extraction call needs (mockable). */
export interface LlmExtractionClient {
  chat(config: LLMRequestConfig): Promise<LLMResponse>;
}

/** Consecutive failures before the LLM tier is circuit-broken for the session. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Hard timeout for a single isolated extraction call. */
const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;
/** Blended $ per 1K tokens used to pre-estimate cost (no pricing util exists). */
const DEFAULT_COST_PER_1K_TOKENS = 0.003;
/** Token overhead added for the extraction system-prompt scaffold. */
const PROMPT_SCAFFOLD_TOKEN_OVERHEAD = 512;
/** Max output tokens requested from the extraction model. */
const EXTRACTION_MAX_OUTPUT_TOKENS = 1024;

interface LlmExtractionRuntimeState {
  consecutiveFailures: number;
  circuitBroken: boolean;
  lastExtractedCursor: number;
  /**
   * Accumulated estimated extraction spend for this session (USD). Feeds the
   * `maxExtractionCostUsdPerSession` hard cap (T6) — the second cost
   * constraint alongside the external BudgetEnforcer (spec §9).
   */
  sessionCostUsd: number;
}

const llmRuntime: LlmExtractionRuntimeState = {
  consecutiveFailures: 0,
  circuitBroken: false,
  lastExtractedCursor: -1,
  sessionCostUsd: 0,
};

/** Reset the per-session LLM circuit-breaker / window / cost state. */
export function resetLlmExtractionState(): void {
  llmRuntime.consecutiveFailures = 0;
  llmRuntime.circuitBroken = false;
  llmRuntime.lastExtractedCursor = -1;
  llmRuntime.sessionCostUsd = 0;
}

// High-signal cues that a user turn carries feedback/correction worth an
// immediate LLM extraction (§4 trigger table).
const FEEDBACK_SIGNAL_REGEX =
  /\b(?:remember|don't|do not|avoid|never|always|actually|correction|instead|prefer|i told you|stop doing)\b/i;

/** True when any user message in the window carries a high-signal feedback cue. */
export function hasFeedbackSignal(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => m.role === 'user' && typeof m.content === 'string' && FEEDBACK_SIGNAL_REGEX.test(m.content)
  );
}

/** Flatten user/assistant turns into a plain transcript for the extraction prompt. */
function serializeConversation(messages: ChatMessage[]): string {
  return messages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0
    )
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

/** Conservative token estimate for the whole extraction call (input + output). */
function estimateExtractionTokens(messages: ChatMessage[], existingMemories?: string): number {
  const text = serializeConversation(messages) + (existingMemories ?? '');
  return estimateTokens(text) + PROMPT_SCAFFOLD_TOKEN_OVERHEAD + EXTRACTION_MAX_OUTPUT_TOKENS;
}

export interface LlmTriggerInput {
  /** New messages in the current cursor window. */
  newMessages: ChatMessage[];
  config: MemoryConfig;
  /** Whether an LLM client is actually available. */
  hasClient: boolean;
  /** Idle time since last activity (ms), enables the idle-batch trigger. */
  idleMs?: number;
  /** True when invoked inside a consolidation window. */
  inConsolidationWindow?: boolean;
  /** Current cursor index (used to de-dup one extraction per window). */
  cursor?: number;
  budget?: BudgetEnforcer | null;
  estimatedTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Decide whether the LLM extraction tier should run (T2 / GR6).
 *
 * Only high-value timings pass: feedback signal, session idle, or a
 * consolidation window. Normal turns run the heuristic gate only. Cost is
 * double-gated (spec §9): the per-session extraction spend cap
 * (`maxExtractionCostUsdPerSession`) and the external BudgetEnforcer. The
 * result carries a machine-readable `reason` for telemetry / tests
 * (behaviour contract, not wording).
 */
export function shouldRunLlmExtraction(input: LlmTriggerInput): { run: boolean; reason: string } {
  const { config } = input;

  if (!config.enabled || !config.autoExtract) return { run: false, reason: 'memory_disabled' };
  if (!config.llmExtraction?.enabled) return { run: false, reason: 'llm_disabled' };
  if (!input.hasClient) return { run: false, reason: 'no_client' };
  if (llmRuntime.circuitBroken) return { run: false, reason: 'circuit_broken' };
  if (input.newMessages.length === 0) return { run: false, reason: 'no_new_messages' };

  // De-dup: at most one LLM extraction per cursor window.
  if (input.cursor !== undefined && input.cursor === llmRuntime.lastExtractedCursor) {
    return { run: false, reason: 'already_extracted_window' };
  }

  // High-value trigger gate. Normal turns → heuristic only, no LLM cost.
  const idleThresholdMs = config.idleThresholdMinutes * 60_000;
  let reason: string;
  if (config.llmTriggerOnFeedbackSignal && hasFeedbackSignal(input.newMessages)) {
    reason = 'feedback_signal';
  } else if (input.idleMs !== undefined && input.idleMs >= idleThresholdMs) {
    reason = 'idle';
  } else if (input.inConsolidationWindow) {
    reason = 'consolidation';
  } else {
    return { run: false, reason: 'no_trigger' };
  }

  // Per-session extraction cost cap (T6 / GR6 second constraint, spec §9).
  // Independent of the external BudgetEnforcer: once the accumulated
  // extraction spend for this session would reach the configured cap, the
  // LLM tier is skipped and the pipeline falls back to heuristic.
  const sessionCap = config.maxExtractionCostUsdPerSession;
  if (sessionCap !== undefined) {
    const projected = llmRuntime.sessionCostUsd + (input.estimatedCostUsd ?? 0);
    if (projected >= sessionCap) {
      return { run: false, reason: 'session_cost_exceeded' };
    }
  }

  // Cost/budget hard gate (GR6): pre-estimate before spending anything.
  if (input.budget) {
    const check = input.budget.checkSubAgentBudget(input.estimatedTokens ?? 0, input.estimatedCostUsd);
    if (!check.allowed) {
      return { run: false, reason: 'budget_exceeded' };
    }
  }

  return { run: true, reason };
}

interface IsolatedExtractionResult {
  entries: MemoryEntry[];
  usage?: LLMResponse['usage'];
  redactedSecrets: number;
}

/**
 * Fire the isolated lightweight extraction call (T3 / GR5).
 *
 * Goes DIRECTLY through the injected client — NO QueryEngine, NO memory /
 * post-turn hooks — with its own AbortController + timeout, so the extraction
 * agent can never recursively trigger itself (R3). The raw output is run through
 * the T1 guard before returning; this function only throws on client/transport
 * errors (handled by the caller's error boundary).
 */
async function runIsolatedLlmExtraction(
  newMessages: ChatMessage[],
  opts: {
    client: LlmExtractionClient;
    model: string;
    existingMemories?: string;
    now: () => number;
    maxEntries: number;
    maxContentBytes?: number;
    timeoutMs?: number;
  }
): Promise<IsolatedExtractionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS);
  try {
    const nowMs = opts.now();
    const userMessage: ChatMessage = {
      id: `mem-extract-${nowMs}`,
      role: 'user',
      content: serializeConversation(newMessages),
      timestamp: nowMs,
    };

    const response = await opts.client.chat({
      model: opts.model,
      systemPrompt: buildExtractionPrompt(opts.existingMemories),
      messages: [userMessage],
      maxTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: controller.signal,
    });

    const { entries, stats } = parseAndValidateWithStats(response.content, {
      maxEntries: opts.maxEntries,
      maxContentBytes: opts.maxContentBytes,
      defaultConfidence: 'high',
      now: nowMs,
    });

    return { entries, usage: response.usage, redactedSecrets: stats.discardedSecret };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Second-pass semantic dedup against existing memory descriptions (T4 / GR4).
 * Exact hash dedup already ran inside the heuristic tier; this catches
 * paraphrased duplicates via token-set similarity (no embedding dependency).
 */
function applySemanticDedup(
  candidates: MemoryEntry[],
  manifest: MemoryManifestEntry[],
  threshold: number,
  similarity: (a: string, b: string) => number
): { kept: MemoryEntry[]; skipped: number } {
  if (candidates.length === 0 || manifest.length === 0) {
    return { kept: candidates, skipped: 0 };
  }
  const kept: MemoryEntry[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    const candidateText = `${candidate.header.description} ${candidate.content}`;
    const isDup = manifest.some((m) => similarity(candidateText, m.description) >= threshold);
    if (isDup) {
      skipped++;
      continue;
    }
    kept.push(candidate);
  }
  return { kept, skipped };
}

export interface HybridExtractionOptions {
  config: MemoryConfig;
  client?: LlmExtractionClient | null;
  budget?: BudgetEnforcer | null;
  /** Existing memory manifest provider (for semantic dedup). */
  getExistingManifest?: () => Promise<MemoryManifestEntry[]>;
  /** Pre-rendered existing-memory context for the prompt (dedup hint). */
  existingMemories?: string;
  now?: () => number;
  similarity?: (a: string, b: string) => number;
  model?: string;
  idleMs?: number;
  inConsolidationWindow?: boolean;
  cursor?: number;
}

/**
 * Hybrid two-tier extraction orchestrator (T3).
 *
 * Tier 1 (heuristic gate) always runs — cheap, deterministic. When the LLM tier
 * is enabled AND a high-value trigger + budget allow it, an isolated LLM call
 * produces additional, guard-validated candidates that take priority. Any LLM
 * failure silently degrades to the heuristic candidates (T5). Survivors are
 * semantically de-duplicated against the existing manifest (T4).
 *
 * Confidence grading (T6/GR8): LLM candidates that pass the T1 guard and survive
 * dedup keep `high`; heuristic candidates stay `low`.
 */
export async function extractMemoriesHybrid(
  newMessages: ChatMessage[],
  options: HybridExtractionOptions
): Promise<MemoryEntry[]> {
  const { config } = options;

  // Tier 1 — heuristic gate (always). Cheap regex + hash dedup + quality.
  const heuristic = await extractMemoriesFromMessages(newMessages);

  // Backward-compat fast path: disabled tier ⇒ identical to pure heuristic.
  if (!config.llmExtraction?.enabled) {
    return heuristic;
  }

  const now = options.now ?? (() => Date.now());
  const similarity = options.similarity ?? tokenSetSimilarity;
  const estimatedTokens = estimateExtractionTokens(newMessages, options.existingMemories);
  const estimatedCostUsd = (estimatedTokens / 1000) * DEFAULT_COST_PER_1K_TOKENS;

  const decision = shouldRunLlmExtraction({
    newMessages,
    config,
    hasClient: !!options.client,
    idleMs: options.idleMs,
    inConsolidationWindow: options.inConsolidationWindow,
    cursor: options.cursor,
    budget: options.budget,
    estimatedTokens,
    estimatedCostUsd,
  });

  let llmCandidates: MemoryEntry[] = [];
  let usedLlm = false;

  if (decision.run && options.client) {
    try {
      const result = await runIsolatedLlmExtraction(newMessages, {
        client: options.client,
        model: options.model ?? config.llmExtractionModel ?? 'default',
        existingMemories: options.existingMemories,
        now,
        maxEntries: config.maxMemoriesPerType,
      });
      llmCandidates = result.entries;
      usedLlm = true;
      llmRuntime.consecutiveFailures = 0;
      // Accumulate this session's extraction spend so the
      // `maxExtractionCostUsdPerSession` cap (checked in
      // `shouldRunLlmExtraction`) trips on subsequent calls. Only successful
      // calls are counted — consistent with the telemetry cost accumulation.
      llmRuntime.sessionCostUsd += estimatedCostUsd;
      if (options.cursor !== undefined) {
        llmRuntime.lastExtractedCursor = options.cursor;
      }
      if (options.budget && result.usage) {
        options.budget.recordUsage(result.usage.totalTokens, estimatedCostUsd);
      }
      recordLlmExtraction({
        success: true,
        memoriesFromLlm: llmCandidates.length,
        redactedSecrets: result.redactedSecrets,
        estimatedCostUsd,
      });
    } catch (err) {
      // T5 — silent degrade: classify, count, maybe trip the breaker, then fall
      // through to heuristic candidates. This path NEVER rethrows.
      const classified = classifyApiError(err instanceof Error ? err : new Error(String(err)));
      llmRuntime.consecutiveFailures++;
      recordLlmExtraction({ success: false });
      if (llmRuntime.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !llmRuntime.circuitBroken) {
        llmRuntime.circuitBroken = true;
        recordCircuitBroken();
      }
      logger.memory.debug('[MemoryExtraction] LLM extraction failed; degrading to heuristic', {
        context: classified.context,
        errorClass: classified.errorClass,
        consecutiveFailures: llmRuntime.consecutiveFailures,
      });
    }
  }

  // Merge: LLM candidates first (priority), heuristic supplements.
  const merged = usedLlm ? [...llmCandidates, ...heuristic] : heuristic;

  // Tier 2b — semantic dedup vs existing manifest (T4/GR4).
  if (!options.getExistingManifest) {
    return merged;
  }
  try {
    const manifest = await options.getExistingManifest();
    const { kept, skipped } = applySemanticDedup(
      merged,
      manifest,
      config.semanticDedupThreshold,
      similarity
    );
    if (skipped > 0) {
      recordDedupSkipped(skipped);
    }
    return kept;
  } catch (err) {
    logger.memory.debug('[MemoryExtraction] Semantic dedup skipped due to error', {
      error: String(err),
    });
    return merged;
  }
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
  resetLlmExtractionState();
}
