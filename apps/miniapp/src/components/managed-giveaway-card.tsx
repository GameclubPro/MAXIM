import {
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

type GiveawayTone = 'success' | 'warning' | 'muted' | 'danger';

function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить действие.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось выполнить действие.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось выполнить действие.';
  }

  return text;
}

function formatDateTimeLabel(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildStatusLabel(status: ManagedGiveawaySummary['status']): string {
  switch (status) {
    case 'ACTIVE':
      return 'Активен';
    case 'SCHEDULED':
      return 'По таймеру';
    case 'DRAWING':
      return 'Подводим итоги';
    case 'COMPLETED':
      return 'Завершён';
    case 'CANCELED':
      return 'Отменён';
    default:
      return 'Черновик';
  }
}

function buildStatusTone(status: ManagedGiveawaySummary['status']): GiveawayTone {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'SCHEDULED':
    case 'DRAFT':
      return 'warning';
    case 'CANCELED':
      return 'danger';
    default:
      return 'muted';
  }
}

function buildBotActionLabel(status: ManagedGiveawaySummary['status']): string {
  switch (status) {
    case 'DRAFT':
      return 'Продолжить в боте';
    case 'ACTIVE':
    case 'SCHEDULED':
    case 'DRAWING':
      return 'Управлять в боте';
    default:
      return 'Открыть в боте';
  }
}

function buildWinnerStatusLabel(status: ManagedGiveawayDetails['winners'][number]['status']): string {
  switch (status) {
    case 'CLAIMED':
      return 'подтверждён';
    case 'DELIVERED':
      return 'выдан';
    case 'EXPIRED':
      return 'claim истёк';
    case 'REROLLED':
      return 'перевыбран';
    default:
      return 'ждёт claim';
  }
}

function buildWinnerStatusTone(
  status: ManagedGiveawayDetails['winners'][number]['status'],
): GiveawayTone {
  switch (status) {
    case 'CLAIMED':
    case 'DELIVERED':
    case 'SELECTED':
      return 'success';
    case 'EXPIRED':
      return 'danger';
    default:
      return 'muted';
  }
}

function isCurrentLifecycle(status: ManagedGiveawaySummary['status']): boolean {
  return (
    status === 'DRAFT' ||
    status === 'SCHEDULED' ||
    status === 'ACTIVE' ||
    status === 'DRAWING'
  );
}

function getEntityLabel(entityType: 'chat' | 'channel'): string {
  return entityType === 'channel' ? 'канала' : 'чата';
}

function compactText(value: string, maxLength = 180): string {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function sortGiveaways(a: ManagedGiveawaySummary, b: ManagedGiveawaySummary): number {
  const lifecycleScore = Number(isCurrentLifecycle(b.status)) - Number(isCurrentLifecycle(a.status));
  if (lifecycleScore !== 0) {
    return lifecycleScore;
  }

  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function buildPeriodLabel(giveaway: ManagedGiveawaySummary): string {
  if (!giveaway.startsAt) {
    return `сразу -> ${formatDateTimeLabel(giveaway.endsAt)}`;
  }

  return `${formatDateTimeLabel(giveaway.startsAt)} -> ${formatDateTimeLabel(giveaway.endsAt)}`;
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
  const [selectedGiveawayId, setSelectedGiveawayId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['managed-giveaways', entityType, entityId] as const,
    queryFn: () => api.getManagedGiveaways(entityType, entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
  });

  const giveaways = useMemo(
    () => [...(listQuery.data ?? [])].sort(sortGiveaways),
    [listQuery.data],
  );
  const currentGiveaway = useMemo(
    () => giveaways.find((item) => isCurrentLifecycle(item.status)) ?? null,
    [giveaways],
  );

  useEffect(() => {
    if (!giveaways.length) {
      if (selectedGiveawayId !== null) {
        setSelectedGiveawayId(null);
      }
      return;
    }

    if (selectedGiveawayId && giveaways.some((item) => item.id === selectedGiveawayId)) {
      return;
    }

    setSelectedGiveawayId((currentGiveaway ?? giveaways[0]).id);
  }, [currentGiveaway, giveaways, selectedGiveawayId]);

  const detailQuery = useQuery({
    queryKey: ['managed-giveaway', entityType, entityId, selectedGiveawayId] as const,
    queryFn: () => api.getManagedGiveaway(entityType, entityId, selectedGiveawayId ?? ''),
    enabled: Boolean(entityId && selectedGiveawayId),
    refetchOnWindowFocus: false,
  });

  const selectedSummary =
    giveaways.find((item) => item.id === selectedGiveawayId) ?? currentGiveaway ?? giveaways[0] ?? null;
  const selectedGiveaway = detailQuery.data ?? null;
  const displayedGiveaway = selectedGiveaway ?? selectedSummary;
  const displayedGiveawayId = displayedGiveaway?.id ?? null;
  const historyGiveaways = giveaways.filter((item) => item.id !== displayedGiveawayId);
  const canCreateNew = !currentGiveaway || ['COMPLETED', 'CANCELED'].includes(currentGiveaway.status);
  const selectedIsCurrent = Boolean(displayedGiveaway && displayedGiveaway.id === currentGiveaway?.id);
  const isDetailLoading = Boolean(selectedSummary && detailQuery.isLoading && !selectedGiveaway);

  const handoffMutation = useMutation({
    mutationFn: (giveawayId: string | null) =>
      api.handoffManagedGiveaway(entityType, entityId, { giveawayId }),
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть бота',
        description: formatApiError(error),
      });
    },
  });

  const isBusy = listQuery.isFetching || detailQuery.isFetching || handoffMutation.isPending;

  const refreshGiveaways = () => {
    void listQuery.refetch();
    if (selectedGiveawayId) {
      void detailQuery.refetch();
    }
  };

  const openInBot = async (giveawayId: string | null) => {
    try {
      const result = await handoffMutation.mutateAsync(giveawayId);
      openMaxBotLink(result.botUrl);
    } catch {
      // Mutation toast already shown.
    }
  };

  const primaryAction = canCreateNew
    ? { label: 'Создать в боте', giveawayId: null as string | null }
    : displayedGiveaway
      ? {
          label: buildBotActionLabel(displayedGiveaway.status),
          giveawayId: displayedGiveaway.id,
        }
      : { label: 'Создать в боте', giveawayId: null as string | null };
  const hasDetailError = Boolean(detailQuery.error && selectedSummary);

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <div className="managed-giveaway__title">Розыгрыши</div>
          <div className="managed-giveaway__subtitle">
            Miniapp показывает статус и архив. Создание и управление идут в личке бота.
          </div>
        </div>
        <button
          type="button"
          className="button button--ghost"
          disabled={isBusy}
          onClick={refreshGiveaways}
        >
          Обновить
        </button>
      </div>

      {listQuery.isLoading ? <div className="managed-giveaway__empty">Загружаем розыгрыши...</div> : null}

      {listQuery.error ? (
        <div className="managed-giveaway__empty is-danger">
          <strong>Не удалось загрузить список</strong>
          <p>{formatApiError(listQuery.error)}</p>
          <button type="button" className="button button--ghost" onClick={refreshGiveaways}>
            Повторить
          </button>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && giveaways.length === 0 ? (
        <div className="managed-giveaway__empty">
          <strong>Пока пусто</strong>
          <p>Первый розыгрыш для {getEntityLabel(entityType)} создаётся прямо в личке бота.</p>
          <div className="managed-giveaway__actions">
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy}
              onClick={() => {
                void openInBot(null);
              }}
            >
              Создать в боте
            </button>
          </div>
        </div>
      ) : null}

      {displayedGiveaway ? (
        <div className="managed-giveaway__panel managed-giveaway__summary-card">
          <div className="managed-giveaway__summary-topline">
            <span className={cn('managed-giveaway__badge', `is-${buildStatusTone(displayedGiveaway.status)}`)}>
              {buildStatusLabel(displayedGiveaway.status)}
            </span>
            <span className="managed-giveaway__eyebrow">
              {selectedIsCurrent ? 'Текущий слот' : 'Архив'}
            </span>
          </div>

          <div className="managed-giveaway__summary-copy">
            <h4>{displayedGiveaway.title}</h4>
            {selectedGiveaway?.description.trim() ? (
              <p>{compactText(selectedGiveaway.description)}</p>
            ) : null}
          </div>

          {isDetailLoading ? (
            <div className="managed-giveaway__error-inline">
              <span>Подтягиваем подробности карточки…</span>
            </div>
          ) : null}

          <div className="managed-giveaway__stat-grid">
            <div className="managed-giveaway__stat-card">
              <span>Период</span>
              <strong>{buildPeriodLabel(displayedGiveaway)}</strong>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Заявки</span>
              <strong>
                {selectedGiveaway
                  ? `${selectedGiveaway.entriesCount} · ok ${selectedGiveaway.verifiedEntriesCount}`
                  : `${displayedGiveaway.entriesCount}`}
              </strong>
              {selectedGiveaway?.pendingEntriesCount ? (
                <small>На проверке: {selectedGiveaway.pendingEntriesCount}</small>
              ) : null}
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Победители</span>
              <strong>{displayedGiveaway.winnersCount}</strong>
              <small>{displayedGiveaway.status === 'COMPLETED' ? 'итоги готовы' : 'мест в слоте'}</small>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>{selectedGiveaway ? 'Claim' : 'Обновлено'}</span>
              <strong>
                {selectedGiveaway
                  ? `${selectedGiveaway.claimHours} ч`
                  : formatDateTimeLabel(displayedGiveaway.updatedAt)}
              </strong>
              <small>
                {selectedGiveaway
                  ? selectedGiveaway.imageEnabled
                    ? 'Фото добавлено'
                    : 'Без фото'
                  : displayedGiveaway.hasImage
                    ? 'Фото добавлено'
                    : 'Без фото'}
              </small>
            </div>
          </div>

          {hasDetailError ? (
            <div className="managed-giveaway__error-inline">
              <span>{formatApiError(detailQuery.error)}</span>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  void detailQuery.refetch();
                }}
              >
                Повторить
              </button>
            </div>
          ) : null}

          {selectedGiveaway?.prizes.length ? (
            <div className="managed-giveaway__section">
              <div className="managed-giveaway__section-head">
                <div className="managed-giveaway__section-copy">
                  <strong>Призы</strong>
                  <small>{selectedGiveaway.prizes.length} мест</small>
                </div>
              </div>
              <div className="managed-giveaway__chips">
                {selectedGiveaway.prizes.map((prize) => (
                  <span key={prize.id} className="managed-giveaway__chip">
                    {prize.position}. {compactText(prize.title, 38)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {selectedGiveaway?.winners.length ? (
            <div className="managed-giveaway__section">
              <div className="managed-giveaway__section-head">
                <div className="managed-giveaway__section-copy">
                  <strong>Победители</strong>
                  <small>{selectedGiveaway.winners.length} мест</small>
                </div>
              </div>
              <div className="managed-giveaway__winners">
                {selectedGiveaway.winners.map((winner) => (
                  <div key={winner.id} className="managed-giveaway__winner-row">
                    <div className="managed-giveaway__winner-copy">
                      <strong>
                        {winner.prizePosition}. {winner.prizeTitle}
                      </strong>
                      <p>{winner.displayName || winner.userId}</p>
                      {winner.claimDeadlineAt ? (
                        <small>Claim до {formatDateTimeLabel(winner.claimDeadlineAt)}</small>
                      ) : null}
                    </div>
                    <span className={cn('managed-giveaway__badge', `is-${buildWinnerStatusTone(winner.status)}`)}>
                      {buildWinnerStatusLabel(winner.status)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {displayedGiveaway.publicationUrl || displayedGiveaway.resultsUrl ? (
            <div className="managed-giveaway__actions">
              {displayedGiveaway.publicationUrl ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => openMaxBotLink(displayedGiveaway.publicationUrl ?? '')}
                >
                  Открыть пост
                </button>
              ) : null}
              {displayedGiveaway.resultsUrl ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => openMaxBotLink(displayedGiveaway.resultsUrl ?? '')}
                >
                  Итоги
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="managed-giveaway__actions">
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy}
              onClick={() => {
                void openInBot(primaryAction.giveawayId);
              }}
            >
              {primaryAction.label}
            </button>

            {canCreateNew && displayedGiveaway ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy}
                onClick={() => {
                  void openInBot(displayedGiveaway.id);
                }}
              >
                {buildBotActionLabel(displayedGiveaway.status)}
              </button>
            ) : null}

            {!selectedIsCurrent && currentGiveaway ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy}
                onClick={() => {
                  setSelectedGiveawayId(currentGiveaway.id);
                }}
              >
                Текущий слот
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {historyGiveaways.length > 0 ? (
        <div className="managed-giveaway__history">
          <button
            type="button"
            className="managed-giveaway__history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            <span className="managed-giveaway__history-copy">
              <strong>Архив</strong>
              <small>{historyGiveaways.length} карточек</small>
            </span>
            <StepChevron isOpen={historyOpen} />
          </button>

          <div className={cn('settings-section__collapse', historyOpen && 'is-open')}>
            <div className="settings-section__collapse-inner">
              <div className="managed-giveaway__history-list">
                {historyGiveaways.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      'managed-giveaway__history-item',
                      selectedGiveawayId === item.id && 'is-active',
                    )}
                    onClick={() => {
                      setSelectedGiveawayId(item.id);
                    }}
                  >
                    <span>{item.title}</span>
                    <small>
                      {buildStatusLabel(item.status)} · {item.entriesCount} заявок
                    </small>
                    <small>{buildPeriodLabel(item)}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
