import { Refresh } from 'iconoir-react';
import { cn } from '../../lib/cn';
import type { InitialPublicationTargetRouteResult } from './use-initial-publication-target-route';

type PublicationTargetNoticesProps = {
  publisherProfile: boolean;
  sourcesHaveError: boolean;
  sourcesUnavailable: boolean;
  sourcesFetching: boolean;
  chatsFailed: boolean;
  onSourcesRefresh: () => void;
  draftHydrationFailed: boolean;
  draftHydrationPending: boolean;
  onDraftHydrationRefresh: () => void;
  initialRoute: InitialPublicationTargetRouteResult;
};

function RetryAction({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}>
      <Refresh aria-hidden />
      <span>{busy ? 'Проверяю' : 'Повторить'}</span>
    </button>
  );
}

export function PublicationTargetNotices({
  publisherProfile,
  sourcesHaveError,
  sourcesUnavailable,
  sourcesFetching,
  chatsFailed,
  onSourcesRefresh,
  draftHydrationFailed,
  draftHydrationPending,
  onDraftHydrationRefresh,
  initialRoute,
}: PublicationTargetNoticesProps) {
  const routeMessage =
    initialRoute.failure?.reason === 'not_ready'
      ? 'Получатель из ссылки пока не готов к публикации через Публик'
      : initialRoute.failure?.kind === 'unavailable'
        ? 'Получатель из ссылки недоступен.'
        : initialRoute.failure
          ? 'Не удалось проверить получателя из ссылки'
          : null;

  return (
    <>
      {sourcesHaveError ? (
        <div
          className={cn(
            'publications-inline-notice',
            sourcesUnavailable ? 'is-danger' : 'is-warning',
          )}
          role={sourcesUnavailable ? 'alert' : 'status'}
        >
          <span>
            {sourcesUnavailable
              ? 'Чаты и каналы недоступны'
              : publisherProfile
                ? 'Получатели Публика временно недоступны'
                : chatsFailed
                  ? 'Чаты временно недоступны'
                  : 'Каналы временно недоступны'}
          </span>
          <RetryAction busy={sourcesFetching} onClick={onSourcesRefresh} />
        </div>
      ) : null}
      {draftHydrationFailed ? (
        <div className="publications-inline-notice is-danger" role="alert">
          <span>Не удалось проверить получателей черновика</span>
          <RetryAction busy={draftHydrationPending} onClick={onDraftHydrationRefresh} />
        </div>
      ) : null}
      {initialRoute.pending ? (
        <div className="publications-inline-notice" role="status">
          <span>Проверяю получателя из ссылки</span>
        </div>
      ) : routeMessage ? (
        <div
          className={cn(
            'publications-inline-notice',
            initialRoute.failure?.kind === 'retryable' ? 'is-danger' : 'is-warning',
          )}
          role={initialRoute.failure?.kind === 'retryable' ? 'alert' : 'status'}
        >
          <span>{routeMessage}</span>
          {initialRoute.retry ? (
            <RetryAction busy={initialRoute.pending} onClick={initialRoute.retry} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
