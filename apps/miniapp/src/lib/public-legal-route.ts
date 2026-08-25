import { PUBLIC_ROUTER_BASENAME } from './public-config';

export type MiniappRouterMode = 'browser' | 'hash';

function parsePathname(route: string): string | null {
  try {
    return new URL(route, 'https://miniapp.local').pathname;
  } catch {
    return null;
  }
}

function resolveBrowserPathnameFromWindow(): string {
  const pathname = window.location.pathname || '/';
  if (
    PUBLIC_ROUTER_BASENAME &&
    (pathname === PUBLIC_ROUTER_BASENAME || pathname.startsWith(`${PUBLIC_ROUTER_BASENAME}/`))
  ) {
    const stripped = pathname.slice(PUBLIC_ROUTER_BASENAME.length);
    return stripped || '/';
  }

  return pathname;
}

export function resolveRouterPathnameFromWindow(routerMode: MiniappRouterMode): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  if (routerMode === 'hash') {
    const hashRoute = window.location.hash.replace(/^#/u, '');
    if (hashRoute) {
      return parsePathname(hashRoute) || '/';
    }
  }

  return resolveBrowserPathnameFromWindow();
}

export function isPublicLegalPathnameFromWindow(routerMode: MiniappRouterMode): boolean {
  return /^\/legal\/(?:agreement|privacy)\/?$/u.test(resolveRouterPathnameFromWindow(routerMode));
}

export function isPublicBotPathnameFromWindow(routerMode: MiniappRouterMode): boolean {
  return /^\/publik\/?$/u.test(resolveRouterPathnameFromWindow(routerMode));
}
