import { CheckCircle, Plus, Post, Refresh, WarningCircle } from 'iconoir-react';
import type { PublisherEntitiesSummary } from '@maxim/contracts/publisher';
import { Link } from 'react-router';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import type { PublicationTarget } from './publication-model';
import './publication-hub-header.css';

export function PublicationHubHeader({
  publisherProfile,
  canCreate,
  targets,
  publisherSummary,
  sourcesLoading,
  sourcesFetching,
  sourcesHaveError,
  onCreate,
  onRefresh,
}: {
  publisherProfile: boolean;
  canCreate: boolean;
  targets: PublicationTarget[];
  publisherSummary: PublisherEntitiesSummary | null;
  sourcesLoading: boolean;
  sourcesFetching: boolean;
  sourcesHaveError: boolean;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  const publisherTotal = publisherSummary?.total ?? targets.length;
  const publisherReady =
    publisherSummary?.ready ??
    targets.filter((target) => target.readiness?.canPublish === true).length;
  const publisherAttention = publisherSummary?.attention ?? publisherTotal - publisherReady;
  const shouldOpenEntityCabinet =
    !sourcesHaveError && (publisherTotal === 0 || publisherAttention > 0);
  const publisherStatusTone = sourcesHaveError
    ? 'danger'
    : publisherTotal === 0 || publisherAttention > 0
      ? 'attention'
      : 'ready';
  const publisherStatus =
    sourcesLoading || sourcesFetching
      ? 'Проверяю подключения'
      : sourcesHaveError && publisherTotal === 0
        ? 'Получатели временно недоступны'
        : publisherTotal === 0
          ? 'Нет подключённых получателей'
          : publisherAttention > 0
            ? `${formatRussianCountLabel(publisherReady, 'готов', 'готовы', 'готовы')} · ${formatRussianCountLabel(
                publisherAttention,
                'требует внимания',
                'требуют внимания',
                'требуют внимания',
              )}`
            : `${formatRussianCountLabel(publisherReady, 'готов', 'готовы', 'готовы')} к публикации`;
  const statusCopy = (
    <>
      <strong>Получатели</strong>
      <small>{publisherStatus}</small>
    </>
  );

  return (
    <>
      <header className="publications-header">
        <div>
          <h1>
            {publisherProfile ? <Post aria-hidden /> : null}
            <span>{publisherProfile ? 'Публик' : 'Расписания'}</span>
          </h1>
          {publisherProfile ? <span>Посты</span> : null}
        </div>
        {publisherProfile ? (
          <button
            type="button"
            className="publications-primary"
            onClick={onCreate}
            aria-label="Создать публикацию"
            title={canCreate ? 'Создать публикацию' : 'Нет готовых получателей'}
            disabled={!canCreate}
          >
            <Plus aria-hidden />
            <span>Создать</span>
          </button>
        ) : null}
      </header>

      {publisherProfile ? (
        <div
          className={cn('publication-publisher-status', `is-${publisherStatusTone}`)}
          aria-busy={sourcesLoading || sourcesFetching}
          role={sourcesHaveError ? 'alert' : 'status'}
        >
          <span className="publication-publisher-status__mark" aria-hidden>
            {publisherStatusTone === 'ready' ? <CheckCircle /> : <WarningCircle />}
          </span>
          {shouldOpenEntityCabinet ? (
            <Link
              to="/"
              className="publication-publisher-status__copy"
              aria-label="Открыть получателей Публика"
              title="Открыть получателей"
            >
              {statusCopy}
            </Link>
          ) : (
            <span className="publication-publisher-status__copy">{statusCopy}</span>
          )}
          <button
            type="button"
            className={cn(
              'publication-publisher-status__refresh',
              sourcesFetching && 'is-refreshing',
            )}
            aria-label="Перепроверить подключения Публика"
            title="Перепроверить"
            disabled={sourcesFetching}
            onClick={onRefresh}
          >
            <Refresh aria-hidden />
          </button>
        </div>
      ) : null}
    </>
  );
}
