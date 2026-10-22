import type {
  ManagedEntityGuardGetter,
  ManagedEntityLeaveGuard,
} from './managed-entity-navigation-context';
import type { To } from 'react-router';

export function managedEntityNavigationIdentity(pathname: string, search = ''): string {
  if (!/^\/networks\/(?:chat|channel)\/settings\/[^/]+\/?$/u.test(pathname)) return pathname;
  const query = new URLSearchParams(search);
  return `${pathname}?${new URLSearchParams({ scope: query.get('scope') ?? '', operation: query.get('operation') ?? '' })}`;
}

export function managedEntityNavigationTargetIdentity(
  to: To,
  currentPathname: string,
): string | null {
  if (typeof to !== 'string') {
    const pathname = to.pathname ?? currentPathname;
    return pathname.startsWith('/')
      ? managedEntityNavigationIdentity(pathname, to.search ?? '')
      : null;
  }
  const pathname = to.split(/[?#]/u, 1)[0] || currentPathname;
  if (!pathname.startsWith('/')) return null;
  const queryStart = to.indexOf('?');
  const search = queryStart < 0 ? '' : to.slice(queryStart).split('#', 1)[0];
  return managedEntityNavigationIdentity(pathname, search);
}

export function combineManagedEntityLeaveGuards(
  getters: readonly ManagedEntityGuardGetter[],
): ManagedEntityLeaveGuard {
  return {
    dirty: getters.some((get) => get().dirty),
    saving: getters.some((get) => get().saving),
    discardOnly: getters.some((get) => get().dirty && get().discardOnly),
    async save() {
      if (getters.some((get) => get().dirty && get().discardOnly)) return false;
      for (const get of [...getters].reverse()) {
        const guard = get();
        if (guard.saving || (guard.dirty && !(await guard.save()))) return false;
      }
      return true;
    },
    discard() {
      for (const get of getters) if (get().dirty) get().discard();
    },
  };
}
