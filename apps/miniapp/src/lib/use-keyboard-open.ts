import { useEffect, useState } from 'react';

export function useKeyboardOpen(keyboardThreshold = 120, enabled = true): boolean {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsKeyboardOpen(false);
      return undefined;
    }

    const viewport = window.visualViewport;
    let baselineHeight = viewport?.height ?? window.innerHeight;

    const hasEditableFocus = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      );
    };

    const updateKeyboardState = () => {
      const currentHeight = viewport?.height ?? window.innerHeight;
      const nextIsOpen = hasEditableFocus() && baselineHeight - currentHeight > keyboardThreshold;

      if (!nextIsOpen) {
        baselineHeight = currentHeight;
      }

      setIsKeyboardOpen(nextIsOpen);
    };

    updateKeyboardState();

    viewport?.addEventListener('resize', updateKeyboardState);
    window.addEventListener('resize', updateKeyboardState);
    window.addEventListener('orientationchange', updateKeyboardState);
    window.addEventListener('focusin', updateKeyboardState);
    window.addEventListener('focusout', updateKeyboardState);

    return () => {
      viewport?.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('orientationchange', updateKeyboardState);
      window.removeEventListener('focusin', updateKeyboardState);
      window.removeEventListener('focusout', updateKeyboardState);
    };
  }, [enabled, keyboardThreshold]);

  return isKeyboardOpen;
}
