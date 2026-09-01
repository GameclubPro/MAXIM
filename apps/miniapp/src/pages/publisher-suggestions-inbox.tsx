import type {
  PublisherSuggestion,
  PublisherSuggestionsResponse,
  PublisherSuggestionsView,
} from '@maxim/contracts/publisher';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EditPencil, MediaImage, NavArrowDown, Refresh, Xmark } from 'iconoir-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { useToast } from '../components/ui/toast';
import { reviewPublisherSuggestion } from '../lib/api/publisher-suggestions-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { queryKeys } from '../lib/query-keys';
import { describeUserFacingError } from '../lib/user-facing-error';
import { getPublisherSuggestionStatusLabel } from './publisher-entity-modules-page-model';
import { PublisherSuggestionDraftOpenGate } from './publisher-suggestion-draft-open-gate';
import {
  loadPublisherSuggestionsPage,
  resolvePublisherSuggestionsRefetchInterval,
  shouldLoadPublisherSuggestions,
} from './publisher-suggestions-inbox-model';

const LazyActionConfirmSheet = lazy(async () => {
  const module = await import('../components/ui/action-confirm-sheet');
  return { default: module.ActionConfirmSheet };
});

type PublisherSuggestionConfirmation = {
  suggestionId: string;
};

function mergePublisherSuggestionPages(
  pages: readonly PublisherSuggestionsResponse[] | undefined,
): PublisherSuggestion[] {
  const suggestions = new Map<string, PublisherSuggestion>();
  for (const page of pages ?? []) {
    for (const suggestion of page.items) {
      suggestions.set(suggestion.id, suggestion);
    }
  }
  return [...suggestions.values()];
}

export function PublisherSuggestionsInbox({
  api,
  enabled,
  entityId,
}: {
  api: ApiTransport;
  enabled: boolean;
  entityId: string;
}) {
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<PublisherSuggestionsView>('pending');
  const [confirmation, setConfirmation] = useState<PublisherSuggestionConfirmation | null>(null);
  const [openingDraftSuggestionIds, setOpeningDraftSuggestionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const draftOpenGateRef = useRef(new PublisherSuggestionDraftOpenGate());
  const draftOpenEpochRef = useRef(0);
  const queryRoot = useMemo(() => queryKeys.publisherSuggestions(entityId), [entityId]);
  const pendingQueryKey = useMemo(() => [...queryRoot, 'pending'] as const, [queryRoot]);
  const historyQueryKey = useMemo(() => [...queryRoot, 'history'] as const, [queryRoot]);
  const pendingQuery = useInfiniteQuery({
    queryKey: pendingQueryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      loadPublisherSuggestionsPage({
        api,
        enabled,
        entityId,
        activeView: view,
        requestView: 'pending',
        cursor: pageParam,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: shouldLoadPublisherSuggestions({
      enabled,
      entityId,
      activeView: view,
      requestView: 'pending',
    }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: resolvePublisherSuggestionsRefetchInterval({
      enabled,
      activeView: view,
    }),
  });
  const historyQuery = useInfiniteQuery({
    queryKey: historyQueryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      loadPublisherSuggestionsPage({
        api,
        enabled,
        entityId,
        activeView: view,
        requestView: 'history',
        cursor: pageParam,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: shouldLoadPublisherSuggestions({
      enabled,
      entityId,
      activeView: view,
      requestView: 'history',
    }),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const pendingSuggestions = useMemo(
    () => mergePublisherSuggestionPages(pendingQuery.data?.pages),
    [pendingQuery.data?.pages],
  );
  const historySuggestions = useMemo(
    () => mergePublisherSuggestionPages(historyQuery.data?.pages),
    [historyQuery.data?.pages],
  );
  const activeQuery = view === 'pending' ? pendingQuery : historyQuery;
  const suggestions = view === 'pending' ? pendingSuggestions : historySuggestions;
  const pendingTotal = pendingQuery.data?.pages[0]?.total;
  const historyTotal = historyQuery.data?.pages[0]?.total;
  const activeTotal = view === 'pending' ? (pendingTotal ?? 0) : (historyTotal ?? 0);
  const remainingCount = Math.max(0, activeTotal - suggestions.length);
  const confirmationSuggestion = pendingSuggestions.find(
    (suggestion) =>
      suggestion.id === confirmation?.suggestionId && suggestion.reviewStatus === 'pending',
  );
  const cancelMutation = useMutation({
    mutationFn: (suggestionId: string) =>
      reviewPublisherSuggestion(api, entityId, suggestionId, { action: 'cancel' }),
    onSuccess: async () => {
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: queryRoot });
      pushToast({
        tone: 'success',
        title: 'Предложение отклонено',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обработать предложение'),
      });
    },
  });

  useEffect(() => {
    draftOpenEpochRef.current += 1;
    draftOpenGateRef.current.reset();
    setView('pending');
    setConfirmation(null);
    setOpeningDraftSuggestionIds(new Set());
    return () => {
      draftOpenEpochRef.current += 1;
      draftOpenGateRef.current.reset(true);
    };
  }, [entityId]);

  if (!enabled) {
    return null;
  }

  const openPublicationDraft = (publicationId: string) => {
    if (!draftOpenGateRef.current.tryCommitNavigation()) {
      return;
    }
    navigate(`/publications?draft=${encodeURIComponent(publicationId)}`);
  };

  const openSuggestionDraft = async (suggestionId: string) => {
    const gate = draftOpenGateRef.current;
    const normalizedSuggestionId = gate.tryStart(suggestionId);
    if (!normalizedSuggestionId) {
      return;
    }
    const epoch = draftOpenEpochRef.current;
    setOpeningDraftSuggestionIds((current) => new Set(current).add(normalizedSuggestionId));

    try {
      const response = await reviewPublisherSuggestion(api, entityId, normalizedSuggestionId, {
        action: 'draft',
      });
      if (epoch !== draftOpenEpochRef.current) {
        return;
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryRoot }),
        queryClient.invalidateQueries({ queryKey: ['publications'] }),
      ]);
      const publicationId = response.suggestion.publicationId;
      if (!publicationId) {
        pushToast({ tone: 'info', title: 'Черновик ещё готовится' });
        return;
      }
      openPublicationDraft(publicationId);
    } catch (error: unknown) {
      if (epoch === draftOpenEpochRef.current) {
        pushToast({
          tone: 'danger',
          title: describeUserFacingError(error, 'Не удалось открыть предложение'),
        });
      }
    } finally {
      if (epoch === draftOpenEpochRef.current) {
        gate.finish(normalizedSuggestionId);
        setOpeningDraftSuggestionIds((current) => {
          const next = new Set(current);
          next.delete(normalizedSuggestionId);
          return next;
        });
      }
    }
  };

  const draftOpenBusy = openingDraftSuggestionIds.size > 0;

  return (
    <>
      <div className="publisher-suggestions-workspace">
        <div className="publisher-suggestions-filters" role="group" aria-label="Раздел предложений">
          <button
            type="button"
            className={cn(view === 'pending' && 'is-active')}
            aria-pressed={view === 'pending'}
            onClick={() => setView('pending')}
          >
            <span>Новые</span>
            <strong aria-label={pendingTotal === undefined ? 'Считаю' : undefined}>
              {pendingTotal ?? '...'}
            </strong>
          </button>
          <button
            type="button"
            className={cn(view === 'history' && 'is-active')}
            aria-pressed={view === 'history'}
            onClick={() => setView('history')}
          >
            <span>История</span>
            <strong aria-label={historyTotal === undefined ? 'Считаю' : undefined}>
              {historyTotal ?? '...'}
            </strong>
          </button>
        </div>

        {activeQuery.isLoading ? (
          <div className="publisher-suggestions-state" role="status">
            <Refresh className="is-refreshing" aria-hidden />
            <span>Загружаю предложения</span>
          </div>
        ) : activeQuery.isError ? (
          <div className="publisher-suggestions-state has-error" role="alert">
            <span>Не удалось загрузить предложения</span>
            <button type="button" onClick={() => void activeQuery.refetch()}>
              Повторить
            </button>
          </div>
        ) : suggestions.length > 0 ? (
          <div
            className="publisher-suggestions-inbox"
            aria-label={view === 'pending' ? 'Новые предложения' : 'История предложений'}
          >
            {suggestions.map((suggestion) => (
              <article key={suggestion.id} className="publisher-suggestion-row">
                <div className="publisher-suggestion-row__meta">
                  <strong>{suggestion.authorDisplayName || 'Пользователь'}</strong>
                  <time dateTime={suggestion.createdAt}>
                    {new Intl.DateTimeFormat('ru-RU', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(suggestion.createdAt))}
                  </time>
                </div>
                {suggestion.text.trim() ? (
                  <MaxMarkdownPreview
                    value={suggestion.text}
                    sourceFormat={suggestion.textFormat}
                    className="publisher-suggestion-row__text"
                  />
                ) : null}
                {suggestion.imageCount > 0 ? (
                  <span className="publisher-suggestion-row__media">
                    <MediaImage aria-hidden />
                    {suggestion.imageCount} фото
                  </span>
                ) : null}
                {suggestion.reviewError ? (
                  <p className="publisher-suggestion-row__error" role="alert">
                    {describeUserFacingError(
                      new Error(suggestion.reviewError),
                      'Не удалось создать черновик',
                    )}
                  </p>
                ) : null}
                {suggestion.reviewStatus === 'pending' ? (
                  <div className="publisher-suggestion-row__actions">
                    <button
                      type="button"
                      disabled={draftOpenBusy || cancelMutation.isPending}
                      aria-busy={openingDraftSuggestionIds.has(suggestion.id)}
                      onClick={() => void openSuggestionDraft(suggestion.id)}
                    >
                      {openingDraftSuggestionIds.has(suggestion.id) ? (
                        <Refresh className="is-refreshing" aria-hidden />
                      ) : (
                        <EditPencil aria-hidden />
                      )}
                      <span>
                        {openingDraftSuggestionIds.has(suggestion.id)
                          ? 'Готовим черновик'
                          : 'Открыть в редакторе'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="is-secondary"
                      disabled={draftOpenBusy || cancelMutation.isPending}
                      onClick={() => setConfirmation({ suggestionId: suggestion.id })}
                    >
                      <Xmark aria-hidden />
                      <span>Отклонить</span>
                    </button>
                  </div>
                ) : (
                  <div className="publisher-suggestion-row__outcome">
                    <span
                      className={cn(
                        'publisher-suggestion-row__status',
                        `is-${suggestion.reviewStatus}`,
                      )}
                    >
                      {getPublisherSuggestionStatusLabel(suggestion.reviewStatus)}
                    </span>
                    {suggestion.reviewStatus === 'drafted' && suggestion.publicationId ? (
                      <button
                        type="button"
                        className="publisher-suggestion-row__draft-link"
                        onClick={() => openPublicationDraft(suggestion.publicationId!)}
                      >
                        <EditPencil aria-hidden />
                        <span>Открыть черновик</span>
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="publisher-suggestions-state" role="status">
            <span>{view === 'pending' ? 'Новых предложений нет' : 'История пока пуста'}</span>
          </div>
        )}

        {activeQuery.hasNextPage ? (
          <button
            type="button"
            className="publisher-suggestions-load-more"
            disabled={activeQuery.isFetchingNextPage}
            onClick={() => void activeQuery.fetchNextPage()}
          >
            {activeQuery.isFetchingNextPage ? (
              <Refresh className="is-refreshing" aria-hidden />
            ) : (
              <NavArrowDown aria-hidden />
            )}
            <span>
              {activeQuery.isFetchingNextPage
                ? 'Загружаю...'
                : activeQuery.isFetchNextPageError
                  ? 'Повторить'
                  : remainingCount > 0
                    ? `Показать ещё · ${remainingCount}`
                    : 'Показать ещё'}
            </span>
          </button>
        ) : null}
      </div>

      {draftOpenBusy ? (
        <span className="publisher-suggestions-sr" role="status" aria-live="polite">
          Готовим черновик
        </span>
      ) : null}

      {confirmation && confirmationSuggestion ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id="publisher-suggestion-cancel-confirm"
            open
            title="Отклонить предложение?"
            summary="Предложение переместится в историю. Отменить это действие нельзя."
            previewTitle={confirmationSuggestion.authorDisplayName || 'Пользователь'}
            previewMeta={
              <>
                {confirmationSuggestion.text.trim() ? (
                  <MaxMarkdownPreview
                    value={confirmationSuggestion.text}
                    sourceFormat={confirmationSuggestion.textFormat}
                    className="publisher-suggestion-confirm__text"
                  />
                ) : null}
                {confirmationSuggestion.imageCount > 0 ? (
                  <span className="publisher-suggestion-row__media">
                    <MediaImage aria-hidden />
                    {confirmationSuggestion.imageCount} фото
                  </span>
                ) : null}
              </>
            }
            confirmLabel="Отклонить предложение"
            confirmBusyLabel="Отклоняю..."
            cancelLabel="Отмена"
            tone="danger"
            isBusy={cancelMutation.isPending}
            onClose={() => setConfirmation(null)}
            onConfirm={() => cancelMutation.mutate(confirmationSuggestion.id)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
