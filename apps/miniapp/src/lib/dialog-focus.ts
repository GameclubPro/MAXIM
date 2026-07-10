import { useEffect, type RefObject } from 'react';

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

function getDialogFocusableElements(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null,
  );
}

export function useDialogFocusTrap<T extends HTMLElement>(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<T | null>,
): void {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreScopeCandidate = previousFocus?.closest('[role="dialog"]');
    const restoreScope =
      restoreScopeCandidate instanceof HTMLElement ? restoreScopeCandidate : null;
    const focusFrame = window.requestAnimationFrame(() => {
      (initialFocusRef.current ?? panelRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = getDialogFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focusOutside = !panel.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusOutside)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusOutside)) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) {
        previousFocus.focus();
        return;
      }
      if (restoreScope?.isConnected) {
        (getDialogFocusableElements(restoreScope)[0] ?? restoreScope).focus();
      }
    };
  }, [initialFocusRef, open, panelRef]);
}
