// Idle detection service - detects when user is idle and triggers consolidation
// Optimization: Registers cleanup handler to prevent interval leaks on process exit.

let lastActivityTime: number = Date.now();
let idleDetectionInterval: NodeJS.Timeout | null = null;
let idleCallback: (() => void) | null = null;
let idleThresholdMs: number = 5 * 60 * 1000; // 5 minutes default
let isStopped = false;

// Register cleanup handler to prevent interval leaks
process.on('exit', () => {
  stopIdleDetection();
});

process.on('SIGINT', () => {
  stopIdleDetection();
});

process.on('SIGTERM', () => {
  stopIdleDetection();
});

/**
 * Start idle detection monitoring
 * Optimization: Prevents multiple intervals from being created and uses unref()
 * to avoid keeping the process alive.
 */
export function startIdleDetection(
  thresholdMinutes: number = 5,
  onIdle: () => void
): void {
  // If already running and not stopped, just update
  if (idleDetectionInterval && !isStopped) {
    idleThresholdMs = thresholdMinutes * 60 * 1000;
    idleCallback = onIdle;
    lastActivityTime = Date.now();
    return;
  }

  isStopped = false;
  idleThresholdMs = thresholdMinutes * 60 * 1000;
  idleCallback = onIdle;

  // Reset activity time
  lastActivityTime = Date.now();

  // Clear existing interval if any
  if (idleDetectionInterval) {
    clearInterval(idleDetectionInterval);
  }

  // Start polling
  idleDetectionInterval = setInterval(checkIdleState, 30000); // Check every 30 seconds

  // Unref the interval so it doesn't keep the process alive
  if (idleDetectionInterval && typeof idleDetectionInterval.unref === 'function') {
    idleDetectionInterval.unref();
  }
}

/**
 * Check if currently idle
 */
export function checkIdleState(): void {
  const now = Date.now();
  const timeSinceActivity = now - lastActivityTime;

  if (timeSinceActivity >= idleThresholdMs && idleCallback) {
    idleCallback();
  }
}

/**
 * Record user activity (call this on every user input)
 */
export function recordActivity(): void {
  lastActivityTime = Date.now();
}

/**
 * Get the timestamp of last activity
 */
export function getLastActivityTime(): number {
  return lastActivityTime;
}

/**
 * Check if currently idle (time since activity > threshold)
 */
export function isIdle(): boolean {
  return Date.now() - lastActivityTime >= idleThresholdMs;
}

/**
 * Get time since last activity in milliseconds
 */
export function getTimeSinceActivity(): number {
  return Date.now() - lastActivityTime;
}

/**
 * Stop idle detection
 */
export function stopIdleDetection(): void {
  if (idleDetectionInterval) {
    clearInterval(idleDetectionInterval);
    idleDetectionInterval = null;
  }
  idleCallback = null;
}

/**
 * Update the idle threshold
 */
export function setIdleThreshold(minutes: number): void {
  idleThresholdMs = minutes * 60 * 1000;
}
