import { createContext, useContext } from 'react';
import type { NavigateOptions, To } from 'react-router';

type ManagedEntityPopStateHandler = (event: PopStateEvent) => void;
type ManagedEntityPopStateRegistry = {
  activeHandler: ManagedEntityPopStateHandler | null;
};
type WindowWithManagedEntityPopStateRegistry = Window & {
  __maximManagedEntityPopStateRegistry?: ManagedEntityPopStateRegistry;
};

let popStateRegistry: ManagedEntityPopStateRegistry | null = null;
if (typeof window !== 'undefined') {
  const targetWindow = window as WindowWithManagedEntityPopStateRegistry;
  popStateRegistry = targetWindow.__maximManagedEntityPopStateRegistry ?? {
    activeHandler: null,
  };
  if (!targetWindow.__maximManagedEntityPopStateRegistry) {
    targetWindow.__maximManagedEntityPopStateRegistry = popStateRegistry;
    window.addEventListener('popstate', (event) => popStateRegistry?.activeHandler?.(event));
  }
}

export type ManagedEntityLeaveGuard = {
  dirty: boolean;
  saving?: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
};

export type ManagedEntityGuardGetter = () => ManagedEntityLeaveGuard;

export type ManagedEntityNavigationContextValue = {
  requestNavigation: (to: To, options?: NavigateOptions) => boolean;
  requestBack: (fallbackTo: To) => void;
  registerLeaveGuard: (getGuard: ManagedEntityGuardGetter) => () => void;
  notifyLeaveGuardChanged: () => void;
};

export const ManagedEntityNavigationContext =
  createContext<ManagedEntityNavigationContextValue | null>(null);

export function registerManagedEntityPopStateHandler(
  handler: ManagedEntityPopStateHandler,
): () => void {
  if (!popStateRegistry) {
    return () => undefined;
  }

  popStateRegistry.activeHandler = handler;
  return () => {
    if (popStateRegistry?.activeHandler === handler) {
      popStateRegistry.activeHandler = null;
    }
  };
}

export function useManagedEntityNavigation(): Omit<
  ManagedEntityNavigationContextValue,
  'registerLeaveGuard' | 'notifyLeaveGuardChanged'
> {
  const context = useContext(ManagedEntityNavigationContext);
  if (!context) {
    throw new Error('useManagedEntityNavigation must be used inside ManagedEntityNavigationProvider');
  }

  return context;
}

export function useOptionalManagedEntityNavigation(): Omit<
  ManagedEntityNavigationContextValue,
  'registerLeaveGuard' | 'notifyLeaveGuardChanged'
> | null {
  return useContext(ManagedEntityNavigationContext);
}
