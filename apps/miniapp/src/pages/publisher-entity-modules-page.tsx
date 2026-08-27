import type {
  PublisherChatCommentSettings,
  UpdatePublisherEntityModuleSettingsRequest,
} from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChatBubble,
  CheckCircle,
  Download,
  NavArrowLeft,
  NavArrowRight,
  Post,
  Refresh,
  WarningCircle,
} from 'iconoir-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import {
  getPublisherEntity,
  refreshPublisherEntity,
  updatePublisherModules,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { getVkParsingCapability } from '../lib/api/vk-parsing-client';
import { getPublisherReadinessPresentation } from '../lib/publisher-readiness';
import { describeUserFacingError } from '../lib/user-facing-error';
import {
  buildPublisherComposeRoute,
  pollPublisherEntityRefresh,
  PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
  shouldOfferPublisherRecheck,
  waitForPublisherRefresh,
} from './publisher-entities-page-model';
import {
  buildPublisherEntityListRoute,
  updatePublisherChatCommentSetting,
  type PublisherChatCommentSettingKey,
} from './publisher-entity-modules-page-model';
import './publisher-entity-modules-page.css';

const PUBLISHER_ENTITY_QUERY_ROOT = ['publisher-entity'] as const;
const PUBLISHER_CATALOG_QUERY_ROOT = ['publications', 'sources', 'publisher'] as const;

type PublisherEntityRecheckPhase = 'enqueueing' | 'polling';

const LazyVkParsingCard = lazy(async () => {
  const module = await import('../components/vk-parsing-card');
  return { default: module.VkParsingCard };
});

const LazyPublisherSuggestionsInbox = lazy(async () => {
  const module = await import('./publisher-suggestions-inbox');
  return { default: module.PublisherSuggestionsInbox };
});

function ModuleSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="publisher-module-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="publisher-module-switch__track" aria-hidden>
        <span className="publisher-module-switch__thumb" />
      </span>
    </label>
  );
}

export function PublisherEntityModulesPage({ api }: { api: ApiTransport }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ entityType: string; entityId: string }>();
  const entityType =
    params.entityType === 'chat' || params.entityType === 'channel' ? params.entityType : null;
  const entityId = params.entityId?.trim() ?? '';
  const [vkOpen, setVkOpen] = useState(false);
  const [entityRecheckPhase, setEntityRecheckPhase] = useState<PublisherEntityRecheckPhase | null>(
    null,
  );
  const entityRecheckAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const queryKey = [...PUBLISHER_ENTITY_QUERY_ROOT, entityType, entityId] as const;
  const entityQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, entityType!, entityId, { signal }),
    enabled: entityType !== null && entityId.length > 0,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const vkCapabilityQuery = useQuery({
    queryKey: ['publisher-vk-capability', entityType, entityId],
    queryFn: () => getVkParsingCapability(api, entityType!, entityId),
    enabled: entityType !== null && entityId.length > 0 && Boolean(entityQuery.data),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: (change: Omit<UpdatePublisherEntityModuleSettingsRequest, 'expectedRevision'>) => {
      const entity = entityQuery.data;
      if (!entity || !entityType) {
        throw new Error('Publisher entity is unavailable');
      }
      return updatePublisherModules(api, entityType, entity.id, {
        expectedRevision: entity.moduleSettings.revision,
        ...change,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: PUBLISHER_CATALOG_QUERY_ROOT }),
      ]);
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey });
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить'),
      });
    },
  });

  const saveChatCommentSetting = (
    current: PublisherChatCommentSettings,
    key: PublisherChatCommentSettingKey,
    enabled: boolean,
  ) => {
    mutation.mutate({
      chatComments: updatePublisherChatCommentSetting(current, key, enabled),
    });
  };
  useEffect(() => {
    setVkOpen(false);
  }, [entityId, entityType]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      entityRecheckAbortRef.current?.abort();
    };
  }, []);

  async function handleEntityRecheck(): Promise<void> {
    const initialEntity = entityQuery.data;
    if (!initialEntity || !entityType || entityRecheckAbortRef.current) {
      return;
    }
    const abortController = new AbortController();
    entityRecheckAbortRef.current = abortController;
    setEntityRecheckPhase('enqueueing');

    try {
      await refreshPublisherEntity(api, entityType, initialEntity.id);
      if (abortController.signal.aborted) {
        return;
      }
      setEntityRecheckPhase('polling');
      pushToast({
        tone: 'info',
        title: 'Проверка поставлена в очередь',
        description: 'Жду новый статус доступа от MAX.',
      });

      const result = await pollPublisherEntityRefresh({
        initialEntity,
        delaysMs: PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
        wait: (delayMs) => waitForPublisherRefresh(delayMs, abortController.signal),
        readEntity: () =>
          getPublisherEntity(api, entityType, initialEntity.id, {
            signal: abortController.signal,
          }),
        isCancelled: () => abortController.signal.aborted,
      });
      if (result.status === 'cancelled') {
        return;
      }
      if (result.status === 'updated') {
        queryClient.setQueryData(queryKey, result.entity);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: PUBLISHER_CATALOG_QUERY_ROOT }),
          vkCapabilityQuery.refetch(),
        ]);
        const nextReadiness = getPublisherReadinessPresentation(result.entity.readiness);
        pushToast({
          tone: result.entity.readiness.canPublish ? 'success' : 'info',
          title: result.entity.readiness.canPublish
            ? 'Доступ Публика подтверждён'
            : 'Проверка завершена',
          description: nextReadiness.detail,
        });
        return;
      }
      if (result.status === 'read_failed') {
        pushToast({
          tone: 'danger',
          title: 'Проверка запущена, но статус недоступен',
          description: describeUserFacingError(result.error, 'Повторите обновление позже.'),
        });
        return;
      }
      pushToast({
        tone: 'info',
        title: 'MAX ещё проверяет доступ',
        description: 'Запрос принят. Свежий статус появится после завершения проверки.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось запустить проверку',
          description: describeUserFacingError(error, 'Повторите запрос позже.'),
        });
      }
    } finally {
      if (entityRecheckAbortRef.current === abortController) {
        entityRecheckAbortRef.current = null;
      }
      if (mountedRef.current) {
        setEntityRecheckPhase(null);
      }
    }
  }

  if (!entityType || !entityId) {
    return (
      <section className="publisher-entity-modules-page">
        <div className="publisher-entity-modules-page__state has-error" role="alert">
          <WarningCircle aria-hidden />
          <strong>Сущность не найдена</strong>
          <Link to="/">Вернуться</Link>
        </div>
      </section>
    );
  }

  if (entityQuery.isLoading) {
    return (
      <section className="publisher-entity-modules-page" aria-busy="true">
        <div className="publisher-entity-modules-page__state" role="status">
          <Refresh className="is-refreshing" aria-hidden />
          <strong>Загружаю модули</strong>
        </div>
      </section>
    );
  }

  const entity = entityQuery.data;
  if (!entity) {
    return (
      <section className="publisher-entity-modules-page">
        <div className="publisher-entity-modules-page__state has-error" role="alert">
          <WarningCircle aria-hidden />
          <strong>Не удалось загрузить модули</strong>
          <button type="button" onClick={() => void entityQuery.refetch()}>
            <Refresh aria-hidden />
            <span>Повторить</span>
          </button>
          <Link to={buildPublisherEntityListRoute(entityType)}>Вернуться к списку</Link>
        </div>
      </section>
    );
  }

  const readiness = getPublisherReadinessPresentation(entity.readiness);
  const canRecheckEntity = shouldOfferPublisherRecheck(entity);
  const chatComments = entity.moduleSettings.chatComments;
  const vkCapability = vkCapabilityQuery.data;
  const vkAvailable = vkCapability?.canUse === true;
  const vkStatus = vkCapabilityQuery.isLoading
    ? 'Проверка'
    : vkCapabilityQuery.isError
      ? 'Недоступен'
      : vkAvailable
        ? 'Доступен'
        : (vkCapability?.reason ?? 'Недоступен');
  const busy = mutation.isPending || entityQuery.isFetching || entityRecheckPhase !== null;

  return (
    <section className="publisher-entity-modules-page" aria-busy={busy || undefined}>
      <header className="publisher-entity-modules-page__header">
        <Link
          to={buildPublisherEntityListRoute(entity.entityType)}
          className="publisher-entity-modules-page__back"
          aria-label="Вернуться к списку"
          title="Назад"
        >
          <NavArrowLeft aria-hidden />
        </Link>
        <EntityAvatar
          title={entity.title}
          entityType={entity.entityType}
          avatarUrl={entity.avatarUrl}
          className="publisher-entity-modules-page__avatar"
        />
        <span className="publisher-entity-modules-page__identity">
          <strong>
            {entity.title.trim() || (entity.entityType === 'channel' ? 'Канал' : 'Чат')}
          </strong>
          <small>{entity.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
        </span>
        <button
          type="button"
          className={cn(
            'publisher-entity-modules-page__refresh',
            entityQuery.isFetching && 'is-refreshing',
          )}
          aria-label="Перезагрузить данные модулей"
          title="Перезагрузить данные"
          disabled={busy}
          onClick={() => void Promise.all([entityQuery.refetch(), vkCapabilityQuery.refetch()])}
        >
          <Refresh aria-hidden />
        </button>
      </header>

      <div
        className={cn('publisher-entity-modules-page__readiness', `is-${readiness.tone}`)}
        aria-live={entityRecheckPhase ? 'polite' : undefined}
      >
        {entity.readiness.canPublish ? <CheckCircle aria-hidden /> : <WarningCircle aria-hidden />}
        <span className="publisher-entity-modules-page__readiness-copy">
          <strong>{readiness.label}</strong>
          {!entity.readiness.canPublish ? <small>{readiness.detail}</small> : null}
        </span>
        {canRecheckEntity ? (
          <button
            type="button"
            className={cn(
              'publisher-entity-modules-page__recheck',
              entityRecheckPhase && 'is-refreshing',
            )}
            disabled={busy}
            onClick={() => void handleEntityRecheck()}
          >
            <Refresh aria-hidden />
            <span>
              {entityRecheckPhase === 'enqueueing'
                ? 'Запускаю'
                : entityRecheckPhase === 'polling'
                  ? 'Проверяю'
                  : 'Проверить'}
            </span>
          </button>
        ) : null}
      </div>

      <div className="publisher-entity-modules-page__modules">
        <article className="publisher-entity-module">
          <span className="publisher-entity-module__icon is-posting" aria-hidden>
            <Post />
          </span>
          <span className="publisher-entity-module__copy">
            <strong>Постинг</strong>
            <small>{entity.readiness.canPublish ? 'Доступен' : 'Недоступен'}</small>
          </span>
          {entity.readiness.canPublish ? (
            <Link
              to={buildPublisherComposeRoute(entity)}
              className="publisher-entity-module__action"
              aria-label={`Создать пост для ${entity.title || entity.id}`}
            >
              <span>Создать</span>
              <NavArrowRight aria-hidden />
            </Link>
          ) : (
            <span className="publisher-entity-module__blocked">Недоступен</span>
          )}
        </article>

        {entity.entityType === 'chat' && chatComments ? (
          <article className="publisher-entity-module is-settings">
            <div className="publisher-entity-module__heading">
              <span className="publisher-entity-module__icon is-comments" aria-hidden>
                <ChatBubble />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Комментарии</strong>
                <small>{chatComments.commentsEnabled ? 'Вкл' : 'Выкл'}</small>
              </span>
              <ModuleSwitch
                checked={chatComments.commentsEnabled}
                disabled={mutation.isPending}
                label={`${chatComments.commentsEnabled ? 'Выключить' : 'Включить'} комментарии`}
                onChange={(enabled) =>
                  saveChatCommentSetting(chatComments, 'commentsEnabled', enabled)
                }
              />
            </div>
            <div className="publisher-entity-module__settings">
              <div className="publisher-entity-module__setting">
                <span>Сообщения администраторов</span>
                <ModuleSwitch
                  checked={chatComments.commentsAdminsEnabled}
                  disabled={mutation.isPending}
                  label="Комментарии для сообщений администраторов"
                  onChange={(enabled) =>
                    saveChatCommentSetting(chatComments, 'commentsAdminsEnabled', enabled)
                  }
                />
              </div>
              <div className="publisher-entity-module__setting">
                <span>Посты Публика</span>
                <ModuleSwitch
                  checked={chatComments.commentsChatBroadcastsEnabled}
                  disabled={mutation.isPending}
                  label="Комментарии для постов Публика"
                  onChange={(enabled) =>
                    saveChatCommentSetting(chatComments, 'commentsChatBroadcastsEnabled', enabled)
                  }
                />
              </div>
            </div>
          </article>
        ) : null}

        {entity.entityType === 'channel' ? (
          <section className="publisher-suggestions-module">
            <article className="publisher-entity-module">
              <span className="publisher-entity-module__icon is-suggestions" aria-hidden>
                <ChatBubble />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Предложки</strong>
                <small>{entity.moduleSettings.channelSuggestionsEnabled ? 'Вкл' : 'Выкл'}</small>
              </span>
              <ModuleSwitch
                checked={entity.moduleSettings.channelSuggestionsEnabled === true}
                disabled={mutation.isPending}
                label={`${entity.moduleSettings.channelSuggestionsEnabled ? 'Выключить' : 'Включить'} предложки`}
                onChange={(channelSuggestionsEnabled) =>
                  mutation.mutate({ channelSuggestionsEnabled })
                }
              />
            </article>

            <Suspense
              fallback={
                <div className="publisher-suggestions-state" role="status">
                  <Refresh className="is-refreshing" aria-hidden />
                  <span>Загружаю предложки</span>
                </div>
              }
            >
              <LazyPublisherSuggestionsInbox
                api={api}
                entityId={entity.id}
                enabled={entity.moduleSettings.channelSuggestionsEnabled === true}
              />
            </Suspense>
          </section>
        ) : null}

        <section className="publisher-entity-vk-module" data-publisher-module="vk">
          <div className="publisher-entity-module">
            <span className="publisher-entity-module__icon is-vk" aria-hidden>
              <Download />
            </span>
            <span className="publisher-entity-module__copy">
              <strong>Посты из VK</strong>
              <small>{vkStatus}</small>
            </span>
            <button
              type="button"
              className={cn('publisher-entity-module__action', vkOpen && 'is-open')}
              aria-label={vkOpen ? 'Закрыть посты из VK' : 'Открыть посты из VK'}
              aria-expanded={vkOpen}
              aria-controls="publisher-vk-workspace"
              disabled={!vkAvailable}
              onClick={() => setVkOpen((current) => !current)}
            >
              <span>{vkOpen ? 'Закрыть' : 'Открыть'}</span>
              <NavArrowRight aria-hidden />
            </button>
          </div>
          {vkOpen && vkAvailable ? (
            <div
              id="publisher-vk-workspace"
              className="publisher-entity-vk-module__workspace vk-parsing-surface"
            >
              <Suspense
                fallback={
                  <div className="publisher-entity-vk-module__loading" role="status">
                    <Refresh className="is-refreshing" aria-hidden />
                    <span>Загружаю VK</span>
                  </div>
                }
              >
                <LazyVkParsingCard
                  api={api}
                  chatId={entity.id}
                  entityType={entity.entityType}
                  active={vkOpen && vkAvailable}
                  channelLinkUrl={entity.entityUrl ?? undefined}
                />
              </Suspense>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}
