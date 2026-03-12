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

  const historyItems = useMemo(
    () =>
      [...(listQuery.data ?? [])]
        .filter((item) => item.status === 'COMPLETED' || item.status === 'CANCELED')
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        ),
    [listQuery.data],
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

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__actions">
        <button
          type="button"
          className="button button--accent"
          disabled={handoffMutation.isPending}
          onClick={() => {
            void handoffMutation.mutateAsync(null);
          }}
        >
          {handoffMutation.isPending ? 'Открываем…' : 'Создать розыгрыш'}
        </button>
      </div>

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
              <small>{historyItems.length}</small>
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
                      disabled={handoffMutation.isPending}
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
                      disabled={deleteMutation.isPending}
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
