// Consolidation scheduler - smart scheduling for memory consolidation

import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectMemoryPath, getConsolidateLockPath } from '../memory/paths';

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
  // In the full implementation, this would:
  // 1. Scan session directory for sessions touched since last consolidation
  // 2. Count unique sessions (excluding current session)
  // 3. Return true if count >= minSessions

  // For now, return true to allow consolidation
  // This can be enhanced with actual session counting
  return true;
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
