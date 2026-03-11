import { useEffect } from 'react';

const HINT_MARGIN_PX = 12;

function getViewportMetrics() {
  if (typeof window === 'undefined') {
    return {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    };
  }

  const viewport = window.visualViewport;
  if (!viewport) {
    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  return {
    left: viewport.offsetLeft,
    top: viewport.offsetTop,
    width: viewport.width,
    height: viewport.height,
  };
}

function resetHintAnchor(anchor: HTMLElement) {
  anchor.style.removeProperty('--hint-popover-shift-x');
  anchor.style.removeProperty('--hint-popover-shift-y');
  delete anchor.dataset.hintPlacement;
}

function repositionHintAnchor(anchor: HTMLElement) {
  const popover = anchor.querySelector<HTMLElement>('.channel-settings-hint-popover');
  if (!popover) {
    resetHintAnchor(anchor);
    return;
  }

  resetHintAnchor(anchor);

  const viewport = getViewportMetrics();
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;

  let rect = popover.getBoundingClientRect();
  let shiftX = 0;

  if (rect.right > viewportRight - HINT_MARGIN_PX) {
    shiftX -= rect.right - (viewportRight - HINT_MARGIN_PX);
  }
  if (rect.left + shiftX < viewport.left + HINT_MARGIN_PX) {
    shiftX += viewport.left + HINT_MARGIN_PX - (rect.left + shiftX);
  }

  if (shiftX !== 0) {
    anchor.style.setProperty('--hint-popover-shift-x', `${Math.round(shiftX)}px`);
    rect = popover.getBoundingClientRect();
  }

  if (rect.bottom > viewportBottom - HINT_MARGIN_PX) {
    anchor.dataset.hintPlacement = 'top';
    rect = popover.getBoundingClientRect();
  }

  let shiftY = 0;
  if (rect.top < viewport.top + HINT_MARGIN_PX) {
    shiftY += viewport.top + HINT_MARGIN_PX - rect.top;
  }
  if (rect.bottom + shiftY > viewportBottom - HINT_MARGIN_PX) {
    shiftY -= rect.bottom + shiftY - (viewportBottom - HINT_MARGIN_PX);
  }

  if (shiftY !== 0) {
    anchor.style.setProperty('--hint-popover-shift-y', `${Math.round(shiftY)}px`);
  }
}

function repositionOpenHintPopovers() {
  if (typeof document === 'undefined') {
    return;
  }

  document.querySelectorAll<HTMLElement>('.channel-settings-hint-anchor').forEach(resetHintAnchor);

  const openButtons = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.settings-info-button.is-open, .settings-info-button[aria-expanded="true"]',
    ),
  );

  openButtons.forEach((button) => {
    const anchor = button.closest<HTMLElement>('.channel-settings-hint-anchor');
    if (anchor) {
      repositionHintAnchor(anchor);
    }
  });
}

export function useHintPopoverAutoPosition(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      return;
    }

    let frameId = window.requestAnimationFrame(repositionOpenHintPopovers);
    const handleUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(repositionOpenHintPopovers);
    };

    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    window.visualViewport?.addEventListener('resize', handleUpdate);
    window.visualViewport?.addEventListener('scroll', handleUpdate);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
      window.visualViewport?.removeEventListener('resize', handleUpdate);
      window.visualViewport?.removeEventListener('scroll', handleUpdate);
      document
        .querySelectorAll<HTMLElement>('.channel-settings-hint-anchor')
        .forEach(resetHintAnchor);
    };
  }, [active]);
}
