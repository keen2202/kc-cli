import { useCallback } from 'react';
import type { KeybindingManager } from '../keybinding-manager';

/**
 * Hook that provides a function to resolve key events via the KeybindingManager.
 * Returns the command string or null if no binding matches.
 */
export function useKeybindingResolver(keybindingManager: KeybindingManager) {
  return useCallback(
    (event: { name: string; ctrl: boolean; meta: boolean; shift: boolean }) => {
      return keybindingManager.resolve(event as any);
    },
    [keybindingManager],
  );
}
