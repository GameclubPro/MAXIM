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

function formatDateTimeLabel(value: string | null): string {
  if (!value) {
    return 'не задано';
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

function buildStatusTone(
  status: ManagedGiveawaySummary['status'],
): 'success' | 'warning' | 'muted' | 'danger' {
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

function buildWinnerStatusLabel(status: ManagedGiveawayDetails['winners'][number]['status']): string {
  switch (status) {
    case 'CLAIMED':
      return 'приз подтверждён';
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

function compactText(value: string, maxLength = 40): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildOverview(
  giveaway: ManagedGiveawaySummary | null,
  entityType: 'chat' | 'channel',
): { title: string; subtitle: string; meta: string[]; statusLabel: string; tone: 'success' | 'warning' | 'muted' | 'danger' } {
  if (!giveaway) {
    return {
      title: 'Создание теперь в боте',
      subtitle: `Откройте личку бота и соберите карточку розыгрыша для ${getEntityLabel(entityType)}.`,
      meta: ['Фото и текст: в боте', 'Miniapp: статус и архив', 'Flow: bot-first'],
      statusLabel: 'Пусто',
      tone: 'muted',
    };
  }

  return {
    title: giveaway.title,
    subtitle: `${buildStatusLabel(giveaway.status)} · ${giveaway.entriesCount} заявок`,
    meta: [
      `Победители: ${giveaway.winnersCount}`,
      `Финиш: ${formatDateTimeLabel(giveaway.endsAt)}`,
      giveaway.startsAt ? `Старт: ${formatDateTimeLabel(giveaway.startsAt)}` : 'Старт: сразу',
    ],
    statusLabel: buildStatusLabel(giveaway.status),
    tone: buildStatusTone(giveaway.status),
  };
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

  const giveaways = listQuery.data ?? [];
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

  const selectedGiveaway = detailQuery.data ?? null;
  const visibleSummary =
    giveaways.find((item) => item.id === selectedGiveawayId) ?? currentGiveaway ?? giveaways[0] ?? null;
  const historyGiveaways = giveaways.filter(
    (item) => item.id !== (selectedGiveawayId ?? currentGiveaway?.id ?? null),
  );
  const canCreateNew = !currentGiveaway || ['COMPLETED', 'CANCELED'].includes(currentGiveaway.status);
  const overview = buildOverview(visibleSummary, entityType);

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

  const selectedActionLabel =
    selectedGiveaway?.status === 'DRAFT' ? 'Продолжить в боте' : 'Открыть в боте';

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <div className="managed-giveaway__title">Розыгрыши</div>
          <div className="managed-giveaway__subtitle">
            Текст, фото, призы и публикация теперь собираются прямо в личке бота.
          </div>
        </div>
      </div>

      <div className="managed-giveaway__overview-card">
        <div className="managed-giveaway__overview-main">
          <div className="managed-giveaway__overview-topline">
            <span className={cn('managed-giveaway__badge', `is-${overview.tone}`)}>
              {overview.statusLabel}
            </span>
            <span className="managed-giveaway__overview-kicker">bot-first flow</span>
          </div>
          <strong>{overview.title}</strong>
          <span>{overview.subtitle}</span>
        </div>
        <div className="managed-giveaway__overview-meta">
          {overview.meta.map((item) => (
            <span key={item} className="managed-giveaway__overview-chip">
              {item}
            </span>
          ))}
        </div>
      </div>

      {listQuery.isLoading ? <div className="managed-giveaway__empty">Загружаем розыгрыши...</div> : null}

      {listQuery.error ? (
        <div className="managed-giveaway__empty is-danger">
          <p>{formatApiError(listQuery.error)}</p>
          <button type="button" className="button button--ghost" onClick={refreshGiveaways}>
            Повторить
          </button>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && giveaways.length === 0 ? (
        <div className="managed-giveaway__empty">
          <p>Черновиков пока нет. Создайте первый розыгрыш в личке бота.</p>
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
      ) : null}

      {selectedGiveawayId && detailQuery.isLoading ? (
        <div className="managed-giveaway__panel">Загружаем розыгрыш...</div>
      ) : null}

      {!detailQuery.isLoading && detailQuery.error ? (
        <div className="managed-giveaway__empty is-danger">
          <p>{formatApiError(detailQuery.error)}</p>
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

      {selectedGiveaway ? (
        <div className="managed-giveaway__panel">
          <div className="managed-giveaway__summary-head">
            <div className="managed-giveaway__section-copy">
              <h4>{selectedGiveaway.title}</h4>
              <div className={cn('managed-giveaway__badge', `is-${buildStatusTone(selectedGiveaway.status)}`)}>
                {buildStatusLabel(selectedGiveaway.status)}
              </div>
            </div>
            <div className="managed-giveaway__meta">
              <span>{selectedGiveaway.entriesCount} заявок</span>
              <span>{selectedGiveaway.winnersCount} победителей</span>
            </div>
          </div>

          {selectedGiveaway.description.trim() ? (
            <div className="managed-giveaway__details">
              <p>{selectedGiveaway.description}</p>
            </div>
          ) : null}

          <div className="managed-giveaway__meta-list">
            <span>Старт: {formatDateTimeLabel(selectedGiveaway.startsAt)}</span>
            <span>Финиш: {formatDateTimeLabel(selectedGiveaway.endsAt)}</span>
            <span>Claim: {selectedGiveaway.claimHours} ч.</span>
            <span>Фото: {selectedGiveaway.imageEnabled ? 'есть' : 'нет'}</span>
          </div>

          <div className="managed-giveaway__chips">
            {selectedGiveaway.prizes.map((prize) => (
              <span key={prize.id} className="managed-giveaway__chip">
                {prize.position}. {compactText(prize.title, 32)}
              </span>
            ))}
          </div>

          {selectedGiveaway.winners.length > 0 ? (
            <div className="managed-giveaway__winners">
              {selectedGiveaway.winners.map((winner) => (
                <div key={winner.id} className="managed-giveaway__winner-row">
                  <div>
                    <strong>
                      {winner.prizePosition}. {winner.prizeTitle}
                    </strong>
                    <p>{winner.displayName || winner.userId}</p>
                    <small>{buildWinnerStatusLabel(winner.status)}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="managed-giveaway__actions">
            {canCreateNew ? (
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
            ) : null}
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={() => {
                void openInBot(selectedGiveaway.id);
              }}
            >
              {selectedActionLabel}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={refreshGiveaways}
            >
              Обновить
            </button>
            {selectedGiveaway.publicationUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(selectedGiveaway.publicationUrl ?? '')}
              >
                Открыть пост
              </button>
            ) : null}
            {selectedGiveaway.resultsUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(selectedGiveaway.resultsUrl ?? '')}
              >
                Итоги
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
              <strong>Архив и другие карточки</strong>
              <small>{historyGiveaways.length} розыгрышей в списке</small>
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
                      {buildStatusLabel(item.status)} · {formatDateTimeLabel(item.completedAt ?? item.endsAt)}
                    </small>
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
