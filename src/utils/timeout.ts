/**
 * Safe timeout conversion utilities.
 * Prevents NaN timeout bugs where `NaN * 1000 = NaN` and
 * `setTimeout(NaN)` / `http.request({ timeout: NaN })` never fires,
 * causing infinite hangs.
 */

/**
 * Convert seconds to milliseconds with NaN/infinity guard.
 * Returns `fallbackMs` if the input is not a finite positive number.
 */
export function secondsToMs(seconds: number, fallbackMs: number = 30_000): number {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return fallbackMs;
}

/**
 * Safely get a timeout in milliseconds from a value that may be
 * undefined, null, NaN, or non-finite. Falls back to `defaultSeconds * 1000`.
 */
export function safeTimeoutMs(
  value: number | undefined | null,
  defaultSeconds: number = 30
): number {
  return secondsToMs(value ?? defaultSeconds, defaultSeconds * 1000);
}
