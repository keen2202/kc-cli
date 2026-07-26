/**
 * useFocusLayer — React binding for the FocusStack input arbiter.
 *
 * Mounting the hook pushes the layer; unmounting unregisters it, which fires
 * `onDispose` (the fix lives in the architecture: even if a host component
 * file is deleted or conditionally unmounted, the layer's exit semantics are
 * guaranteed by the stack — F2-class regressions are structurally impossible).
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.1.1 (T1).
 */

import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { FocusStack, type FocusLayer } from '../focus-stack';

const FocusStackContext = createContext<FocusStack | null>(null);

/** Provide the app-wide FocusStack (created once in AppRoot). */
export const FocusStackProvider = FocusStackContext.Provider;

/** Access the app-wide FocusStack; throws outside a provider. */
export function useFocusStack(): FocusStack {
  const stack = useContext(FocusStackContext);
  if (!stack) throw new Error('useFocusStack must be used within a FocusStackProvider');
  return stack;
}

/**
 * Register `layer` on the FocusStack for the lifetime of the component.
 *
 * The pushed layer is a stable proxy that always delegates to the latest
 * callbacks (via ref), so re-renders never re-push (stack order is stable)
 * and handlers never go stale. Registration uses useLayoutEffect: it flushes
 * synchronously within the same commit as the state change that mounted the
 * component, so `focusStack.top()` is already correct before the next
 * keypress can possibly arrive.
 */
export function useFocusLayer(layer: FocusLayer): void {
  const stack = useFocusStack();
  const layerRef = useRef(layer);
  layerRef.current = layer;

  useLayoutEffect(() => {
    const proxy: FocusLayer = {
      id: layerRef.current.id,
      onKey: (event) => layerRef.current.onKey(event),
      onEscape: () => layerRef.current.onEscape(),
      onDispose: () => layerRef.current.onDispose?.(),
    };
    return stack.push(proxy);
  }, [stack, layer.id]);
}

/**
 * Render-null helper for registering a focus layer from conditional JSX
 * (`{cond && <FocusLayerMount layer={...} />}`): mounting pushes the layer,
 * unmounting unregisters it. Sibling JSX order defines stack order for
 * layers mounted in the same commit (earlier sibling = lower layer).
 */
export function FocusLayerMount({ layer }: { layer: FocusLayer }): null {
  useFocusLayer(layer);
  return null;
}
