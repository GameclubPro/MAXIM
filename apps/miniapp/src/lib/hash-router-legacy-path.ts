import { PUBLIC_ROUTER_BASENAME } from './public-config';

export function migrateHashRouterLegacyPathFromWindow(): void {
  if (
    typeof __MAXIM_ROUTER_MODE__ !== 'string' ||
    __MAXIM_ROUTER_MODE__ !== 'hash' ||
    typeof window === 'undefined' ||
    !PUBLIC_ROUTER_BASENAME
  ) {
    return;
  }

  const pathname = window.location.pathname || '/';
  if (pathname === PUBLIC_ROUTER_BASENAME || !pathname.startsWith(`${PUBLIC_ROUTER_BASENAME}/`)) {
    return;
  }

  const existingHashRoute = window.location.hash.replace(/^#/u, '');
  if (existingHashRoute.startsWith('/')) {
    return;
  }

  const routePathname = pathname.slice(PUBLIC_ROUTER_BASENAME.length) || '/';
  if (
    routePathname.startsWith('/assets/') ||
    routePathname === '/favicon.png' ||
    routePathname === '/apple-touch-icon.png' ||
    routePathname === '/site.webmanifest'
  ) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    `${PUBLIC_ROUTER_BASENAME}/#${routePathname}${window.location.search}`,
  );
}
