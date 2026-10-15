import { useEffect, useState, type RefObject } from 'react';
import type {
  ChatSummary,
  ManagedEntityPresentation,
  ManagedEntityPresentationResponse,
} from '@maxim/contracts';
import type { ApiTransport } from './api/transport';
import { saveChatTitles } from './chat-titles';

export { mergeEntityPresentation } from './entity-presentation';
const EMPTY_PRESENTATION: Record<string, ManagedEntityPresentation> = {};

export function useEntityPresentation(options: {
  api: ApiTransport;
  root: RefObject<HTMLElement | null>;
  entityType: 'chat' | 'channel';
  entities: readonly ChatSummary[];
  scope: string;
  reloadNonce: number;
}) {
  const { api, root, entityType, scope, reloadNonce } = options;
  const renderedKey = JSON.stringify(options.entities.map((entity) => entity.id));
  const [visibleKey, setVisibleKey] = useState('[]');
  const stateScope = `${scope}:${entityType}`;
  const [state, setState] = useState<{
    scope: string;
    items: Record<string, ManagedEntityPresentation>;
  }>({ scope: stateScope, items: {} });
  const [resume, setResume] = useState(0);

  useEffect(() => {
    const parent = root.current;
    if (!parent) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleKey(JSON.stringify((JSON.parse(renderedKey) as string[]).slice(0, 32)));
      return;
    }
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.entityId;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setVisibleKey(JSON.stringify([...visible].sort().slice(0, 32)));
      },
      { rootMargin: '120px 0px' },
    );
    parent.querySelectorAll('[data-entity-id]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [root, renderedKey, entityType]);

  useEffect(() => {
    const listener = () => {
      if (document.visibilityState === 'visible') setResume((value) => value + 1);
    };
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);

  useEffect(() => {
    const allowed = new Set<string>(JSON.parse(renderedKey));
    const ids = (JSON.parse(visibleKey) as string[]).filter((id) => allowed.has(id));
    if (ids.length === 0 || document.visibilityState !== 'visible') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const stop = () => {
      abort.abort();
      clearTimeout(timer);
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') stop();
    };
    document.addEventListener('visibilitychange', visibility);
    const load = async () => {
      try {
        const response = (await api.request('/managed-entities/presentation', {
          method: 'POST',
          body: JSON.stringify({ entityType, entityIds: ids }),
          signal: abort.signal,
          timeoutMs: 8000,
        })) as ManagedEntityPresentationResponse;
        if (abort.signal.aborted || !Array.isArray(response.items)) return;
        const items = response.items.filter(
          (item) => ids.includes(item.id) && item.entityType === entityType,
        );
        setState((previous) => {
          const merged = previous.scope === stateScope ? { ...previous.items } : {};
          for (const id of ids) if (!items.some((item) => item.id === id)) delete merged[id];
          for (const item of items) {
            const old = merged[item.id];
            const metadata =
              old?.observedAt && (!item.observedAt || item.observedAt < old.observedAt)
                ? old
                : item;
            const moderator =
              (old?.moderatorRevision ?? -1) > (item.moderatorRevision ?? -1) ? old : item;
            merged[item.id] = {
              ...metadata,
              moderator: moderator.moderator,
              moderatorRevision: moderator.moderatorRevision,
              canChooseModerator: moderator.canChooseModerator,
            };
          }
          return { scope: stateScope, items: merged };
        });
        saveChatTitles(
          items
            .filter((item) => item.title)
            .map((item) => ({ id: item.id, title: item.title! })) as ChatSummary[],
        );
        attempts += 1;
        // A finite demand session outlives discovery completion without polling the whole list.
        if (attempts < 8 && items.some((item) => item.pending)) {
          timer = setTimeout(
            () => void load(),
            Math.max(
              1000,
              Math.min(10000, (response.retryAfterMs || 2000) * 2 ** Math.floor(attempts / 2)),
            ),
          );
        }
      } catch {
        /* Preserve known presentation; another visible session or explicit refresh may retry. */
      }
    };
    timer = setTimeout(() => void load(), 150);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, entityType, visibleKey, renderedKey, stateScope, reloadNonce, resume]);

  return state.scope === stateScope ? state.items : EMPTY_PRESENTATION;
}
