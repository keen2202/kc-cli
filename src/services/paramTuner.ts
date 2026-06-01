// Parameter Auto-Tuning Service - adaptive configuration based on session metrics

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const TUNED_PARAMS_FILE = '.kc-cli/tuned-params.json';
const DEFAULT_OBSERVATION_THRESHOLD = 10;
const MAX_ADJUSTMENT_RATIO = 0.2; // Never adjust more than 20% per tuning

export interface TunedParameters {
  toolTimeouts: Record<string, number>;      // Per-tool timeout in ms
  maxRetries: Record<string, number>;        // Per-service max retries
  compactionThreshold: number;               // Token threshold for compaction
  extractionThrottle: number;                // Turns between extractions
  lastTuned: number;                         // Last tuning timestamp
  observationCount: number;                  // Total observations since last tune
}

export interface OutcomeRecord {
  parameter: string;
  toolName?: string;
  success: boolean;
  value: number;
  timestamp: number;
}

const DEFAULT_PARAMETERS: TunedParameters = {
  toolTimeouts: {},
  maxRetries: {},
  compactionThreshold: 180_000,
  extractionThrottle: 3,
  lastTuned: 0,
  observationCount: 0,
};

/**
 * Parameter auto-tuning service
 */
export class ParameterTuningService {
  private parameters: TunedParameters;
  private observations: OutcomeRecord[] = [];
  private settingsPath: string;
  private observationThreshold: number;

  constructor(options: { settingsPath?: string; observationThreshold?: number } = {}) {
    this.settingsPath = options.settingsPath || path.join(os.homedir(), TUNED_PARAMS_FILE);
    this.observationThreshold = options.observationThreshold || DEFAULT_OBSERVATION_THRESHOLD;
    this.parameters = { ...DEFAULT_PARAMETERS };
  }

  /**
   * Record an outcome for parameter tuning
   */
  recordOutcome(outcome: OutcomeRecord): void {
    this.observations.push(outcome);
    this.parameters.observationCount++;
  }

  /**
   * Get tuned value for a parameter
   */
  getTunedValue(parameter: string, toolName?: string, defaultValue?: number): number | undefined {
    if (parameter === 'toolTimeout' && toolName) {
      return this.parameters.toolTimeouts[toolName] ?? defaultValue;
    }
    if (parameter === 'maxRetries' && toolName) {
      return this.parameters.maxRetries[toolName] ?? defaultValue;
    }
    if (parameter === 'compactionThreshold') {
      return this.parameters.compactionThreshold;
    }
    if (parameter === 'extractionThrottle') {
      return this.parameters.extractionThrottle;
    }
    return defaultValue;
  }

  /**
   * Check if enough observations to tune
   */
  shouldTune(): boolean {
    return this.parameters.observationCount >= this.observationThreshold;
  }

  /**
   * Perform tuning based on observations
   */
  tune(): void {
    if (!this.shouldTune()) {
      return;
    }

    // Tune tool timeouts based on p95 execution times
    this.tuneToolTimeouts();

    // Tune max retries based on recovery rates
    this.tuneMaxRetries();

    // Tune compaction threshold based on conversation patterns
    this.tuneCompactionThreshold();

    // Tune extraction throttle based on yield
    this.tuneExtractionThrottle();

    // Reset observation count
    this.parameters.observationCount = 0;
    this.parameters.lastTuned = Date.now();
    this.observations = [];
  }

  /**
   * Tune tool timeouts based on historical execution times
   */
  private tuneToolTimeouts(): void {
    const toolObservations = new Map<string, number[]>();

    for (const obs of this.observations) {
      if (obs.parameter === 'toolTimeout' && obs.toolName) {
        if (!toolObservations.has(obs.toolName)) {
          toolObservations.set(obs.toolName, []);
        }
        toolObservations.get(obs.toolName)!.push(obs.value);
      }
    }

    for (const [toolName, values] of toolObservations) {
      if (values.length < 3) continue; // Need at least 3 observations

      // Calculate p95
      values.sort((a, b) => a - b);
      const p95Index = Math.floor(values.length * 0.95);
      const p95 = values[p95Index];

      // Add 20% buffer
      const newTimeout = Math.ceil(p95 * 1.2);

      // Apply conservative adjustment (max 20% change)
      const currentTimeout = this.parameters.toolTimeouts[toolName] || newTimeout;
      const maxChange = currentTimeout * MAX_ADJUSTMENT_RATIO;

      if (newTimeout > currentTimeout) {
        this.parameters.toolTimeouts[toolName] = Math.min(newTimeout, currentTimeout + maxChange);
      } else {
        this.parameters.toolTimeouts[toolName] = Math.max(newTimeout, currentTimeout - maxChange);
      }
    }
  }

  /**
   * Tune max retries based on recovery rates
   */
  private tuneMaxRetries(): void {
    const serviceObservations = new Map<string, { success: number; total: number }>();

    for (const obs of this.observations) {
      if (obs.parameter === 'maxRetries' && obs.toolName) {
        if (!serviceObservations.has(obs.toolName)) {
          serviceObservations.set(obs.toolName, { success: 0, total: 0 });
        }
        const stats = serviceObservations.get(obs.toolName)!;
        stats.total++;
        if (obs.success) stats.success++;
      }
    }

    for (const [service, stats] of serviceObservations) {
      if (stats.total < 3) continue;

      const recoveryRate = stats.success / stats.total;
      const currentRetries = this.parameters.maxRetries[service] || 3;

      // High recovery rate (>80%) → can reduce retries
      // Low recovery rate (<50%) → increase retries
      if (recoveryRate > 0.8 && currentRetries > 1) {
        this.parameters.maxRetries[service] = Math.max(1, currentRetries - 1);
      } else if (recoveryRate < 0.5 && currentRetries < 10) {
        this.parameters.maxRetries[service] = Math.min(10, currentRetries + 1);
      }
    }
  }

  /**
   * Tune compaction threshold based on conversation patterns
   */
  private tuneCompactionThreshold(): void {
    // Single-pass: count and sum in one reduce instead of filter + reduce
    let count = 0;
    let sum = 0;
    for (const o of this.observations) {
      if (o.parameter === 'compactionThreshold') {
        count++;
        sum += o.value;
      }
    }
    if (count < 3) return;

    const avgEffectiveness = sum / count;

    // If compaction is very effective (saving lots of tokens), lower threshold to compact earlier
    // If compaction is not very effective, raise threshold to compact less often
    const currentThreshold = this.parameters.compactionThreshold;
    if (avgEffectiveness > 0.7) {
      this.parameters.compactionThreshold = Math.max(100_000, currentThreshold * (1 - MAX_ADJUSTMENT_RATIO));
    } else if (avgEffectiveness < 0.3) {
      this.parameters.compactionThreshold = Math.min(250_000, currentThreshold * (1 + MAX_ADJUSTMENT_RATIO));
    }
  }

  /**
   * Tune extraction throttle based on extraction yield
   */
  private tuneExtractionThrottle(): void {
    // Single-pass: count and sum in one reduce instead of filter + reduce
    let count = 0;
    let sum = 0;
    for (const o of this.observations) {
      if (o.parameter === 'extractionThrottle') {
        count++;
        sum += o.value;
      }
    }
    if (count < 3) return;

    const avgYield = sum / count;

    // If yield is high (>2 memories per extraction), can increase throttle
    // If yield is low (<0.5 memories per extraction), decrease throttle
    const currentThrottle = this.parameters.extractionThrottle;
    if (avgYield > 2 && currentThrottle < 10) {
      this.parameters.extractionThrottle = Math.min(10, currentThrottle + 1);
    } else if (avgYield < 0.5 && currentThrottle > 1) {
      this.parameters.extractionThrottle = Math.max(1, currentThrottle - 1);
    }
  }

  /**
   * Get current parameters
   */
  getParameters(): TunedParameters {
    return { ...this.parameters };
  }

  /**
   * Get observation count
   */
  getObservationCount(): number {
    return this.parameters.observationCount;
  }

  /**
   * Persist tuned parameters to disk
   */
  async persist(): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.parameters, null, 2), 'utf-8');
  }

  /**
   * Load tuned parameters from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      const loaded = JSON.parse(content);
      this.parameters = {
        ...DEFAULT_PARAMETERS,
        ...loaded,
      };
    } catch {
      // File doesn't exist or is invalid, use defaults
    }
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.parameters = { ...DEFAULT_PARAMETERS };
    this.observations = [];
  }
}
