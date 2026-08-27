import type { PublisherSuggestionsResponse } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, NavArrowDown, Refresh, Xmark } from 'iconoir-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useToast } from '../components/ui/toast';
import { listPublisherSuggestions, reviewPublisherSuggestion } from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { describeUserFacingError } from '../lib/user-facing-error';
import {
  countPublisherSuggestions,
  filterPublisherSuggestions,
  getPublisherSuggestionStatusLabel,
  growPublisherSuggestionLimit,
  PUBLISHER_SUGGESTIONS_PAGE_SIZE,
  type PublisherSuggestionView,
} from './publisher-entity-modules-page-model';

const LazyActionConfirmSheet = lazy(async () => {
  const module = await import('../components/ui/action-confirm-sheet');
  return { default: module.ActionConfirmSheet };
});

type PublisherSuggestionConfirmation = {
  suggestionId: string;
  action: 'publish' | 'cancel';
};

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
  const queryClient = useQueryClient();
  const [view, setView] = useState<PublisherSuggestionView>('pending');
  const [visibleLimit, setVisibleLimit] = useState(PUBLISHER_SUGGESTIONS_PAGE_SIZE);
  const [confirmation, setConfirmation] = useState<PublisherSuggestionConfirmation | null>(null);
  const queryKey = ['publisher-suggestions', entityId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listPublisherSuggestions(api, entityId, { signal }),
    enabled: entityId.length > 0,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const suggestions = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const counts = useMemo(() => countPublisherSuggestions(suggestions), [suggestions]);
  const filtered = useMemo(
    () => filterPublisherSuggestions(suggestions, view),
    [suggestions, view],
  );
  const visible = filtered.slice(0, visibleLimit);
  const confirmationSuggestion = suggestions.find(
    (suggestion) =>
      suggestion.id === confirmation?.suggestionId && suggestion.reviewStatus === 'pending',
  );
  const reviewMutation = useMutation({
    mutationFn: ({
      suggestionId,
      action,
    }: {
      suggestionId: string;
      action: 'publish' | 'cancel';
    }) => reviewPublisherSuggestion(api, entityId, suggestionId, { action }),
    onSuccess: async (response, variables) => {
      queryClient.setQueryData<PublisherSuggestionsResponse>(queryKey, (current) =>
        current
          ? {
              items: current.items.map((suggestion) =>
                suggestion.id === response.suggestion.id ? response.suggestion : suggestion,
              ),
            }
          : current,
      );
      setConfirmation(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['publications'] }),
      ]);
      pushToast({
        tone: 'success',
        title: variables.action === 'publish' ? 'Публикация создана' : 'Предложка отклонена',
      });
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
    setVisibleLimit(PUBLISHER_SUGGESTIONS_PAGE_SIZE);
    setConfirmation(null);
  }, [entityId]);

  useEffect(() => {
    setVisibleLimit(PUBLISHER_SUGGESTIONS_PAGE_SIZE);
  }, [view]);

  if (query.isLoading) {
    return (
      <div className="publisher-suggestions-state" role="status">
        <Refresh className="is-refreshing" aria-hidden />
        <span>Загружаю предложки</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="publisher-suggestions-state has-error" role="alert">
        <span>Не удалось загрузить предложки</span>
        <button type="button" onClick={() => void query.refetch()}>
          Повторить
        </button>
      </div>
    );
  }
  if (suggestions.length === 0 && !enabled) {
    return null;
  }

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
            <strong>{counts.pending}</strong>
          </button>
          <button
            type="button"
            className={cn(view === 'history' && 'is-active')}
            aria-pressed={view === 'history'}
            onClick={() => setView('history')}
          >
            <span>История</span>
            <strong>{counts.history}</strong>
          </button>
        </div>

        {visible.length > 0 ? (
          <div
            className="publisher-suggestions-inbox"
            aria-label={view === 'pending' ? 'Предложки, ожидающие решения' : 'История предложек'}
          >
            {visible.map((suggestion) => (
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
                <p>{suggestion.text}</p>
                {suggestion.reviewStatus === 'pending' ? (
                  <div className="publisher-suggestion-row__actions">
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        setConfirmation({ suggestionId: suggestion.id, action: 'publish' })
                      }
                    >
                      <CheckCircle aria-hidden />
                      <span>Опубликовать</span>
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
                  <span
                    className={cn(
                      'publisher-suggestion-row__status',
                      `is-${suggestion.reviewStatus}`,
                    )}
                  >
                    {getPublisherSuggestionStatusLabel(suggestion.reviewStatus)}
                  </span>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="publisher-suggestions-state" role="status">
            <span>{view === 'pending' ? 'Новых предложек нет' : 'История пока пуста'}</span>
          </div>
        )}

        {visible.length < filtered.length ? (
          <button
            type="button"
            className="publisher-suggestions-load-more"
            onClick={() =>
              setVisibleLimit((current) => growPublisherSuggestionLimit(current, filtered.length))
            }
          >
            <NavArrowDown aria-hidden />
            <span>Показать ещё · {filtered.length - visible.length}</span>
          </button>
        ) : null}
      </div>

      {confirmation && confirmationSuggestion ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id={`publisher-suggestion-${confirmation.action}-confirm`}
            open
            title={
              confirmation.action === 'publish' ? 'Опубликовать предложку?' : 'Отклонить предложку?'
            }
            summary={
              confirmation.action === 'publish'
                ? 'Будет создана публикация с отправкой в канал сразу.'
                : 'Предложка будет отклонена и перемещена в историю. Отменить это действие нельзя.'
            }
            previewTitle={confirmationSuggestion.authorDisplayName || 'Пользователь'}
            previewMeta={
              <span className="publisher-suggestion-confirm__text">
                {confirmationSuggestion.text || 'Предложка без текста'}
              </span>
            }
            confirmLabel={
              confirmation.action === 'publish' ? 'Опубликовать сейчас' : 'Отклонить предложку'
            }
            confirmBusyLabel={confirmation.action === 'publish' ? 'Публикую...' : 'Отклоняю...'}
            cancelLabel="Отмена"
            tone={confirmation.action === 'publish' ? 'accent' : 'danger'}
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
