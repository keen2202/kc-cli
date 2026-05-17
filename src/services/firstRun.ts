// First-Run Experience - guided tour and auto-configuration for new users

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const FIRST_RUN_MARKER = '.kc-cli/.first-run-complete';

export interface TourStep {
  message: string;
  action?: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    message: "Welcome to KC-CLI! I'm your AI coding assistant.",
  },
  {
    message: "I can read files, run commands, search code, and more.",
  },
  {
    message: "Try asking me to 'list files in this directory' to get started.",
    action: "Type a command or question",
  },
  {
    message: "Type /help anytime to see available commands.",
    action: "Try /help",
  },
  {
    message: "Use /level to adjust assistance level (beginner/intermediate/advanced).",
    action: "Try /level beginner",
  },
];

/**
 * Check if this is the first run
 */
export async function isFirstRun(): Promise<boolean> {
  const markerPath = path.join(os.homedir(), FIRST_RUN_MARKER);
  try {
    await fs.access(markerPath);
    return false; // Marker exists, not first run
  } catch {
    return true; // Marker doesn't exist, first run
  }
}

/**
 * Get tour steps
 */
export function getTourSteps(): TourStep[] {
  return [...TOUR_STEPS];
}

/**
 * Run the guided tour
 * Returns an async generator that yields tour steps
 */
export async function* runTour(): AsyncGenerator<TourStep> {
  for (const step of TOUR_STEPS) {
    yield step;
  }
}

/**
 * Complete the tour and create marker file
 */
export async function completeTour(): Promise<void> {
  const markerPath = path.join(os.homedir(), FIRST_RUN_MARKER);
  const dir = path.dirname(markerPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    completedAt: Date.now(),
    version: '1.0.0',
  }, null, 2), 'utf-8');
}

/**
 * Skip the tour and create marker file
 */
export async function skipTour(): Promise<void> {
  await completeTour(); // Same as completing, just without running steps
}

/**
 * Get the marker file path
 */
export function getMarkerPath(): string {
  return path.join(os.homedir(), FIRST_RUN_MARKER);
}

/**
 * Reset first-run state (for testing)
 */
export async function resetFirstRun(): Promise<void> {
  const markerPath = path.join(os.homedir(), FIRST_RUN_MARKER);
  try {
    await fs.unlink(markerPath);
  } catch {
    // File doesn't exist, ignore
  }
}
