import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const MarketplaceActionsContext = createContext<{
  host: HTMLElement | null;
  setActive: (active: boolean) => void;
} | null>(null);

export function MarketplaceEditorActions({ children }: { children: ReactNode }) {
  const context = useContext(MarketplaceActionsContext);
  const setActive = context?.setActive;
  useLayoutEffect(() => {
    setActive?.(true);
    return () => setActive?.(false);
  }, [setActive]);
  const actions = <div className="marketplace-editor-actions">{children}</div>;
  if (!context) return actions;
  return context.host ? createPortal(actions, context.host) : null;
}
