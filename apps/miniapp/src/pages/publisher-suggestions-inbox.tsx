import type {
  PublisherSuggestion,
  PublisherSuggestionsResponse,
  PublisherSuggestionsView,
} from '@maxim/contracts/publisher';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EditPencil, MediaImage, NavArrowDown, Refresh, Xmark } from 'iconoir-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { useToast } from '../components/ui/toast';
import { reviewPublisherSuggestion } from '../lib/api/publisher-suggestions-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { describeUserFacingError } from '../lib/user-facing-error';
import { getPublisherSuggestionStatusLabel } from './publisher-entity-modules-page-model';
import {
  loadPublisherSuggestionsPage,
  shouldLoadPublisherSuggestions,
} from './publisher-suggestions-inbox-model';

const LazyActionConfirmSheet = lazy(async () => {
  const module = await import('../components/ui/action-confirm-sheet');
  return { default: module.ActionConfirmSheet };
});

type PublisherSuggestionConfirmation = {
  suggestionId: string;
  action: 'draft' | 'cancel';
};

const PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS = 4_000;

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

function containsPublishingSuggestion(
  pages: readonly PublisherSuggestionsResponse[] | undefined,
): boolean {
  return (
    pages?.some((page) =>
      page.items.some((suggestion) => suggestion.reviewStatus === 'publishing'),
    ) ?? false
  );
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
  const queryRoot = useMemo(() => ['publisher-suggestions', entityId] as const, [entityId]);
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
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      view === 'pending' && containsPublishingSuggestion(query.state.data?.pages)
        ? PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS
        : false,
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
  const reviewMutation = useMutation({
    mutationFn: ({ suggestionId, action }: { suggestionId: string; action: 'draft' | 'cancel' }) =>
      reviewPublisherSuggestion(api, entityId, suggestionId, { action }),
    onSuccess: async (response, variables) => {
      setConfirmation(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryRoot }),
        queryClient.invalidateQueries({ queryKey: ['publications'] }),
      ]);
      pushToast({
        tone: 'success',
        title:
          variables.action === 'draft'
            ? response.suggestion.reviewStatus === 'drafted'
              ? 'Черновик готов'
              : 'Готовим черновик'
            : 'Предложка отклонена',
      });
      if (variables.action === 'draft' && response.suggestion.publicationId) {
        navigate(`/publications?draft=${encodeURIComponent(response.suggestion.publicationId)}`);
      }
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обработать предложку'),
      });
    },
  });

  useEffect(() => {
    setView('pending');
    setConfirmation(null);
  }, [entityId]);

  if (!enabled) {
    return null;
  }

  const openPublicationDraft = (publicationId: string) => {
    navigate(`/publications?draft=${encodeURIComponent(publicationId)}`);
  };

  return (
    <>
      <div className="publisher-suggestions-workspace">
        <div className="publisher-suggestions-filters" role="group" aria-label="Раздел предложек">
          <button
            type="button"
            className={cn(view === 'pending' && 'is-active')}
            aria-pressed={view === 'pending'}
            onClick={() => setView('pending')}
          >
            <span>Ожидают</span>
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
            <span>Загружаю предложки</span>
          </div>
        ) : activeQuery.isError ? (
          <div className="publisher-suggestions-state has-error" role="alert">
            <span>Не удалось загрузить предложки</span>
            <button type="button" onClick={() => void activeQuery.refetch()}>
              Повторить
            </button>
          </div>
        ) : suggestions.length > 0 ? (
          <div
            className="publisher-suggestions-inbox"
            aria-label={view === 'pending' ? 'Предложки, ожидающие решения' : 'История предложек'}
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
                <MaxMarkdownPreview
                  value={suggestion.text}
                  sourceFormat={suggestion.textFormat}
                  className="publisher-suggestion-row__text"
                  fallback="Предложка без текста"
                />
                {suggestion.imageCount > 0 ? (
                  <span className="publisher-suggestion-row__media">
                    <MediaImage aria-hidden />
                    {suggestion.imageCount} фото
                  </span>
                ) : null}
                {suggestion.reviewError ? (
                  <p className="publisher-suggestion-row__error" role="status">
                    Не удалось создать публикацию: {suggestion.reviewError}
                  </p>
                ) : null}
                {suggestion.reviewStatus === 'pending' ? (
                  <div className="publisher-suggestion-row__actions">
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        setConfirmation({ suggestionId: suggestion.id, action: 'draft' })
                      }
                    >
                      <EditPencil aria-hidden />
                      <span>Открыть в редакторе</span>
                    </button>
                    <button
                      type="button"
                      className="is-secondary"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        setConfirmation({ suggestionId: suggestion.id, action: 'cancel' })
                      }
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
            <span>{view === 'pending' ? 'Новых предложек нет' : 'История пока пуста'}</span>
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

      {confirmation && confirmationSuggestion ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id={`publisher-suggestion-${confirmation.action}-confirm`}
            open
            title={
              confirmation.action === 'draft'
                ? 'Открыть предложку в редакторе?'
                : 'Отклонить предложку?'
            }
            summary={
              confirmation.action === 'draft'
                ? 'Создадим черновик с исходным текстом и фото. В редакторе можно проверить пост и выбрать время.'
                : 'Предложка будет отклонена и перемещена в историю. Отменить это действие нельзя.'
            }
            previewTitle={confirmationSuggestion.authorDisplayName || 'Пользователь'}
            previewMeta={
              <>
                <MaxMarkdownPreview
                  value={confirmationSuggestion.text}
                  sourceFormat={confirmationSuggestion.textFormat}
                  className="publisher-suggestion-confirm__text"
                  fallback="Предложка без текста"
                />
                {confirmationSuggestion.imageCount > 0 ? (
                  <span className="publisher-suggestion-row__media">
                    <MediaImage aria-hidden />
                    {confirmationSuggestion.imageCount} фото
                  </span>
                ) : null}
              </>
            }
            confirmLabel={
              confirmation.action === 'draft' ? 'Открыть редактор' : 'Отклонить предложку'
            }
            confirmBusyLabel={confirmation.action === 'draft' ? 'Готовлю...' : 'Отклоняю...'}
            cancelLabel="Отмена"
            tone={confirmation.action === 'draft' ? 'accent' : 'danger'}
            isBusy={reviewMutation.isPending}
            onClose={() => setConfirmation(null)}
            onConfirm={() =>
              reviewMutation.mutate({
                suggestionId: confirmationSuggestion.id,
                action: confirmation.action,
              })
            }
          />
        </Suspense>
      ) : null}
    </>
  );
}
