import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceProfileStateSchema,
  marketplaceProfileMutationSchema,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { EntityAvatar } from './ui/entity-avatar';
import { openMaxBotLink } from '../lib/max-bridge';
import { describeUserFacingError } from '../lib/user-facing-error';
import { ApiRequestError } from '../lib/api-request-error';
import {
  marketplaceDetails,
  mergeMarketplaceMutationState,
  marketplaceProfilePath,
  marketplaceQueryKey,
  marketplaceProfileView,
  marketplaceRetryInterval,
  isMarketplaceAccessPending,
  type MarketplaceDetails,
} from '../lib/marketplace-profile-view';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type Action = 'save' | 'publish' | 'pause' | 'toggle' | 'revoke';
type Draft = { details: MarketplaceDetails; original: MarketplaceDetails; revision: number };

export default function MarketplaceProfileWorkspace({
  api,
  entityId,
  entityType,
  profile,
  onDirtyChange,
  onBusyChange,
}: MarketplaceProfileCardProps & {
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const cache = useQueryClient();
  const queryKey = marketplaceQueryKey(profile, entityType, entityId);
  const path = marketplaceProfilePath(profile, entityType, entityId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState('');
  const [handoff, setHandoff] = useState(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const waitingAttempts = useRef(0);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const result = marketplaceProfileStateSchema.parse(await api.request(path));
        waitingAttempts.current =
          result.binding.state === 'UNKNOWN' ? waitingAttempts.current + 1 : 0;
        return result;
      } catch (error) {
        waitingAttempts.current++;
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (q.state.error instanceof ApiRequestError && q.state.error.status === 403) return false;
      return marketplaceRetryInterval(
        waitingAttempts.current,
        q.state.data?.binding.state === 'UNKNOWN' || q.state.error !== null,
      );
    },
  });
  const state = query.data;
  const dirty =
    (draft !== null && JSON.stringify(draft.details) !== JSON.stringify(draft.original)) || consent;
  const mutation = useMutation({
    mutationFn: async ({ action, appendEnabled }: { action: Action; appendEnabled?: boolean }) => {
      if (!state) throw new Error('Сначала проверьте состояние профиля');
      const change = {
        action,
        expectedRevision:
          action === 'toggle' || action === 'revoke'
            ? state.appendRevision
            : action === 'save'
              ? (draft?.revision ?? state.revision)
              : state.revision,
        ...(action === 'save' ? { details: draft?.details ?? marketplaceDetails(state) } : {}),
        ...(action === 'toggle' ? { appendEnabled } : {}),
        ...(action === 'save' && consent ? { statisticsConsent: true as const } : {}),
      };
      const fingerprint = JSON.stringify(change);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      return marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify(
            marketplaceProfileMutationSchema.parse({ ...change, requestId: attempt.current.id }),
          ),
        }),
      );
    },
    onSuccess: (result, variables) => {
      cache.setQueryData(queryKey, (previous: MarketplaceProfileState | undefined) =>
        mergeMarketplaceMutationState(result, previous),
      );
      attempt.current = null;
      if (variables.action === 'save') {
        setDraft(null);
        setConsent(false);
        setEditing(false);
        setNotice('Профиль сохранён.');
      } else if (variables.action === 'revoke') {
        setConsent(false);
        setNotice('Обмен статистикой отключён.');
      } else setNotice('');
      void cache.invalidateQueries({ queryKey });
    },
    onError: () => void cache.invalidateQueries({ queryKey }),
  });
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(mutation.isPending);
  }, [mutation.isPending, onBusyChange]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const refresh = () => {
    waitingAttempts.current = 0;
    void query.refetch();
  };
  const waiting =
    query.isPending ||
    isMarketplaceAccessPending(query.error) ||
    state?.binding.state === 'UNKNOWN';
  if (!state)
    return (
      <div className="marketplace-profile">
        <p role={waiting ? 'status' : 'alert'}>
          {waiting
            ? waitingAttempts.current >= 4
              ? 'Проверка задерживается. Можно вернуться позже или проверить снова.'
              : 'Проверяем ваши права…'
            : query.error instanceof ApiRequestError && query.error.status === 403
              ? 'Доступ не подтверждён. Проверьте свои права администратора и подключение бота этого сервиса.'
              : 'Не удалось получить состояние профиля. Проверьте соединение и повторите.'}
        </p>
        {!query.isPending && (
          <button className="button button--ghost" disabled={query.isFetching} onClick={refresh}>
            Проверить снова
          </button>
        )}
      </div>
    );
  const view = marketplaceProfileView(state, !query.isError);
  const details = draft?.details ?? marketplaceDetails(state);
  const formOpen = !state.listing || editing;
  const conflict = draft !== null && draft.revision !== state.revision;
  const busy = mutation.isPending;
  const canSave =
    view.canEdit &&
    (state.binding.statisticsConsent || consent) &&
    details.title.trim() &&
    details.topic &&
    details.region &&
    !busy &&
    !conflict &&
    (!state.listing || dirty);
  const edit = (key: keyof MarketplaceDetails, value: string) => {
    setDraft({
      details: { ...details, [key]: value },
      original: draft?.original ?? marketplaceDetails(state),
      revision: draft?.revision ?? state.revision,
    });
    setNotice('');
  };
  const published = state.listing?.status === 'PUBLISHED';
  const noConsent = !state.binding.statisticsConsent;
  const stats = state.statistics;
  const openLink = (url: string | null | undefined) => {
    if (url) openMaxBotLink(url);
  };
  const placementCopy = {
    BOT_REQUIRED: 'Для рекламы и взаимопиара подключите бота «Связки».',
    SETUP_REQUIRED: 'Бот подключён. Настройте предложения для размещений.',
    READY:
      'Можно принимать заявки. Публикации требуют согласованных условий и отдельных разрешений.',
    UNAVAILABLE: 'Размещения сейчас недоступны. Проверьте настройки в «Связке».',
  }[view.placement];
  const reconnectConsent = (
    <label className="marketplace-profile__consent">
      <input
        type="checkbox"
        checked={consent}
        disabled={busy || !view.active}
        onChange={(event) => setConsent(event.target.checked)}
      />
      <span>
        Разрешаю передавать статистику этой площадки из MAXIM в «Связку» за последние 90 дней и
        обновлять её. Списки участников и тексты сообщений не передаются.
      </span>
    </label>
  );
  return (
    <div className="marketplace-profile">
      <div className="marketplace-profile__hero">
        <EntityAvatar
          title={details.title}
          entityType={entityType}
          avatarUrl={state.binding.metadata.imageUrl}
        />
        <div>
          <strong>{details.title || 'Профиль площадки'}</strong>
          <small>{view.title}</small>
        </div>
      </div>
      {(query.isError || !view.active) && (
        <p className="marketplace-profile__notice" role="status">
          {waiting
            ? 'Проверяем ваши права. Подключение ещё не подтверждено.'
            : query.isError
              ? 'Не удалось обновить состояние. Показаны последние полученные данные; введённые изменения сохранены в форме.'
              : noConsent
                ? 'Кнопка публикаций отключена. Для возобновления обмена сначала проверьте права.'
                : 'Доступ не подтверждён. Проверьте права администратора и подключение бота этого сервиса.'}
        </p>
      )}
      {formOpen ? (
        <form
          className="marketplace-profile__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) mutation.mutate({ action: 'save' });
          }}
        >
          <label className="field">
            <span>Название</span>
            <input
              aria-label="Название"
              value={details.title}
              maxLength={300}
              required
              disabled={busy}
              onChange={(event) => edit('title', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Описание</span>
            <textarea
              aria-label="Описание"
              value={details.description}
              maxLength={1500}
              disabled={busy}
              onChange={(event) => edit('description', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Тематика</span>
            <select
              aria-label="Тематика"
              value={details.topic}
              required
              disabled={busy}
              onChange={(event) => edit('topic', event.target.value)}
            >
              <option value="">Выберите тематику</option>
              {state.choices.topics.map((topic) => (
                <option key={topic} value={topic}>
                  {topic}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Регион</span>
            <select
              aria-label="Регион"
              value={details.region}
              required
              disabled={busy}
              onChange={(event) => edit('region', event.target.value)}
            >
              <option value="">Выберите регион</option>
              {state.choices.regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </label>
          {noConsent && reconnectConsent}
          {conflict && (
            <div className="marketplace-profile__notice" role="alert">
              <p>
                Профиль изменился во время редактирования. Ваш ввод сохранён. Проверьте новую версию
                перед сохранением своего варианта.
              </p>
              <dl className="marketplace-profile__facts">
                {Object.entries(marketplaceDetails(state)).map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {
                        {
                          title: 'Название',
                          description: 'Описание',
                          topic: 'Тематика',
                          region: 'Регион',
                        }[key]
                      }
                    </dt>
                    <dd>{value || 'Не заполнено'}</dd>
                  </div>
                ))}
              </dl>
              <button
                type="button"
                className="button button--ghost"
                onClick={() =>
                  setDraft(
                    (current) =>
                      current && {
                        ...current,
                        revision: state.revision,
                        original: marketplaceDetails(state),
                      },
                  )
                }
              >
                Использовать мой вариант
              </button>
            </div>
          )}
          {!view.active && (
            <p className="marketplace-profile-card__intro">
              Сохранение станет доступно после проверки прав.
            </p>
          )}
          <button className="button button--accent" disabled={!canSave} type="submit">
            {busy ? 'Сохраняем…' : state.listing ? 'Сохранить изменения' : 'Создать черновик'}
          </button>
          {state.listing && !dirty && (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
            >
              К сводке профиля
            </button>
          )}
        </form>
      ) : (
        <>
          <dl className="marketplace-profile__facts">
            <div>
              <dt>Тематика</dt>
              <dd>{state.listing!.topic}</dd>
            </div>
            <div>
              <dt>Регион</dt>
              <dd>{state.listing!.region}</dd>
            </div>
          </dl>
          {noConsent && (
            <div className="marketplace-profile__notice">
              <p>Обмен статистикой отключён. Новые замеры и кнопка в публикациях не добавляются.</p>
              <p>
                {state.listing!.profileOnly
                  ? published
                    ? 'Профиль без бота «Связки» недоступен посетителям до возобновления обмена.'
                    : 'Профиль не опубликован. Для его публикации понадобится согласие на статистику.'
                  : 'Публичность профиля проверяется отдельно в «Связке»; отзыв статистики не скрывает его автоматически.'}
              </p>
              {view.active && (
                <>
                  {reconnectConsent}
                  <button
                    className="button button--accent"
                    disabled={!consent || busy}
                    onClick={() => mutation.mutate({ action: 'save' })}
                  >
                    Возобновить обмен статистикой
                  </button>
                </>
              )}
            </div>
          )}
          {!published && (
            <>
              <p className="marketplace-profile-card__intro">
                После публикации профиль смогут открыть все посетители биржи. Это не разрешение на
                отправку рекламы.
              </p>
              <button
                className="button button--accent"
                disabled={!view.canPublish || busy || dirty}
                onClick={() => mutation.mutate({ action: 'publish' })}
              >
                {state.listing!.status === 'PAUSED'
                  ? 'Опубликовать снова'
                  : 'Опубликовать на бирже'}
              </button>
              {!view.canPublish && (
                <p className="marketplace-profile-card__intro">
                  {noConsent
                    ? 'Для публикации подтвердите передачу статистики.'
                    : view.publicState === 'REVIEW'
                      ? 'Публикация станет доступна после проверки биржи.'
                      : 'Публикация станет доступна после подтверждения состояния профиля.'}
                </p>
              )}
            </>
          )}
          {view.publicNow && view.placement === 'READY' && (
            <button
              className="button button--accent"
              onClick={() => openLink(state.listing?.publicUrl)}
            >
              Открыть профиль
            </button>
          )}
          <section className="marketplace-profile__section" aria-label="Размещения">
            <h3>Реклама и взаимопиар</h3>
            <p>{placementCopy}</p>
            {view.placement === 'BOT_REQUIRED' && state.capabilities?.connectUrl ? (
              <button
                className={
                  published && view.active && !noConsent
                    ? 'button button--accent'
                    : 'button button--ghost'
                }
                disabled={busy}
                onClick={() => {
                  setHandoff(true);
                  openLink(state.capabilities?.connectUrl);
                }}
              >
                Подключить бота «Связки»
              </button>
            ) : state.capabilities?.manageUrl && view.placement !== 'READY' ? (
              <button
                className={
                  published && view.active && !noConsent
                    ? 'button button--accent'
                    : 'button button--ghost'
                }
                disabled={busy}
                onClick={() => openLink(state.capabilities?.manageUrl)}
              >
                Настроить размещения
              </button>
            ) : null}
            {handoff && (
              <p role="status">
                В «Связке» добавьте бота в этот {entityType === 'channel' ? 'канал' : 'чат'} и
                завершите проверку. Вернитесь сюда и нажмите «Проверить состояние». Согласия на
                размещения настраиваются отдельно.
              </p>
            )}
          </section>
          <section className="marketplace-profile__section" aria-label="Статистика аудитории">
            <h3>История аудитории</h3>
            <p>
              {noConsent
                ? 'Передача новых замеров отключена.'
                : !stats || stats.state === 'PENDING'
                  ? 'История загружается.'
                  : stats.state === 'AVAILABLE'
                    ? `Даты с замерами: ${stats.observedDays} за период истории.`
                    : 'За последние 90 дней замеров аудитории пока нет.'}
            </p>
            {stats?.from && stats.to && !noConsent && (
              <p className="marketplace-profile-card__intro">
                Период:{' '}
                {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(
                  new Date(stats.from),
                )}{' '}
                —{' '}
                {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(
                  new Date(stats.to),
                )}
                . Даты статистики — UTC.
              </p>
            )}
            {stats?.lastObservedAt && !noConsent && (
              <p className="marketplace-profile-card__intro">
                Последний замер:{' '}
                {new Intl.DateTimeFormat('ru-RU', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'Europe/Moscow',
                }).format(new Date(stats.lastObservedAt))}{' '}
                МСК
              </p>
            )}
            {view.publicNow && view.placement !== 'READY' && (
              <button
                className="button button--ghost"
                onClick={() => openLink(state.listing?.publicUrl)}
              >
                Открыть профиль
              </button>
            )}
          </section>
          <div className="marketplace-profile__actions">
            <button
              className="button button--ghost"
              disabled={busy || !view.canEdit}
              onClick={() => setEditing(true)}
            >
              Изменить профиль
            </button>
            {view.placement === 'READY' && state.capabilities?.manageUrl && (
              <button
                className="button button--ghost"
                onClick={() => openLink(state.capabilities?.manageUrl)}
              >
                Настройки размещений
              </button>
            )}
            {published && (
              <button
                className="button button--ghost"
                disabled={busy || !view.canPause}
                onClick={() => mutation.mutate({ action: 'pause' })}
              >
                Скрыть профиль
              </button>
            )}
          </div>
          <label className="marketplace-profile__toggle">
            <span>
              <strong>Кнопка «Профиль на бирже»</strong>
              <small>
                В новых публикациях {profile === 'publisher' ? 'Публика' : 'ботов Майора'} в этом{' '}
                {entityType === 'channel' ? 'канале' : 'чате'}.
              </small>
            </span>
            <span className="marketplace-profile__switch">
              <input
                type="checkbox"
                checked={state.appendEnabled}
                disabled={busy || (!state.appendEnabled && !view.canAppend)}
                onChange={(event) =>
                  mutation.mutate({ action: 'toggle', appendEnabled: event.target.checked })
                }
              />
              <span className="marketplace-profile__track" aria-hidden />
            </span>
          </label>
          <p className="marketplace-profile-card__intro">
            Сообщения участников, личные превью и старые посты не меняются. Если профиль недоступен
            или для кнопки нет места, публикация отправится без неё.
            {!view.canAppend && !state.appendEnabled
              ? ' Для включения нужен доступный опубликованный профиль и согласие на статистику.'
              : ''}
          </p>
          {state.binding.statisticsConsent && (
            <button
              className="button button--ghost"
              disabled={busy}
              onClick={() => mutation.mutate({ action: 'revoke' })}
            >
              Отключить обмен статистикой
            </button>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {mutation.isError && (
        <p role="alert">
          {describeUserFacingError(
            mutation.error,
            'Не удалось сохранить изменение. Введённые данные сохранены; проверьте состояние и повторите.',
          )}
        </p>
      )}
      {state.buttonDiagnostic === 'KEYBOARD_FULL' && (
        <p className="marketplace-profile__notice" role="status">
          В последней публикации не хватило места для кнопки профиля. Остальные кнопки сохранены.
        </p>
      )}
      <button
        className="button button--ghost"
        disabled={busy || query.isFetching}
        onClick={refresh}
      >
        {view.active ? 'Проверить состояние' : 'Проверить права'}
      </button>
    </div>
  );
}
