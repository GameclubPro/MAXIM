import { useEffect, type RefObject } from 'react';

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

function getDialogFocusableElements(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null,
  );
}

export function resolveDialogTabWrapTarget(
  panel: HTMLElement,
  activeElement: Element | null,
  focusable: readonly HTMLElement[],
  reverse: boolean,
): HTMLElement | null {
  if (focusable.length === 0) {
    return panel;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusAtPanel = activeElement === panel;
  const focusOutside = !panel.contains(activeElement);

  if (reverse && (focusAtPanel || activeElement === first || focusOutside)) {
    return last ?? panel;
  }
  if (!reverse && (focusAtPanel || activeElement === last || focusOutside)) {
    return first ?? panel;
  }
  return null;
}

export function isTopmostModalDialog(panel: HTMLElement): boolean {
  const modalDialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
  ).filter(
    (dialog) => !dialog.hasAttribute('hidden') && dialog.getAttribute('aria-hidden') !== 'true',
  );

  return modalDialogs[modalDialogs.length - 1] === panel;
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
      const initialFocus = initialFocusRef.current;
      const focusTarget = initialFocus?.matches(':disabled') ? panelRef.current : initialFocus;
      (focusTarget ?? panelRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (!panel || !isTopmostModalDialog(panel)) {
        return;
      }
      const focusable = getDialogFocusableElements(panel);
      const focusTarget = resolveDialogTabWrapTarget(
        panel,
        document.activeElement,
        focusable,
        event.shiftKey,
      );
      if (focusTarget) {
        event.preventDefault();
        focusTarget.focus();
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
