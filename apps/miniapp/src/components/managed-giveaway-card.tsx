import { useMutation } from '@tanstack/react-query';
import type { ApiClient } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось открыть бота.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось открыть бота.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось открыть бота.';
  }

  return text;
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

  const handoffMutation = useMutation({
    mutationFn: () => api.handoffManagedGiveaway(entityType, entityId, { giveawayId: null }),
    onSuccess: (result) => {
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть бота',
        description: formatApiError(error),
      });
    },
  });

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <div className="managed-giveaway__title">Розыгрыши</div>
          <div className="managed-giveaway__subtitle">
            В mini app оставлен только вход. Создание и ведение розыгрыша идут в личке бота.
          </div>
        </div>
      </div>

      <div className="managed-giveaway__empty">
        <strong>Работаем через чат бота</strong>
        <p>Нажмите кнопку ниже и продолжайте розыгрыш уже в личке бота.</p>
        <div className="managed-giveaway__actions">
          <button
            type="button"
            className="button button--accent"
            disabled={handoffMutation.isPending}
            onClick={() => {
              void handoffMutation.mutateAsync();
            }}
          >
            {handoffMutation.isPending ? 'Открываем…' : 'Создать розыгрыш'}
          </button>
        </div>
      </div>
    </div>
  );
}
