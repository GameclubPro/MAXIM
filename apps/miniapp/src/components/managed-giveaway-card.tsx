import type { ManagedGiveawaySummary } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

function formatApiError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const text = error.message.trim();
  if (!text) {
    return fallback;
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || fallback;
  }

  return text;
}

function buildHistoryLabel(status: ManagedGiveawaySummary['status']): string {
  return status === 'CANCELED' ? 'Отменён' : 'Завершён';
}

function buildStatusLabel(status: ManagedGiveawaySummary['status']): string {
  if (status === 'DRAFT') {
    return 'Черновик';
  }
  if (status === 'SCHEDULED') {
    return 'Запланирован';
  }
  if (status === 'ACTIVE') {
    return 'Идёт';
  }
  if (status === 'DRAWING') {
    return 'Подводим итоги';
  }
  if (status === 'COMPLETED') {
    return 'Завершён';
  }
  return 'Отменён';
}

function buildStatusTone(
  status: ManagedGiveawaySummary['status'],
): 'is-success' | 'is-warning' | 'is-danger' | 'is-muted' {
  if (status === 'ACTIVE' || status === 'COMPLETED') {
    return 'is-success';
  }
  if (status === 'SCHEDULED' || status === 'DRAWING' || status === 'DRAFT') {
    return 'is-warning';
  }
  if (status === 'CANCELED') {
    return 'is-danger';
  }
  return 'is-muted';
}

function formatDateTime(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCompactDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

function buildCurrentSubtitle(item: ManagedGiveawaySummary): string {
  if (item.status === 'DRAFT') {
    return `Черновик готов. Финиш: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'SCHEDULED') {
    return `Старт: ${formatDateTime(item.startsAt, 'сразу')}. Финиш: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'ACTIVE') {
    return `Приём заявок открыт до ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'DRAWING') {
    return 'Идёт проверка участников и фиксация победителей.';
  }
  if (item.status === 'COMPLETED') {
    return `Итоги обновлены ${formatDateTime(item.completedAt ?? item.updatedAt)}.`;
  }
  return `Розыгрыш отменён ${formatDateTime(item.updatedAt)}.`;
}

function StepChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <span className={cn('settings-section__chevron', isOpen && 'is-open')} aria-hidden>
      <svg
        className="settings-section__chevron-icon"
        viewBox="0 0 20 20"
        fill="none"
        focusable="false"
      >
        <path
          d="M5.5 7.75L10 12.25L14.5 7.75"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function ManagedGiveawayCard({
  api,
  entityType,
  entityId,
}: {
  api: ApiClient;
  entityType: 'chat' | 'channel';
  entityId: string;
}) {
  const { pushToast } = useToast();
  const [historyOpen, setHistoryOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['managed-giveaways', entityType, entityId] as const,
    queryFn: () => api.getManagedGiveaways(entityType, entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
  });

  const sortedItems = useMemo(
    () =>
      [...(listQuery.data ?? [])].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [listQuery.data],
  );

  const currentItem = useMemo(
    () =>
      sortedItems.find(
        (item) =>
          item.status === 'DRAFT' ||
          item.status === 'SCHEDULED' ||
          item.status === 'ACTIVE' ||
          item.status === 'DRAWING',
      ) ?? null,
    [sortedItems],
  );

  const historyItems = useMemo(
    () => sortedItems.filter((item) => item.status === 'COMPLETED' || item.status === 'CANCELED'),
    [sortedItems],
  );

  const handoffMutation = useMutation({
    mutationFn: (giveawayId: string | null) =>
      api.handoffManagedGiveaway(entityType, entityId, { giveawayId }),
    onSuccess: (result) => {
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть бота',
        description: formatApiError(error, 'Не удалось открыть бота.'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (giveawayId: string) => api.deleteManagedGiveaway(entityType, entityId, giveawayId),
    onSuccess: async () => {
      await listQuery.refetch();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш удалён',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить розыгрыш',
        description: formatApiError(error, 'Не удалось удалить розыгрыш.'),
      });
    },
  });

  const isBusy = handoffMutation.isPending || deleteMutation.isPending;

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <strong className="managed-giveaway__title">Гибридные розыгрыши</strong>
          <small className="managed-giveaway__subtitle">
            Miniapp для контроля, личка бота для детального управления и действий с победителями.
          </small>
        </div>
        <button
          type="button"
          className="button button--accent"
          disabled={isBusy}
          onClick={() => {
            void handoffMutation.mutateAsync(null);
          }}
        >
          {handoffMutation.isPending ? 'Открываем…' : 'Новый'}
        </button>
      </div>

      {listQuery.isLoading ? (
        <div className="managed-giveaway__empty">
          <strong>Загружаем розыгрыши…</strong>
          <p>Подтягиваем текущий статус и историю.</p>
        </div>
      ) : null}

      {listQuery.error ? (
        <div className="managed-giveaway__error-inline">
          <span>{formatApiError(listQuery.error, 'Не удалось загрузить розыгрыши.')}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void listQuery.refetch();
            }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && currentItem ? (
        <div className={cn('managed-giveaway__panel', 'managed-giveaway__summary-card')}>
          <div className="managed-giveaway__summary-topline">
            <span className="managed-giveaway__eyebrow">Текущий розыгрыш</span>
            <span className={cn('managed-giveaway__badge', buildStatusTone(currentItem.status))}>
              {buildStatusLabel(currentItem.status)}
            </span>
          </div>

          <div className="managed-giveaway__summary-copy">
            <h4>{currentItem.title}</h4>
            <p>{buildCurrentSubtitle(currentItem)}</p>
          </div>

          <div className="managed-giveaway__stat-grid">
            <div className="managed-giveaway__stat-card">
              <span>Заявки</span>
              <strong>{currentItem.entriesCount}</strong>
              <small>всего</small>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Verified</span>
              <strong>{currentItem.verifiedEntriesCount}</strong>
              <small>допущены</small>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Pending</span>
              <strong>{currentItem.pendingEntriesCount}</strong>
              <small>ожидают check</small>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Победители</span>
              <strong>{currentItem.winnersCount}</strong>
              <small>по местам</small>
            </div>
          </div>

          <div className="managed-giveaway__chips">
            <span className="managed-giveaway__chip">
              Старт: {formatDateTime(currentItem.startsAt, 'сразу')}
            </span>
            <span className="managed-giveaway__chip">
              Финиш: {formatDateTime(currentItem.endsAt)}
            </span>
          </div>

          <div className="managed-giveaway__actions">
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy}
              onClick={() => {
                void handoffMutation.mutateAsync(currentItem.id);
              }}
            >
              Открыть в боте
            </button>

            {currentItem.publicationUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(currentItem.publicationUrl ?? '')}
              >
                Пост
              </button>
            ) : null}

            {currentItem.resultsUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(currentItem.resultsUrl ?? '')}
              >
                Итоги
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && !currentItem && historyItems.length === 0 ? (
        <div className="managed-giveaway__empty">
          <strong>Активных розыгрышей пока нет</strong>
          <p>Создайте первый сценарий и запустите его через личку бота.</p>
        </div>
      ) : null}

      {historyItems.length > 0 ? (
        <div className="managed-giveaway__history">
          <button
            type="button"
            className="managed-giveaway__history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            <span className="managed-giveaway__history-copy">
              <strong>История</strong>
              <small>{historyItems.length} завершённых сценариев</small>
            </span>
            <StepChevron isOpen={historyOpen} />
          </button>

          <div className={cn('settings-section__collapse', historyOpen && 'is-open')}>
            <div className="settings-section__collapse-inner">
              <div className="managed-giveaway__history-list">
                {historyItems.map((item) => (
                  <div key={item.id} className="managed-giveaway__history-row">
                    <button
                      type="button"
                      className="managed-giveaway__history-item"
                      disabled={isBusy}
                      onClick={() => {
                        void handoffMutation.mutateAsync(item.id);
                      }}
                    >
                      <span className="managed-giveaway__history-title">{item.title}</span>
                      <span className="managed-giveaway__history-meta">
                        <span
                          className={cn(
                            'managed-giveaway__badge',
                            item.status === 'CANCELED' ? 'is-danger' : 'is-muted',
                          )}
                        >
                          {buildHistoryLabel(item.status)}
                        </span>
                        <small>{formatCompactDate(item.completedAt ?? item.updatedAt)}</small>
                      </span>
                    </button>

                    <button
                      type="button"
                      className="managed-giveaway__history-delete"
                      aria-label={`Удалить розыгрыш ${item.title}`}
                      disabled={isBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteMutation.mutateAsync(item.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
