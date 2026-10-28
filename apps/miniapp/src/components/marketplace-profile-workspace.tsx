import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceProfileStateSchema,
  marketplaceProfileMutationSchema,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { EntityAvatar } from './ui/entity-avatar';
import { marketplaceTargetFromLink, openMarketplace } from '../lib/marketplace-launch';
import { ApiRequestError } from '../lib/api-request-error';
import {
  marketplaceDetails,
  mergeMarketplaceMutationState,
  marketplaceProfilePath,
  marketplaceProfileAvailable,
  marketplaceQueryKey,
  marketplaceProfileView,
  marketplaceRetryInterval,
  marketplaceProfileError,
  isMarketplaceAccessPending,
  type MarketplaceDetails,
} from '../lib/marketplace-profile-view';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type Action = 'save' | 'publish' | 'pause';
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
  const dirty = draft !== null && JSON.stringify(draft.details) !== JSON.stringify(draft.original);
  const mutation = useMutation({
    mutationFn: async ({ action }: { action: Action }) => {
      if (!state) throw new Error('Сначала проверьте состояние профиля');
      const change = {
        action,
        expectedRevision: action === 'save' ? (draft?.revision ?? state.revision) : state.revision,
        ...(action === 'save' ? { details: draft?.details ?? marketplaceDetails(state) } : {}),
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
        setEditing(false);
        setNotice('Профиль сохранён.');
      } else setNotice('');
      void cache.invalidateQueries({ queryKey });
      void cache.invalidateQueries({
        queryKey: ['marketplace-entry', profile, entityType, entityId],
      });
      void cache.invalidateQueries({
        queryKey: ['marketplace-button-policy', profile, entityType, entityId],
      });
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
              ? 'Проверка задерживается. Попробуйте позже.'
              : 'Проверяем ваши права…'
            : query.error instanceof ApiRequestError && query.error.status === 403
              ? 'Проверьте права администратора и подключение бота.'
              : 'Не удалось загрузить профиль. Попробуйте ещё раз.'}
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
    marketplaceProfileAvailable(state) &&
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
  const profileUnavailable = !marketplaceProfileAvailable(state);
  const stats = state.statistics;
  const openLink = (url: string | null | undefined) => {
    const target = url ? marketplaceTargetFromLink(url, state.kind, state.entityId) : null;
    if (!target) return;
    void openMarketplace(api, target).catch(() =>
      setNotice('Не удалось открыть Биржик. Попробуйте ещё раз.'),
    );
  };
  const placementCopy = {
    BOT_REQUIRED: 'Для рекламы и взаимопиара подключите бота «Биржика».',
    SETUP_REQUIRED: 'Бот подключён. Настройте предложения для размещений.',
    READY: 'Можно принимать заявки.',
    UNAVAILABLE: 'Размещения сейчас недоступны. Проверьте настройки в «Биржике».',
  }[view.placement];
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
            ? 'Проверяем ваши права…'
            : query.isError
              ? 'Не удалось обновить профиль. Показаны прежние данные, изменения остались в форме.'
              : 'Проверьте права администратора и подключение бота.'}
        </p>
      )}
      {profileUnavailable && (
        <p className="marketplace-profile__notice" role="status">
          Профиль пока недоступен.
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
          {conflict && (
            <div className="marketplace-profile__notice" role="alert">
              <p>
                Профиль изменился. Ваш ввод сохранён. Сравните его с новой версией перед
                сохранением.
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
              К профилю
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
          {!published && (
            <>
              <p className="marketplace-profile-card__intro">
                Опубликованный профиль будет виден всем посетителям Биржика.
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
                  {profileUnavailable
                    ? 'Публикация пока недоступна. Проверьте состояние позже.'
                    : view.publicState === 'REVIEW'
                      ? 'Профиль проходит проверку.'
                      : 'Проверьте состояние профиля перед публикацией.'}
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
                  published && view.active && !profileUnavailable
                    ? 'button button--accent'
                    : 'button button--ghost'
                }
                disabled={busy}
                onClick={() => {
                  setHandoff(true);
                  openLink(state.capabilities?.connectUrl);
                }}
              >
                Подключить бота «Биржика»
              </button>
            ) : state.capabilities?.manageUrl && view.placement !== 'READY' ? (
              <button
                className={
                  published && view.active && !profileUnavailable
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
                Завершите подключение в «Биржике», затем вернитесь и нажмите «Проверить состояние».
              </p>
            )}
          </section>
          <section className="marketplace-profile__section" aria-label="Статистика аудитории">
            <h3>История аудитории</h3>
            <p>
              {profileUnavailable
                ? 'История пока недоступна.'
                : !stats || stats.state === 'PENDING'
                  ? 'История загружается.'
                  : stats.state === 'AVAILABLE'
                    ? `Дней со статистикой: ${stats.observedDays}`
                    : 'За последние 90 дней статистики пока нет.'}
            </p>
            {stats?.from && stats.to && !profileUnavailable && (
              <p className="marketplace-profile-card__intro">
                Период:{' '}
                {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(
                  new Date(stats.from),
                )}{' '}
                —{' '}
                {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(
                  new Date(stats.to),
                )}
              </p>
            )}
            {stats?.lastObservedAt && !profileUnavailable && (
              <p className="marketplace-profile-card__intro">
                Обновлено:{' '}
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
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {mutation.isError && (
        <p role="alert">
          {marketplaceProfileError(
            mutation.error,
            'Сохранение не подтверждено. Ваш ввод остался в форме. Проверьте состояние и повторите.',
          )}
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
