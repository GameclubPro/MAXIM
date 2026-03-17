import { useEffect, useRef, useState } from 'react';

type UseAutoHideHeaderOptions = {
  compactAfter?: number;
  hideAfter?: number;
  revealAtTop?: number;
  delta?: number;
};

export function useAutoHideHeader({
  compactAfter = 10,
  hideAfter = 72,
  revealAtTop = 12,
  delta = 8,
}: UseAutoHideHeaderOptions = {}) {
  const [state, setState] = useState({
    isCompact: false,
    isHidden: false,
  });
  const lastYRef = useRef(0);
  const stateRef = useRef(state);

  useEffect(() => {
    let frameId = 0;

    const readScrollY = () =>
      Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);

    const applyScrollState = () => {
      frameId = 0;

      const scrollY = readScrollY();
      const previousY = lastYRef.current;
      const movedDown = scrollY > previousY + delta;
      const movedUp = scrollY < previousY - delta;
      const isCompact = scrollY > compactAfter;
      let isHidden = stateRef.current.isHidden;

      if (scrollY <= revealAtTop) {
        isHidden = false;
      } else if (movedDown && scrollY > hideAfter) {
        isHidden = true;
      } else if (movedUp) {
        isHidden = false;
      }

      lastYRef.current = scrollY;
      stateRef.current = {
        isCompact,
        isHidden,
      };

      setState((current) =>
        current.isCompact === isCompact && current.isHidden === isHidden
          ? current
          : { isCompact, isHidden },
      );
    };

    const handleScroll = () => {
      if (frameId !== 0) {
        return;
      }

      frameId = window.requestAnimationFrame(applyScrollState);
    };

    lastYRef.current = readScrollY();
    applyScrollState();

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.visualViewport?.addEventListener('scroll', handleScroll);

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener('scroll', handleScroll);
      window.visualViewport?.removeEventListener('scroll', handleScroll);
    };
  }, [compactAfter, delta, hideAfter, revealAtTop]);

  return state;
}
