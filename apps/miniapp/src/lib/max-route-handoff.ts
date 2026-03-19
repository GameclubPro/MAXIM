type RouteNavigate = (target: string, options?: { replace?: boolean }) => void;

export function isMaxWebViewRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.MAX?.WebApp ?? window.WebApp);
}

function buildAppUrl(target: string): string {
  return `/app${target}`;
}

function forceRootRepaint(): () => void {
  const root = document.getElementById('root');
  if (!(root instanceof HTMLElement)) {
    return () => undefined;
  }

  const previous = {
    willChange: root.style.willChange,
    transform: root.style.transform,
    backfaceVisibility: root.style.backfaceVisibility,
    opacity: root.style.opacity,
  };

  root.style.willChange = 'transform, opacity';
  root.style.transform = 'translateZ(0)';
  root.style.backfaceVisibility = 'hidden';
  root.style.opacity = '0.999';

  void root.offsetHeight;

  return () => {
    root.style.willChange = previous.willChange;
    root.style.transform = previous.transform;
    root.style.backfaceVisibility = previous.backfaceVisibility;
    root.style.opacity = previous.opacity;
  };
}

export function navigateWithMaxRouteHandoff({
  target,
  currentRoute,
  navigate,
  replace = false,
}: {
  target: string;
  currentRoute: string;
  navigate: RouteNavigate;
  replace?: boolean;
}): void {
  const cleanup = forceRootRepaint();

  navigate(target, { replace });

  const repaintFrameId = window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
  });

  const fallbackId = window.setTimeout(() => {
    const nextRoute = `${window.location.pathname}${window.location.search}`;
    if (nextRoute !== currentRoute) {
      return;
    }

    const url = buildAppUrl(target);
    if (replace) {
      window.location.replace(url);
      return;
    }

    window.location.assign(url);
  }, 260);

  const settleId = window.setTimeout(() => {
    cleanup();
  }, 360);

  const finalize = () => {
    window.clearTimeout(fallbackId);
    window.clearTimeout(settleId);
    window.cancelAnimationFrame(repaintFrameId);
    cleanup();
  };

  window.setTimeout(finalize, 420);
}
