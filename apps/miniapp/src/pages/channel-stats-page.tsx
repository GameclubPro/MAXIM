import type { ChannelOverview } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

type ChannelStatsRouteState = {
  chatTitle: string;
  channelOverview: ChannelOverview | null;
};

const DEFAULT_CHANNEL_OVERVIEW: ChannelOverview = {
  enabledScenariosCount: 0,
  commentsEnabled: false,
  postSuggestionsEnabled: false,
  commentsModerationEnabled: false,
  commentsSlowModeSeconds: 0,
};

function getRouteState(state: unknown): ChannelStatsRouteState {
  if (!state || typeof state !== 'object') {
    return {
      chatTitle: '',
      channelOverview: null,
    };
  }

  const row = state as Record<string, unknown>;
  return {
    chatTitle:
      typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '',
    channelOverview:
      row.channelOverview && typeof row.channelOverview === 'object'
        ? (row.channelOverview as ChannelOverview)
        : null,
  };
}

function formatSlowMode(seconds: number): string {
  if (seconds <= 0) {
    return 'Нет';
  }

  if (seconds < 60) {
    return `${seconds}с`;
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}м`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}м ${restSeconds}с`;
}

function resolveChannelOverviewStatus(enabledScenariosCount: number): {
  label: string;
  tone: 'ready' | 'partial' | 'empty';
  description: string;
} {
  if (enabledScenariosCount >= 2) {
    return {
      label: 'Все включено',
      tone: 'ready',
      description: 'Комментарии и предложка уже активны.',
    };
  }

  if (enabledScenariosCount === 1) {
    return {
      label: 'Частично настроен',
      tone: 'partial',
      description: 'Один сценарий уже работает, второй ещё можно включить.',
    };
  }

  return {
    label: 'Нужно настроить',
    tone: 'empty',
    description: 'Сценарии канала выключены.',
  };
}

function ChannelOverviewPanel({ overview }: { overview: ChannelOverview }) {
  const status = resolveChannelOverviewStatus(overview.enabledScenariosCount);

  return (
    <GlassCard className="channel-overview-card" elevated>
      <div className="channel-overview-card__hero">
        <div className="channel-overview-card__score">
          <span className="channel-overview-card__eyebrow">Активно</span>
          <strong>{overview.enabledScenariosCount}/2</strong>
          <span className="channel-overview-card__hint">сценария канала</span>
        </div>

        <span className={cn('channel-overview-card__status', `is-${status.tone}`)}>
          {status.label}
        </span>
      </div>

      <p className="channel-overview-card__description">{status.description}</p>

      <div className="channel-overview-card__grid">
        <article
          className={cn('channel-overview-card__metric', overview.commentsEnabled && 'is-on')}
        >
          <small>Комментарии</small>
          <strong>{overview.commentsEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            overview.postSuggestionsEnabled && 'is-on',
          )}
        >
          <small>Предложка</small>
          <strong>{overview.postSuggestionsEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            overview.commentsModerationEnabled && 'is-on',
          )}
        >
          <small>Модерация</small>
          <strong>{overview.commentsModerationEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            overview.commentsSlowModeSeconds > 0 && 'is-on',
          )}
        >
          <small>Пауза</small>
          <strong>{formatSlowMode(overview.commentsSlowModeSeconds)}</strong>
        </article>
      </div>
    </GlassCard>
  );
}

export function ChannelStatsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);

  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.getChannels(),
    enabled: Boolean(chatId),
  });

  const channel = useMemo(
    () => channelsQuery.data?.find((item) => item.id === chatId) ?? null,
    [channelsQuery.data, chatId],
  );

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastChatId(chatId);
    saveLastEntityType('channel');
    const titleToPersist = routeState.chatTitle || channel?.title || '';
    if (titleToPersist) {
      saveChatTitle(chatId, titleToPersist);
    }
  }, [channel?.title, chatId, routeState.chatTitle]);

  const resolvedTitle = useMemo(() => {
    if (routeState.chatTitle) {
      return routeState.chatTitle;
    }

    if (channel?.title) {
      return channel.title;
    }

    return readChatTitle(chatId);
  }, [channel?.title, chatId, routeState.chatTitle]);

  const overview = useMemo(() => {
    return routeState.channelOverview ?? channel?.channelOverview ?? DEFAULT_CHANNEL_OVERVIEW;
  }, [channel?.channelOverview, routeState.channelOverview]);

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to="/" className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (channelsQuery.isLoading && !routeState.channelOverview && !routeState.chatTitle) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      </div>
    );
  }

  if (channelsQuery.error && !channel && !routeState.channelOverview) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить статистику"
            description={(channelsQuery.error as Error).message}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void channelsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (
    !channelsQuery.isLoading &&
    !channelsQuery.error &&
    !channel &&
    !routeState.chatTitle &&
    !routeState.channelOverview
  ) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не найден"
            description="Вернитесь к списку каналов и откройте статистику заново."
            action={
              <Link to="/" className="button button--accent">
                К каналам
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="channel-stats-screen page-enter">
      <GlassCard className="channel-stats-hero" elevated>
        <div className="channel-stats-hero__top">
          <Link to="/" className="button button--ghost channel-stats-hero__back">
            Назад
          </Link>
          <span className="channel-stats-hero__badge">Статистика</span>
        </div>

        <div className="channel-stats-hero__main">
          <h1>{resolvedTitle || 'Канал'}</h1>
          <p>{chatId}</p>
        </div>
      </GlassCard>

      <ChannelOverviewPanel overview={overview} />

      <GlassCard className="channel-stats-details" elevated>
        <article className="channel-stats-details__item">
          <small>Обсуждение</small>
          <strong>{overview.commentsEnabled ? 'Открыто' : 'Выключено'}</strong>
          <p>
            {overview.commentsEnabled
              ? 'Подписчики могут перейти в обсуждение поста.'
              : 'Сценарий комментариев сейчас не включён.'}
          </p>
        </article>

        <article className="channel-stats-details__item">
          <small>Идеи в канал</small>
          <strong>{overview.postSuggestionsEnabled ? 'Принимаются' : 'Отключены'}</strong>
          <p>
            {overview.postSuggestionsEnabled
              ? 'Подписчики могут отправлять идеи и предложения.'
              : 'Предложка сейчас не активна.'}
          </p>
        </article>

        <article className="channel-stats-details__item">
          <small>Защита обсуждения</small>
          <strong>{overview.commentsModerationEnabled ? 'Бот модерирует' : 'Ручной режим'}</strong>
          <p>
            {overview.commentsModerationEnabled
              ? 'Бот контролирует сообщения в обсуждении.'
              : 'Автомодерация обсуждения выключена.'}
          </p>
        </article>

        <article className="channel-stats-details__item">
          <small>Темп сообщений</small>
          <strong>{formatSlowMode(overview.commentsSlowModeSeconds)}</strong>
          <p>
            {overview.commentsSlowModeSeconds > 0
              ? 'Интервал между сообщениями ограничен.'
              : 'Ограничение по паузе сейчас не используется.'}
          </p>
        </article>
      </GlassCard>
    </div>
  );
}
