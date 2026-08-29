import { useEffect, useState } from 'react';
import {
  rebaseKeyboardViewportState,
  resolveKeyboardViewportState,
} from './keyboard-viewport-state';

const KEYBOARD_WIDTH_CHANGE_THRESHOLD = 48;
const VIEWPORT_REBASE_DELAY_MS = 160;

export function useKeyboardOpen(keyboardThreshold = 120, enabled = true): boolean {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsKeyboardOpen(false);
      return undefined;
    }

    const viewport = window.visualViewport;
    let keyboardState = {
      baselineHeight: viewport?.height ?? window.innerHeight,
      baselineWidth: window.innerWidth,
      keyboardOpen: false,
    };
    let focusOutFrame = 0;
    let rebaseFrame = 0;
    let rebaseTimer = 0;
    let orientationChangePending = false;

    const hasEditableFocus = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      );
    };

    const cancelDeferredFocusOut = () => {
      window.cancelAnimationFrame(focusOutFrame);
      focusOutFrame = 0;
    };

    const cancelViewportRebase = () => {
      window.clearTimeout(rebaseTimer);
      window.cancelAnimationFrame(rebaseFrame);
      rebaseTimer = 0;
      rebaseFrame = 0;
    };

    const applyKeyboardState = (preserveOnBlur = false) => {
      const currentHeight = viewport?.height ?? window.innerHeight;
      const editableFocused = hasEditableFocus();
      keyboardState = resolveKeyboardViewportState({
        ...keyboardState,
        currentHeight,
        innerHeight: window.innerHeight,
        visualOffsetTop: viewport?.offsetTop ?? 0,
        editableFocused,
        keyboardThreshold,
        preserveOnBlur,
      });
      setIsKeyboardOpen(keyboardState.keyboardOpen);
    };

    const scheduleViewportRebase = () => {
      cancelViewportRebase();
      rebaseTimer = window.setTimeout(() => {
        rebaseFrame = window.requestAnimationFrame(() => {
          const preserveOpen = orientationChangePending;
          keyboardState = rebaseKeyboardViewportState({
            ...keyboardState,
            currentHeight: viewport?.height ?? window.innerHeight,
            currentWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            visualOffsetTop: viewport?.offsetTop ?? 0,
            editableFocused: hasEditableFocus(),
            keyboardThreshold,
            preserveOpen,
          });
          orientationChangePending = false;
          rebaseTimer = 0;
          rebaseFrame = 0;
          setIsKeyboardOpen(keyboardState.keyboardOpen);
        });
      }, VIEWPORT_REBASE_DELAY_MS);
    };

    const updateKeyboardState = () => {
      if (
        Math.abs(window.innerWidth - keyboardState.baselineWidth) >= KEYBOARD_WIDTH_CHANGE_THRESHOLD
      ) {
        scheduleViewportRebase();
        return;
      }
      applyKeyboardState();
    };

    const handleFocusIn = () => {
      cancelDeferredFocusOut();
      updateKeyboardState();
    };

    const handleFocusOut = () => {
      cancelDeferredFocusOut();
      focusOutFrame = window.requestAnimationFrame(() => {
        focusOutFrame = 0;
        applyKeyboardState(true);
      });
    };

    const handleOrientationChange = () => {
      orientationChangePending = true;
      scheduleViewportRebase();
    };

    applyKeyboardState();

    viewport?.addEventListener('resize', updateKeyboardState);
    window.addEventListener('resize', updateKeyboardState);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    return () => {
      cancelDeferredFocusOut();
      cancelViewportRebase();
      viewport?.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, [enabled, keyboardThreshold]);

  return isKeyboardOpen;
}
