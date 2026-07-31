// Consolidation scheduler - smart scheduling for memory consolidation

import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectMemoryPath, getConsolidateLockPath, getSessionBasePath } from './paths';

interface ConsolidationSchedulerState {
  lastScanAt: number;
  scheduledConsolidations: Map<string, boolean>; // projectHash -> scheduled
}

const state: ConsolidationSchedulerState = {
  lastScanAt: 0,
  scheduledConsolidations: new Map(),
};

/**
 * Check if consolidation should run based on all gates
 */
export async function shouldConsolidate(
  projectHash: string,
  options: {
    minHours?: number;
    minSessions?: number;
    scanThrottleMinutes?: number;
  } = {}
): Promise<boolean> {
  const {
    minHours = 24,
    minSessions = 5,
    scanThrottleMinutes = 10,
  } = options;

  // Gate 1: Time gate - minimum hours since last consolidation
  const timeGatePassed = await checkTimeGate(projectHash, minHours);
  if (!timeGatePassed) {
    return false;
  }

  // Gate 2: Scan throttle - prevent repeated scans
  const scanThrottlePassed = checkScanThrottle(scanThrottleMinutes);
  if (!scanThrottlePassed) {
    return false;
  }

  // Gate 3: Session gate - minimum new sessions since last consolidation
  const sessionGatePassed = await checkSessionGate(projectHash, minSessions);
  if (!sessionGatePassed) {
    return false;
  }

  return true;
}

/**
 * Gate 1: Check if enough time has passed since last consolidation
 */
async function checkTimeGate(projectHash: string, minHours: number): Promise<boolean> {
  const lockPath = getConsolidateLockPath(projectHash);

  try {
    const stat = await fs.stat(lockPath);
    const hoursSinceLock = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    return hoursSinceLock >= minHours;
  } catch {
    // Lock doesn't exist, never consolidated before
    return true;
  }
}

/**
 * Gate 2: Check scan throttle
 */
function checkScanThrottle(minMinutes: number): boolean {
  const minutesSinceScan = (Date.now() - state.lastScanAt) / (1000 * 60);

  if (minutesSinceScan < minMinutes) {
    return false;
  }

  state.lastScanAt = Date.now();
  return true;
}

/**
 * Gate 3: Check if enough new sessions exist since last consolidation
 */
async function checkSessionGate(projectHash: string, minSessions: number): Promise<boolean> {
  const lockPath = getConsolidateLockPath(projectHash);

  // Determine the timestamp to check against
  let sinceTimestamp: number;
  try {
    const stat = await fs.stat(lockPath);
    sinceTimestamp = stat.mtimeMs;
  } catch {
    // No lock file = never consolidated, count all sessions
    sinceTimestamp = 0;
  }

  // Scan session directory for sessions modified since last consolidation
  const sessionDir = getSessionBasePath();
  try {
    const files = await fs.readdir(sessionDir);
    let count = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(sessionDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > sinceTimestamp) {
          count++;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return count >= minSessions;
  } catch {
    // Session directory doesn't exist or can't be read
    return false;
  }
}

/**
 * Schedule a consolidation if conditions are met
 */
export async function scheduleConsolidation(
  projectHash: string,
  options: {
    minHours?: number;
    minSessions?: number;
    scanThrottleMinutes?: number;
  } = {}
): Promise<boolean> {
  // Already scheduled?
  if (state.scheduledConsolidations.has(projectHash)) {
    return false;
  }

  // Check gates
  const shouldRun = await shouldConsolidate(projectHash, options);
  if (!shouldRun) {
    return false;
  }

  // Schedule
  state.scheduledConsolidations.set(projectHash, true);
  return true;
}

/**
 * Cancel a scheduled consolidation
 */
export function cancelConsolidation(projectHash: string): void {
  state.scheduledConsolidations.delete(projectHash);
}

/**
 * Mark consolidation as complete (called after execution)
 */
export function markConsolidationComplete(projectHash: string): void {
  state.scheduledConsolidations.delete(projectHash);
}

/**
 * Get consolidation status for a project
 */
export function getConsolidationStatus(projectHash: string): {
  scheduled: boolean;
  lastScanAt: number;
} {
  return {
    scheduled: state.scheduledConsolidations.has(projectHash),
    lastScanAt: state.lastScanAt,
  };
}

/**
 * Reset scheduler state
 */
export function resetScheduler(): void {
  state.lastScanAt = 0;
  state.scheduledConsolidations.clear();
}
