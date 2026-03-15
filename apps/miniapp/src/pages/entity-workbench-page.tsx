import type { WorkbenchQuickAction, WorkbenchSummary } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { ParticipantsIcon } from '../components/ui/entity-header-icons';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import {
  getChannelWorkbench,
  openChannelEntrypoint,
} from '../lib/api/channel-settings-client';
import {
  getChatWorkbench,
  openChatEntrypoint,
} from '../lib/api/chat-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { openMaxBotLink } from '../lib/max-bridge';

function formatParticipantsCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить переход.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось выполнить переход.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось выполнить переход.';
  }

  return text;
}

function buildMiniappActionRoute(
  entityType: 'chat' | 'channel',
  entityId: string,
  action: WorkbenchQuickAction,
): string {
  if (action.intent === 'settings_section') {
    return `/${entityType}/${entityId}/settings${action.section ? `?section=${encodeURIComponent(action.section)}` : ''}`;
  }
  if (action.intent === 'broadcast_compose') {
    return `/${entityType}/${entityId}/settings?section=${encodeURIComponent(
      action.section ?? (entityType === 'channel' ? 'broadcast' : 'mailing'),
    )}`;
  }
  if (action.intent === 'poll_manage') {
    return `/${entityType}/${entityId}/settings?section=poll`;
  }
  if (action.intent === 'giveaway_manage') {
    return `/${entityType}/${entityId}/settings?section=giveaway`;
  }
  if (action.intent === 'channel_dialog') {
    return `/${entityType}/${entityId}/settings?section=${encodeURIComponent(action.section ?? 'comments')}`;
  }

  return `/${entityType}/${entityId}`;
}

function DraftRoute({
  entityType,
  entityId,
  draft,
}: {
  entityType: 'chat' | 'channel';
  entityId: string;
  draft: WorkbenchSummary['activeDrafts'][number];
}) {
  const route =
    draft.intent === 'broadcast_compose'
      ? `/${entityType}/${entityId}/settings?section=${entityType === 'channel' ? 'broadcast' : 'mailing'}`
      : draft.intent === 'poll_manage'
        ? `/${entityType}/${entityId}/settings?section=poll`
        : `/${entityType}/${entityId}/settings?section=giveaway`;

  return (
    <Link to={route} className="button button--ghost">
      Открыть
    </Link>
  );
}

function EntityWorkbenchPage({
  api,
  entityType,
}: {
  api: ApiTransport;
  entityType: 'chat' | 'channel';
}) {
  const { chatId = '' } = useParams();
  const navigate = useNavigate();
  const workbenchQuery = useQuery({
    queryKey: ['workbench', entityType, chatId],
    queryFn: () =>
      entityType === 'channel' ? getChannelWorkbench(api, chatId) : getChatWorkbench(api, chatId),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const openEntrypointMutation = useMutation({
    mutationFn: (action: WorkbenchQuickAction) =>
      entityType === 'channel'
        ? openChannelEntrypoint(api, chatId, {
            intent: action.intent,
            section: action.section ?? null,
            dialogType: null,
            resourceId: null,
            sourceSurface: 'miniapp',
          })
        : openChatEntrypoint(api, chatId, {
            intent: action.intent,
            section: action.section ?? null,
            dialogType: null,
            resourceId: null,
            sourceSurface: 'miniapp',
          }),
    onSuccess: (result) => {
      if (result.botUrl) {
        openMaxBotLink(result.botUrl);
      }
    },
  });

  const workbench = workbenchQuery.data ?? null;

  useEffect(() => {
    if (!workbench) {
      return;
    }

    saveLastEntityId(entityType, workbench.header.id);
    saveChatTitle(workbench.header.id, workbench.header.title);
  }, [entityType, workbench]);

  const title = workbench?.header.title ?? (entityType === 'channel' ? 'Канал' : 'Чат');
  const participantsLabel = formatParticipantsCount(workbench?.header.participantsCount);

  return (
    <div className="page-stack page-enter">
      <GlassCard className="workbench-hero" elevated>
        {workbenchQuery.isLoading ? (
          <SkeletonCard lines={5} />
        ) : workbenchQuery.error || !workbench ? (
          <StatusState
            tone="danger"
            title="Не удалось открыть рабочий экран"
            description={formatApiError(workbenchQuery.error)}
            action={
              <button
                type="button"
                className="button button--accent"
                onClick={() => void workbenchQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        ) : (
          <>
            <div className="workbench-hero__top">
              <Link to={buildManagedEntitiesRoute(entityType)} className="button button--ghost">
                Назад
              </Link>
              <span className="chip">{entityType === 'channel' ? 'Канал' : 'Чат'}</span>
            </div>

            <div className="workbench-hero__copy">
              <h1>{title}</h1>
              {participantsLabel ? (
                <div className="workbench-hero__meta">
                  <ParticipantsIcon />
                  <span>{participantsLabel}</span>
                </div>
              ) : null}
              <p>
                {workbench.activation.completed
                  ? 'Активация завершена. Используйте быстрые действия или переходите в rich-настройки.'
                  : `До полной активации осталось шагов: ${workbench.activation.totalSteps - workbench.activation.completedSteps}.`}
              </p>
            </div>

            <div className="workbench-metrics">
              <div className="workbench-metric-card">
                <strong>{workbench.activation.completedSteps}/{workbench.activation.totalSteps}</strong>
                <small>Активация</small>
              </div>
              <div className="workbench-metric-card">
                <strong>{workbench.attention.activeBroadcasts}</strong>
                <small>Активных рассылок</small>
              </div>
              <div className="workbench-metric-card">
                <strong>{workbench.attention.activeGiveaways}</strong>
                <small>Розыгрышей</small>
              </div>
              <div className="workbench-metric-card">
                <strong>{entityType === 'chat' ? workbench.attention.moderationEvents24h : Number(workbench.attention.hasPollDraft)}</strong>
                <small>{entityType === 'chat' ? 'Событий за 24ч' : 'Черновик опроса'}</small>
              </div>
            </div>
          </>
        )}
      </GlassCard>

      {workbench ? (
        <>
          <GlassCard className="settings-section" elevated>
            <div className="settings-section__head">
              <div className="settings-section__toggle-main">
                <h3>Activation checklist</h3>
                <small>{workbench.activation.nextStepLabel ?? 'Все шаги выполнены'}</small>
              </div>
            </div>

            <div className="workbench-checklist">
              {workbench.activation.items.map((item) => (
                <div
                  key={item.key}
                  className={cn('workbench-checklist__item', item.done && 'is-done')}
                >
                  <strong>{item.done ? 'Готово' : 'Ждёт'}</strong>
                  <div>
                    <div>{item.label}</div>
                    {item.description ? <small>{item.description}</small> : null}
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>

          <GlassCard className="settings-section" elevated>
            <div className="settings-section__head">
              <div className="settings-section__toggle-main">
                <h3>Быстрые действия</h3>
                <small>Переход в нужный surface без поиска по меню</small>
              </div>
            </div>

            <div className="workbench-actions">
              {workbench.quickActions
                .filter((action) => action.key !== 'share_bot')
                .map((action) =>
                  action.targetSurface === 'miniapp' ? (
                    <Link
                      key={action.key}
                      to={buildMiniappActionRoute(entityType, chatId, action)}
                      className="button button--accent"
                    >
                      {action.label}
                    </Link>
                  ) : (
                    <button
                      key={action.key}
                      type="button"
                      className="button button--ghost"
                      disabled={openEntrypointMutation.isPending}
                      onClick={() => {
                        void openEntrypointMutation.mutateAsync(action);
                      }}
                    >
                      {action.label}
                    </button>
                  ),
                )}
              {entityType === 'chat' ? (
                <Link to={`/chat/${chatId}/events`} className="button button--ghost">
                  Логи в mini app
                </Link>
              ) : (
                <Link to={`/channel/${chatId}/stats`} className="button button--ghost">
                  Статистика канала
                </Link>
              )}
            </div>

            {openEntrypointMutation.error ? (
              <small className="field__hint">{formatApiError(openEntrypointMutation.error)}</small>
            ) : null}
          </GlassCard>

          <GlassCard className="settings-section" elevated>
            <div className="settings-section__head">
              <div className="settings-section__toggle-main">
                <h3>Активные черновики и процессы</h3>
                <small>
                  {workbench.activeDrafts.length > 0
                    ? 'Возвращайтесь в незавершённые сценарии без ручного поиска.'
                    : 'Пока нет активных сценариев.'}
                </small>
              </div>
            </div>

            {workbench.activeDrafts.length > 0 ? (
              <div className="workbench-drafts">
                {workbench.activeDrafts.map((draft) => (
                  <div key={`${draft.kind}-${draft.resourceId ?? draft.title}`} className="workbench-draft-card">
                    <div>
                      <strong>{draft.title}</strong>
                      <small>{draft.status}</small>
                    </div>
                    <DraftRoute entityType={entityType} entityId={chatId} draft={draft} />
                  </div>
                ))}
              </div>
            ) : (
              <StatusState
                tone="neutral"
                title="Пока пусто"
                description="После первой рассылки, опроса или розыгрыша здесь появятся быстрые возвраты."
              />
            )}
          </GlassCard>

          <div className="workbench-bottom-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void workbenchQuery.refetch()}
            >
              Обновить
            </button>
            <button
              type="button"
              className="button button--accent"
              onClick={() =>
                navigate(
                  entityType === 'channel'
                    ? `/channel/${chatId}/settings`
                    : `/chat/${chatId}/settings`,
                )
              }
            >
              Открыть настройки
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ChatWorkbenchPage({ api }: { api: ApiTransport }) {
  return <EntityWorkbenchPage api={api} entityType="chat" />;
}

export function ChannelWorkbenchPage({ api }: { api: ApiTransport }) {
  return <EntityWorkbenchPage api={api} entityType="channel" />;
}
