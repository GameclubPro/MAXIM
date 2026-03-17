import { useEffect, useRef, useState } from 'react';

type UseAutoHideHeaderOptions = {
  compactAfter?: number;
  hideAfter?: number;
  revealAtTop?: number;
  settleDelta?: number;
  hideDistance?: number;
  revealDistance?: number;
};

export function useAutoHideHeader({
  compactAfter = 10,
  hideAfter = 72,
  revealAtTop = 12,
  settleDelta = 1.5,
  hideDistance = 44,
  revealDistance = 6,
}: UseAutoHideHeaderOptions = {}) {
  const [state, setState] = useState({
    isCompact: false,
    isHidden: false,
  });
  const lastYRef = useRef(0);
  const stateRef = useRef(state);
  const directionRef = useRef<'up' | 'down' | 'idle'>('idle');
  const pivotYRef = useRef(0);

  useEffect(() => {
    let frameId = 0;

    const readScrollY = () =>
      Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);

    const applyScrollState = () => {
      frameId = 0;

      const scrollY = readScrollY();
      const previousY = lastYRef.current;
      const diff = scrollY - previousY;
      const isCompact = scrollY > compactAfter;
      let isHidden = stateRef.current.isHidden;

      if (scrollY <= revealAtTop) {
        isHidden = false;
        directionRef.current = 'idle';
        pivotYRef.current = scrollY;
      } else if (Math.abs(diff) >= settleDelta) {
        const nextDirection: 'up' | 'down' = diff > 0 ? 'down' : 'up';

        if (directionRef.current !== nextDirection) {
          directionRef.current = nextDirection;
          pivotYRef.current = previousY;
        }

        const traveled = Math.abs(scrollY - pivotYRef.current);

        if (nextDirection === 'down' && scrollY > hideAfter && traveled >= hideDistance) {
          isHidden = true;
          pivotYRef.current = scrollY;
        }

        if (nextDirection === 'up' && traveled >= revealDistance) {
          isHidden = false;
          pivotYRef.current = scrollY;
        }
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
    pivotYRef.current = lastYRef.current;
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
  }, [compactAfter, hideAfter, hideDistance, revealAtTop, revealDistance, settleDelta]);

  return state;
}
