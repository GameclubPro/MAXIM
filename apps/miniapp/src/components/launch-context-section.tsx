import { useEffect, useRef, useState } from 'react';
import type { ManagedEntitiesRefreshState, Me } from '@maxim/contracts';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle } from '../lib/chat-titles';
import { saveLastEntityId, type VisibleLaunchContext } from '../lib/last-chat';
import type { ManagedEntitiesSyncResult } from '../lib/use-managed-entities-sync';
import { LaunchContextCard } from './launch-context-card';

type ManagedTab = 'chat' | 'channel';

function resolveLaunchContextTab(
  launchContext: Me['launchContext'] | null | undefined,
): ManagedTab | null {
  if (launchContext?.chatType === 'chat') {
    return 'chat';
  }
  if (launchContext?.chatType === 'channel') {
    return 'channel';
  }

  return null;
}

function buildLaunchContextPrimaryRoute(
  launchContext: NonNullable<Me['launchContext']>,
  tab: ManagedTab,
): string {
  return tab === 'chat'
    ? `/chat/${launchContext.chatId}/settings`
    : `/channel/${launchContext.chatId}/settings`;
}

function buildLaunchContextSecondaryRoute(
  launchContext: NonNullable<Me['launchContext']>,
  tab: ManagedTab,
): string {
  return tab === 'chat'
    ? `/chat/${launchContext.chatId}/events`
    : `/channel/${launchContext.chatId}/stats`;
}

function formatRefreshProgress(refreshState: ManagedEntitiesRefreshState | null): string | null {
  if (
    typeof refreshState?.processedCandidates === 'number' &&
    typeof refreshState.totalCandidates === 'number' &&
    refreshState.totalCandidates >= refreshState.processedCandidates
  ) {
    return `${refreshState.processedCandidates} из ${refreshState.totalCandidates}`;
  }
  if (typeof refreshState?.progressPercent === 'number') {
    return `${refreshState.progressPercent}%`;
  }

  return null;
}

export function LaunchContextSection({
  api,
  chatsState,
  channelsState,
  onLaunchContextTabChange,
  onVisibleLaunchContextChange,
  onQueueRefresh,
  onSystemAccessChange,
}: {
  api: ApiTransport;
  chatsState: ManagedEntitiesSyncResult;
  channelsState: ManagedEntitiesSyncResult;
  onLaunchContextTabChange: (tab: ManagedTab | null) => void;
  onVisibleLaunchContextChange: (value: VisibleLaunchContext | null) => void;
  onQueueRefresh: (tab: ManagedTab, behavior: 'default' | 'recovery') => void;
  onSystemAccessChange: (value: boolean) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const launchContextRecoveryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((nextMe) => {
        setMe(nextMe);
        onSystemAccessChange(nextMe.canAccessSystem === true);
        onLaunchContextTabChange(resolveLaunchContextTab(nextMe.launchContext ?? null));
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMe(null);
          onSystemAccessChange(false);
          onLaunchContextTabChange(null);
        }
      });

    return () => controller.abort();
  }, [api, onLaunchContextTabChange, onSystemAccessChange]);

  const launchContext = me?.launchContext ?? null;
  const launchContextTab = resolveLaunchContextTab(launchContext);
  const launchContextEntitiesState =
    launchContextTab === 'chat'
      ? chatsState
      : launchContextTab === 'channel'
        ? channelsState
        : null;
  const launchContextEntity =
    launchContext && launchContextEntitiesState?.data
      ? (launchContextEntitiesState.data.find((entity) => entity.id === launchContext.chatId) ??
        null)
      : null;
  const launchContextRecoveryKey =
    launchContext && launchContextTab ? `${launchContextTab}:${launchContext.chatId}` : null;
  const launchContextPrimaryRoute =
    launchContext && launchContextTab
      ? buildLaunchContextPrimaryRoute(launchContext, launchContextTab)
      : null;
  const launchContextSecondaryRoute =
    launchContext && launchContextTab
      ? buildLaunchContextSecondaryRoute(launchContext, launchContextTab)
      : null;
  const launchContextTitle =
    launchContextEntity?.title ??
    launchContext?.chatTitle ??
    (launchContextTab === 'channel' ? 'Текущий канал' : 'Текущий чат');
  const launchContextRetryAfterSec =
    typeof launchContextEntitiesState?.refreshState?.manualRefreshRetryAfterMs === 'number' &&
    launchContextEntitiesState.refreshState.manualRefreshRetryAfterMs > 0
      ? Math.max(
          1,
          Math.ceil(launchContextEntitiesState.refreshState.manualRefreshRetryAfterMs / 1_000),
        )
      : null;
  const launchContextProgress = formatRefreshProgress(
    launchContextEntitiesState?.refreshState ?? null,
  );
  const launchContextIsChecking =
    launchContext !== null &&
    launchContextEntity === null &&
    Boolean(
      launchContextEntitiesState &&
      (!launchContextEntitiesState.hasLoadedFromServer ||
        launchContextEntitiesState.isRefreshing ||
        (!launchContextEntitiesState.isSyncComplete &&
          !launchContextEntitiesState.isBackoffActive)),
    );
  const launchContextNoun =
    launchContextTab === 'channel' ? 'канал' : launchContextTab === 'chat' ? 'чат' : 'сущность';
  const launchContextDescription =
    launchContext === null || launchContextTab === null || launchContextEntitiesState === null
      ? null
      : launchContextEntity
        ? launchContextTab === 'chat'
          ? 'Доступ подтверждён. Можно открыть настройки или события.'
          : 'Доступ подтверждён. Можно открыть настройки или статистику.'
        : !launchContextEntitiesState.hasLoadedFromServer
          ? `Проверяем ${launchContextNoun} на сервере.`
          : launchContextEntitiesState.isBackoffActive
            ? `MAX временно ограничил проверку. Повторим автоматически${launchContextRetryAfterSec ? ` через ${launchContextRetryAfterSec} с` : ''}.`
            : launchContextEntitiesState.error
              ? 'Не удалось подтвердить доступ в этой сессии.'
              : launchContextProgress
              ? `${launchContextNoun === 'чат' ? 'Чат' : 'Канал'} ещё не в общем списке. Синк: ${launchContextProgress}.`
                : `${launchContextNoun === 'чат' ? 'Чат' : 'Канал'} открыт из MAX, но права бота ещё не подтверждены.`;
  const visibleLaunchContext =
    launchContext && launchContextTab && launchContextPrimaryRoute && launchContextDescription
      ? {
          tab: launchContextTab,
          chatId: launchContext.chatId,
        }
      : null;

  useEffect(() => {
    onVisibleLaunchContextChange(visibleLaunchContext);
  }, [onVisibleLaunchContextChange, visibleLaunchContext]);

  useEffect(() => {
    if (
      !launchContext ||
      !launchContextTab ||
      !launchContextEntitiesState ||
      !launchContextRecoveryKey ||
      launchContextEntity ||
      launchContextEntitiesState.error ||
      launchContextEntitiesState.isBackoffActive ||
      !launchContextEntitiesState.hasLoadedFromServer
    ) {
      return;
    }
    if (launchContextRecoveryKeyRef.current === launchContextRecoveryKey) {
      return;
    }

    launchContextRecoveryKeyRef.current = launchContextRecoveryKey;
    onQueueRefresh(launchContextTab, 'recovery');
  }, [
    launchContext,
    launchContextEntitiesState,
    launchContextEntity,
    launchContextRecoveryKey,
    launchContextTab,
    onQueueRefresh,
  ]);

  if (
    !launchContext ||
    !launchContextTab ||
    !launchContextPrimaryRoute ||
    !launchContextDescription
  ) {
    return null;
  }

  return (
    <LaunchContextCard
      badge={launchContextTab === 'channel' ? 'Текущий канал' : 'Текущий чат'}
      title={launchContextTitle}
      description={launchContextDescription}
      entityType={launchContextTab}
      avatarUrl={launchContextEntity?.avatarUrl ?? null}
      isChecking={launchContextIsChecking}
      primaryRoute={launchContextPrimaryRoute}
      primaryLabel={
        launchContextTab === 'channel' ? 'Открыть настройки канала' : 'Открыть настройки чата'
      }
      primaryState={
        launchContextTab === 'channel'
          ? {
              chatTitle: launchContextTitle,
              chatLink: launchContextEntity?.link ?? '',
              avatarUrl: launchContextEntity?.avatarUrl ?? null,
            }
          : {
              chatTitle: launchContextTitle,
              avatarUrl: launchContextEntity?.avatarUrl ?? null,
            }
      }
      onPrimaryOpen={() => {
        saveLastEntityId(launchContextTab, launchContext.chatId);
        saveChatTitle(launchContext.chatId, launchContextTitle);
      }}
      secondaryRoute={launchContextEntity ? launchContextSecondaryRoute : null}
      secondaryLabel={
        launchContextEntity
          ? launchContextTab === 'channel'
            ? 'Статистика'
            : 'События'
          : undefined
      }
      secondaryState={{
        chatTitle: launchContextTitle,
        avatarUrl: launchContextEntity?.avatarUrl ?? null,
      }}
      onSecondaryOpen={
        launchContextEntity
          ? () => {
              saveLastEntityId(launchContextTab, launchContext.chatId);
              saveChatTitle(launchContext.chatId, launchContextTitle);
            }
          : undefined
      }
      onRetry={() => onQueueRefresh(launchContextTab, 'recovery')}
      retryDisabled={launchContextEntitiesState?.isBackoffActive === true}
    />
  );
}
