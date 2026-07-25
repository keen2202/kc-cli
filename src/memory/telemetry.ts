// Memory system telemetry - tracks memory system health and usage

interface MemoryTelemetryData {
  // Extraction stats
  extractionsTotal: number;
  extractionsFailed: number;
  memoriesExtracted: number;
  lastExtractionAt: number;

  // LLM extraction stats (hybrid tier)
  llmExtractionCalls: number;
  heuristicFallbacks: number;
  memoriesFromLlm: number;
  redactedSecrets: number;
  dedupSkipped: number;
  estimatedCostUsd: number;
  circuitBroken: boolean;

  // Consolidation stats
  consolidationsTotal: number;
  consolidationsFailed: number;
  memoriesProcessed: number;
  lastConsolidationAt: number;

  // Memory counts by type
  memoryCountUser: number;
  memoryCountFeedback: number;
  memoryCountProject: number;
  memoryCountReference: number;

  // Session stats
  sessionSnapshotsTotal: number;
  sessionsArchived: number;
  sessionsPruned: number;

  // Performance
  averageExtractionTimeMs: number;
  averageConsolidationTimeMs: number;
}

let telemetry: MemoryTelemetryData = {
  extractionsTotal: 0,
  extractionsFailed: 0,
  memoriesExtracted: 0,
  lastExtractionAt: 0,

  llmExtractionCalls: 0,
  heuristicFallbacks: 0,
  memoriesFromLlm: 0,
  redactedSecrets: 0,
  dedupSkipped: 0,
  estimatedCostUsd: 0,
  circuitBroken: false,

  consolidationsTotal: 0,
  consolidationsFailed: 0,
  memoriesProcessed: 0,
  lastConsolidationAt: 0,

  memoryCountUser: 0,
  memoryCountFeedback: 0,
  memoryCountProject: 0,
  memoryCountReference: 0,

  sessionSnapshotsTotal: 0,
  sessionsArchived: 0,
  sessionsPruned: 0,

  averageExtractionTimeMs: 0,
  averageConsolidationTimeMs: 0,
};

// Running totals for average calculation
let totalExtractionTimeMs = 0;
let totalConsolidationTimeMs = 0;

/**
 * Record extraction completion
 */
export function recordExtraction(
  success: boolean,
  memoriesCount: number,
  durationMs: number
): void {
  telemetry.extractionsTotal++;
  telemetry.lastExtractionAt = Date.now();

  if (success) {
    telemetry.memoriesExtracted += memoriesCount;
  } else {
    telemetry.extractionsFailed++;
  }

  // Update running average
  totalExtractionTimeMs += durationMs;
  telemetry.averageExtractionTimeMs =
    totalExtractionTimeMs / telemetry.extractionsTotal;
}

/**
 * Record a single isolated LLM extraction call outcome (hybrid tier, T7).
 * `success=false` means the call errored and the pipeline degraded to heuristic.
 */
export function recordLlmExtraction(params: {
  success: boolean;
  memoriesFromLlm?: number;
  redactedSecrets?: number;
  estimatedCostUsd?: number;
}): void {
  telemetry.llmExtractionCalls++;
  if (params.success) {
    telemetry.memoriesFromLlm += params.memoriesFromLlm ?? 0;
    telemetry.redactedSecrets += params.redactedSecrets ?? 0;
    telemetry.estimatedCostUsd += params.estimatedCostUsd ?? 0;
  } else {
    telemetry.heuristicFallbacks++;
  }
}

/**
 * Record that semantic dedup skipped `count` candidate memories (T4/T7).
 */
export function recordDedupSkipped(count: number): void {
  telemetry.dedupSkipped += count;
}

/**
 * Mark the LLM extraction circuit breaker as tripped for the session (T5/T7).
 */
export function recordCircuitBroken(): void {
  telemetry.circuitBroken = true;
}

/**
 * Record consolidation completion
 */
export function recordConsolidation(
  success: boolean,
  memoriesProcessed: number,
  durationMs: number
): void {
  telemetry.consolidationsTotal++;
  telemetry.lastConsolidationAt = Date.now();
  telemetry.memoriesProcessed += memoriesProcessed;

  if (!success) {
    telemetry.consolidationsFailed++;
  }

  // Update running average
  totalConsolidationTimeMs += durationMs;
  telemetry.averageConsolidationTimeMs =
    totalConsolidationTimeMs / telemetry.consolidationsTotal;
}

/**
 * Update memory counts by type
 */
export function updateMemoryCounts(counts: {
  user: number;
  feedback: number;
  project: number;
  reference: number;
}): void {
  telemetry.memoryCountUser = counts.user;
  telemetry.memoryCountFeedback = counts.feedback;
  telemetry.memoryCountProject = counts.project;
  telemetry.memoryCountReference = counts.reference;
}

/**
 * Update session stats
 */
export function updateSessionStats(stats: {
  total: number;
  archived: number;
  pruned: number;
}): void {
  telemetry.sessionSnapshotsTotal = stats.total;
  telemetry.sessionsArchived = stats.archived;
  telemetry.sessionsPruned = stats.pruned;
}

/**
 * Get current telemetry data
 */
export function getTelemetry(): MemoryTelemetryData {
  return { ...telemetry };
}

/**
 * Format telemetry as a human-readable string
 */
export function formatTelemetryReport(): string {
  const lines = [
    '## Memory System Telemetry',
    '',
    '### Extraction',
    `- Total extractions: ${telemetry.extractionsTotal}`,
    `- Failed extractions: ${telemetry.extractionsFailed}`,
    `- Memories extracted: ${telemetry.memoriesExtracted}`,
    `- Average extraction time: ${telemetry.averageExtractionTimeMs.toFixed(0)}ms`,
    `- Last extraction: ${telemetry.lastExtractionAt ? new Date(telemetry.lastExtractionAt).toISOString() : 'Never'}`,
    '',
    '### LLM Extraction (hybrid)',
    `- LLM extraction calls: ${telemetry.llmExtractionCalls}`,
    `- Heuristic fallbacks: ${telemetry.heuristicFallbacks}`,
    `- Memories from LLM: ${telemetry.memoriesFromLlm}`,
    `- Redacted secrets: ${telemetry.redactedSecrets}`,
    `- Dedup skipped: ${telemetry.dedupSkipped}`,
    `- Estimated cost: $${telemetry.estimatedCostUsd.toFixed(4)}`,
    `- Circuit broken: ${telemetry.circuitBroken ? 'yes' : 'no'}`,
    '',
    '### Consolidation',
    `- Total consolidations: ${telemetry.consolidationsTotal}`,
    `- Failed consolidations: ${telemetry.consolidationsFailed}`,
    `- Memories processed: ${telemetry.memoriesProcessed}`,
    `- Average consolidation time: ${telemetry.averageConsolidationTimeMs.toFixed(0)}ms`,
    `- Last consolidation: ${telemetry.lastConsolidationAt ? new Date(telemetry.lastConsolidationAt).toISOString() : 'Never'}`,
    '',
    '### Memory Counts',
    `- User: ${telemetry.memoryCountUser}`,
    `- Feedback: ${telemetry.memoryCountFeedback}`,
    `- Project: ${telemetry.memoryCountProject}`,
    `- Reference: ${telemetry.memoryCountReference}`,
    `  Total: ${telemetry.memoryCountUser + telemetry.memoryCountFeedback + telemetry.memoryCountProject + telemetry.memoryCountReference}`,
    '',
    '### Sessions',
    `- Snapshots: ${telemetry.sessionSnapshotsTotal}`,
    `- Archived: ${telemetry.sessionsArchived}`,
    `- Pruned: ${telemetry.sessionsPruned}`,
  ];

  return lines.join('\n');
}

/**
 * Reset telemetry data
 */
export function resetTelemetry(): void {
  telemetry = {
    extractionsTotal: 0,
    extractionsFailed: 0,
    memoriesExtracted: 0,
    lastExtractionAt: 0,

    llmExtractionCalls: 0,
    heuristicFallbacks: 0,
    memoriesFromLlm: 0,
    redactedSecrets: 0,
    dedupSkipped: 0,
    estimatedCostUsd: 0,
    circuitBroken: false,

    consolidationsTotal: 0,
    consolidationsFailed: 0,
    memoriesProcessed: 0,
    lastConsolidationAt: 0,

    memoryCountUser: 0,
    memoryCountFeedback: 0,
    memoryCountProject: 0,
    memoryCountReference: 0,

    sessionSnapshotsTotal: 0,
    sessionsArchived: 0,
    sessionsPruned: 0,

    averageExtractionTimeMs: 0,
    averageConsolidationTimeMs: 0,
  };

  totalExtractionTimeMs = 0;
  totalConsolidationTimeMs = 0;
}
