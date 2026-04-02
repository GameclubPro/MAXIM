import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeApiError } from '../lib/api-error';
import {
  getChatBotExecutionPlan,
  updateChatPartnerAssist,
  updateChatPrimaryBot,
} from '../lib/api/chat-settings-client';
import {
  getChannelBotExecutionPlan,
  updateChannelPartnerAssist,
  updateChannelPrimaryBot,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import { maxNotify } from '../lib/max-bridge';
import { BotExecutionPanel } from './bot-execution-panel';
import { GlassCard } from './ui/glass-card';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import { useToast } from './ui/toast';

type DiagnosticsEntityType = 'chat' | 'channel';

type BotExecutionDiagnosticsCardProps = {
  api: ApiTransport;
  chatId: string;
  entityType: DiagnosticsEntityType;
  shouldShow: boolean;
  className: string;
  elevated?: boolean;
};

function formatDiagnosticsError(error: unknown): string {
  return describeApiError(error, 'Не удалось загрузить диагностику ботов.');
}

export function BotExecutionDiagnosticsCard({
  api,
  chatId,
  entityType,
  shouldShow,
  className,
  elevated = false,
}: BotExecutionDiagnosticsCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [pendingPrimaryBotId, setPendingPrimaryBotId] = useState<string | null>(null);
  const [pendingAssistBotId, setPendingAssistBotId] = useState<string | null>(null);

  const queryKey = ['bot-execution-plan', entityType, chatId] as const;
  const botExecutionPlanQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      entityType === 'chat'
        ? getChatBotExecutionPlan(api, chatId, { signal })
        : getChannelBotExecutionPlan(api, chatId, { signal }),
    enabled: shouldShow && Boolean(chatId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const refreshBotExecutionPlanMutation = useMutation({
    mutationFn: () =>
      entityType === 'chat'
        ? getChatBotExecutionPlan(api, chatId, { refresh: true })
        : getChannelBotExecutionPlan(api, chatId, { refresh: true }),
    onSuccess: (plan) => {
      queryClient.setQueryData(queryKey, plan);
      pushToast({
        tone: 'success',
        title: 'Права ботов обновлены',
        description: 'Состояние owner и standby подтянуто заново.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить права',
        description: formatDiagnosticsError(error),
      });
      maxNotify('error');
    },
  });

  const updatePrimaryBotMutation = useMutation({
    mutationFn: (botId: string) =>
      entityType === 'chat'
        ? updateChatPrimaryBot(api, chatId, botId)
        : updateChannelPrimaryBot(api, chatId, botId),
    onMutate: (botId) => {
      setPendingPrimaryBotId(botId);
    },
    onSuccess: (plan) => {
      queryClient.setQueryData(queryKey, plan);
      pushToast({
        tone: 'success',
        title: 'Owner обновлён',
        description: 'Новая маршрутизация сохранена.',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сменить owner',
        description: formatDiagnosticsError(error),
      });
      maxNotify('error');
    },
    onSettled: () => {
      setPendingPrimaryBotId(null);
    },
  });

  const updatePartnerAssistMutation = useMutation({
    mutationFn: (payload: { botId: string; enabled: boolean }) =>
      entityType === 'chat'
        ? updateChatPartnerAssist(api, chatId, payload)
        : updateChannelPartnerAssist(api, chatId, payload),
    onMutate: ({ botId }) => {
      setPendingAssistBotId(botId);
    },
    onSuccess: (plan, variables) => {
      queryClient.setQueryData(queryKey, plan);
      pushToast({
        tone: 'success',
        title: variables.enabled ? 'Assist включён' : 'Assist выключен',
        description: 'Настройка partner-бота сохранена.',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить assist',
        description: formatDiagnosticsError(error),
      });
      maxNotify('error');
    },
    onSettled: () => {
      setPendingAssistBotId(null);
    },
  });

  if (!shouldShow || !chatId) {
    return null;
  }

  return (
    <GlassCard className={className} elevated={elevated}>
      {botExecutionPlanQuery.data ? (
        <BotExecutionPanel
          plan={botExecutionPlanQuery.data}
          isRefreshing={botExecutionPlanQuery.isFetching || refreshBotExecutionPlanMutation.isPending}
          pendingPrimaryBotId={pendingPrimaryBotId}
          pendingAssistBotId={pendingAssistBotId}
          onRefresh={() => {
            void refreshBotExecutionPlanMutation.mutateAsync();
          }}
          onMakePrimary={(botId) => {
            updatePrimaryBotMutation.mutate(botId);
          }}
          onToggleAssist={(botId, enabled) => {
            updatePartnerAssistMutation.mutate({ botId, enabled });
          }}
        />
      ) : botExecutionPlanQuery.isLoading ? (
        <SkeletonCard lines={6} />
      ) : botExecutionPlanQuery.error ? (
        <StatusState
          tone="warning"
          title="Диагностика ботов недоступна"
          description={formatDiagnosticsError(botExecutionPlanQuery.error)}
          action={
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void refreshBotExecutionPlanMutation.mutateAsync()}
            >
              Обновить права
            </button>
          }
        />
      ) : null}
    </GlassCard>
  );
}
