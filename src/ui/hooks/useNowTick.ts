import { useEffect, useState } from 'react';

/**
 * Self-contained wall-clock tick. Returns a timestamp that advances once every
 * `intervalMs` while `active` is true, and freezes at its last value otherwise.
 *
 * Scoping the tick to the leaf component that displays live time — instead of a
 * single `now` state held high in the tree — keeps the per-second re-render off
 * the whole app: the chat transcript, the status bar and the session panel each
 * tick independently, so a running clock never forces a full-frame repaint (the
 * visible "refresh"/flicker users perceived while data was updating).
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Re-sync immediately when the tick turns on so elapsed values start from
    // the current instant instead of a stale mount-time timestamp.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}
