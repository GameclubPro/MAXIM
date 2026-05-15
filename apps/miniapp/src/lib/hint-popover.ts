import { useEffect } from 'react';

const HINT_MARGIN_PX = 12;

function getViewportMetrics(element?: HTMLElement) {
  if (typeof window === 'undefined') {
    return {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    };
  }

  const viewport = window.visualViewport;
  const viewportMetrics = viewport
    ? {
        left: viewport.offsetLeft,
        top: viewport.offsetTop,
        width: viewport.width,
        height: viewport.height,
      }
    : {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };

  const clippingBody = element?.closest<HTMLElement>('.settings-drilldown__body');
  if (!clippingBody) {
    return viewportMetrics;
  }

  const clippingRect = clippingBody.getBoundingClientRect();
  const left = Math.max(viewportMetrics.left, clippingRect.left);
  const top = Math.max(viewportMetrics.top, clippingRect.top);
  const right = Math.min(viewportMetrics.left + viewportMetrics.width, clippingRect.right);
  const bottom = Math.min(viewportMetrics.top + viewportMetrics.height, clippingRect.bottom);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function resetHintAnchor(anchor: HTMLElement) {
  anchor.style.removeProperty('--hint-popover-max-width');
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

  const viewport = getViewportMetrics(anchor);
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const maxPopoverWidth = Math.max(120, Math.floor(viewport.width - HINT_MARGIN_PX * 2));
  anchor.style.setProperty('--hint-popover-max-width', `${maxPopoverWidth}px`);

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

function updateOpenHints(scrollInlineHints: boolean | number = false) {
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
      return;
    }

    if (scrollInlineHints === true) {
      document.getElementById(button.getAttribute('aria-controls') ?? '')?.scrollIntoView({
        block: 'nearest',
      });
    }
  });
}

export function useHintPopoverAutoPosition(active: boolean, updateKey?: unknown) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      return;
    }

    let frameId = window.requestAnimationFrame(() => updateOpenHints(true));
    const handleUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateOpenHints);
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
  }, [active, updateKey]);
}
