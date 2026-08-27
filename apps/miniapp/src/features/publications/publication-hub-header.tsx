import { CheckCircle, Plus, Post, Refresh, WarningCircle } from 'iconoir-react';
import type { PublisherEntitiesSummary } from '@maxim/contracts/publisher';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import { openMaxBotLink } from '../../lib/max-bridge';
import type { PublicationTarget } from './publication-model';
import './publication-hub-header.css';

export function PublicationHubHeader({
  publisherProfile,
  canCreate,
  targets,
  publisherSummary,
  setupHandoffUrl,
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
  setupHandoffUrl: string | null;
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
  const canOpenPartialSetup =
    publisherAttention > 0 && publisherTotal > 0 && !sourcesHaveError && Boolean(setupHandoffUrl);
  const publisherStatusTone = sourcesHaveError
    ? 'danger'
    : publisherTotal === 0 || publisherAttention > 0
      ? 'attention'
      : 'ready';
  const publisherStatus = sourcesLoading || sourcesFetching
    ? 'Проверяю подключения'
    : sourcesHaveError && publisherTotal === 0
      ? 'Получатели временно недоступны'
      : publisherTotal === 0
        ? 'Нет подключений · настройка в Майоре'
        : publisherAttention > 0
          ? `${formatRussianCountLabel(publisherReady, 'готов', 'готовы', 'готовы')} · ${formatRussianCountLabel(
              publisherAttention,
              'недоступен',
              'недоступны',
              'недоступны',
            )} · настройка в Майоре`
          : `${formatRussianCountLabel(publisherReady, 'готов', 'готовы', 'готовы')} к публикации`;

  return (
    <>
      <header className="publications-header">
        <div>
          <h1>
            {publisherProfile ? <Post aria-hidden /> : null}
            <span>{publisherProfile ? 'Публик' : 'Посты'}</span>
          </h1>
          {publisherProfile ? <span>Посты</span> : null}
        </div>
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
          <button
            type="button"
            className="publication-publisher-status__copy"
            disabled={!canOpenPartialSetup}
            aria-label={canOpenPartialSetup ? 'Открыть Майора для настройки получателей' : undefined}
            title={canOpenPartialSetup ? 'Настроить в Майоре' : undefined}
            onClick={() => {
              if (canOpenPartialSetup && setupHandoffUrl) {
                openMaxBotLink(setupHandoffUrl);
              }
            }}
          >
            <strong>Получатели</strong>
            <small>{publisherStatus}</small>
          </button>
          <button
            type="button"
            className={cn(
              'publication-publisher-status__refresh',
              sourcesFetching && 'is-refreshing',
            )}
            aria-label={
              publisherTotal === 0 && !sourcesHaveError && setupHandoffUrl
                ? 'Открыть Майора для настройки Публика'
                : 'Перепроверить подключения Публика'
            }
            title={
              publisherTotal === 0 && !sourcesHaveError && setupHandoffUrl
                ? 'Настроить в Майоре'
                : 'Перепроверить'
            }
            disabled={sourcesFetching}
            onClick={() => {
              if (publisherTotal === 0 && !sourcesHaveError && setupHandoffUrl) {
                openMaxBotLink(setupHandoffUrl);
                return;
              }
              onRefresh();
            }}
          >
            {publisherTotal === 0 && !sourcesHaveError && setupHandoffUrl ? (
              <Plus aria-hidden />
            ) : (
              <Refresh aria-hidden />
            )}
          </button>
        </div>
      ) : null}
    </>
  );
}
