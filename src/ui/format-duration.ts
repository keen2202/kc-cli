/**
 * Shared duration formatter for the interactive UI.
 *
 * Single source of truth so SessionInfo and the status bar render session
 * time identically. Formats a millisecond duration as a compact clock:
 *   - < 1 hour  → `m:ss`      (e.g. `3:07`)
 *   - >= 1 hour → `h:mm:ss`   (e.g. `1:02:09`)
 *
 * Non-finite or negative inputs (clock skew, missing start time) clamp to 0
 * so the UI never shows `NaN:NaN` or a negative timer.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/**
 * Compact seconds-based duration for the status bar: `12s` / `2m05s`.
 * Second, explicit contract so ms/sec callers can never be confused (M4).
 */
export function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * Token-count formatter — single shared implementation
 * (`999` / `12.3k` / `1.2M`). SessionInfo's local copy previously lacked
 * the `M` tier, so token totals above one million rendered unabbreviated.
 */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
