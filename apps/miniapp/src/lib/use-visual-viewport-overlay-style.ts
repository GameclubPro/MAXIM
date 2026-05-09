import { useEffect, useState, type CSSProperties } from 'react';

function isDesignPreview() {
  return document.documentElement.dataset.maxClient === 'preview';
}

function resolveVisualViewportOverlayStyle(): CSSProperties {
  const viewport = window.visualViewport;
  const top = Math.round(viewport?.offsetTop ?? 0);
  const left = Math.round(viewport?.offsetLeft ?? 0);
  const width = Math.round(viewport?.width ?? window.innerWidth);
  const height = Math.round(viewport?.height ?? window.innerHeight);

  return {
    top,
    left,
    width,
    height,
    maxHeight: height,
  };
}

export function useVisualViewportOverlayStyle(open: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>();

  useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof document === 'undefined') {
      setStyle(undefined);
      return undefined;
    }

    if (isDesignPreview()) {
      setStyle(undefined);
      return undefined;
    }

    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setStyle(resolveVisualViewportOverlayStyle());
      });
    };

    update();

    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      window.cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [open]);

  return style;
}
