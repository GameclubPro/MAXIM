import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ApiTransport } from './api/transport';
import { HomeEntityFavoritesSession } from './home-entity-favorites-session';
export type * from './home-entity-favorites-types';

const FavoritesContext = createContext<HomeEntityFavoritesSession | null>(null);
export type HomeEntityFavoritesProviderProps = {
  api: ApiTransport;
  verifiedUserId: string;
  children: ReactNode;
};

export function HomeEntityFavoritesProvider({
  api,
  verifiedUserId,
  children,
}: HomeEntityFavoritesProviderProps): ReactElement {
  const queryClient = useQueryClient();
  const binding = useMemo(
    () => ({ session: new HomeEntityFavoritesSession(api, verifiedUserId), mounts: 0 }),
    [api, queryClient, verifiedUserId],
  );
  useEffect(() => {
    binding.mounts += 1;
    void binding.session.refreshLabels().catch(() => undefined);
    let lastVisibleRefresh = 0;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastVisibleRefresh < 2_000) return;
      lastVisibleRefresh = Date.now();
      void binding.session.refreshLabels().catch(() => undefined);
      for (const type of ['chat', 'channel'] as const) {
        const current = binding.session.getSnapshot().byType[type];
        if (current.status === 'idle' && current.typeCompositionVersion === null) continue;
        void binding.session
          .refreshCatalogue(type)
          .then(() => binding.session.refreshAssignments(type))
          .catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('focus', refreshOnReturn);
    window.addEventListener('pageshow', refreshOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.removeEventListener('focus', refreshOnReturn);
      window.removeEventListener('pageshow', refreshOnReturn);
      binding.mounts -= 1;
      // StrictMode's immediate effect replay keeps the binding. Real credential
      // unmounts dispose it before any late acknowledgement can publish.
      queueMicrotask(() => {
        if (binding.mounts === 0) binding.session.dispose();
      });
    };
  }, [binding]);
  return <FavoritesContext.Provider value={binding.session}>{children}</FavoritesContext.Provider>;
}

export function useHomeEntityFavoritesSession() {
  const session = useContext(FavoritesContext);
  if (!session) throw new Error('Authenticated HomeEntityFavoritesProvider required');
  return session;
}
export function useHomeEntityFavorites() {
  const session = useHomeEntityFavoritesSession();
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { snapshot, actions: session.actions };
}
