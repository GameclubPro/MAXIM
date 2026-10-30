import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceProfileStateSchema,
  marketplaceProfileMutationSchema,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { EntityAvatar } from './ui/entity-avatar';
import { AppIcon } from './ui/app-icon';
import { MarketplaceEditorActions } from './marketplace-editor-actions';
import { marketplaceTargetFromLink, openMarketplace } from '../lib/marketplace-launch';
import { ApiRequestError } from '../lib/api-request-error';
import {
  marketplaceDetails,
  mergeMarketplaceMutationState,
  marketplaceProfilePath,
  marketplaceProfileAvailable,
  marketplaceQueryKey,
  marketplaceProfileView,
  marketplaceProfileOverview,
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
  entityTitle,
  entityAvatarUrl,
  profile,
  screen,
  canManage,
  manageUnavailableReason,
  onRecheckAccess,
  recheckingAccess,
  onOpenProfile,
  onDirtyChange,
  onBusyChange,
  resetDraftVersion,
  onDraftChange,
  onPublished,
  onRequestExternalNavigation,
}: MarketplaceProfileCardProps & {
  screen: 'overview' | 'profile';
  canManage: boolean;
  manageUnavailableReason?: string;
  onRecheckAccess: () => void;
  recheckingAccess: boolean;
  onOpenProfile: (opener?: HTMLElement) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  resetDraftVersion: number;
  onDraftChange: () => void;
  onPublished: () => void;
  onRequestExternalNavigation: (navigate: () => void) => void;
}) {
  const cache = useQueryClient();
  const queryKey = marketplaceQueryKey(profile, entityType, entityId);
  const path = marketplaceProfilePath(profile, entityType, entityId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [, updateAccessClock] = useState(0);
  const previousReset = useRef(resetDraftVersion);
  const manageAllowed = useRef(canManage);
  manageAllowed.current = canManage;
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const waitingAttempts = useRef(0);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!manageAllowed.current) throw new Error('Сначала проверьте доступ к профилю');
      try {
        const result = marketplaceProfileStateSchema.parse(await api.request(path, { signal }));
        waitingAttempts.current =
          result.binding.state === 'UNKNOWN' ? waitingAttempts.current + 1 : 0;
        return result;
      } catch (error) {
        waitingAttempts.current++;
        throw error;
      }
    },
    enabled: canManage,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) => {
      if (!canManage) return false;
      if (q.state.error instanceof ApiRequestError && q.state.error.status === 403) return false;
      return marketplaceRetryInterval(
        waitingAttempts.current,
        q.state.data?.binding.state === 'UNKNOWN' || q.state.error !== null,
      );
    },
  });
  const state = query.data;
  useEffect(() => {
    if (!canManage)
      void cache.cancelQueries({ queryKey: marketplaceQueryKey(profile, entityType, entityId) });
  }, [cache, canManage, profile, entityType, entityId]);
  useEffect(() => {
    if (!canManage || !state?.binding.validUntil) return;
    const delay = Date.parse(state.binding.validUntil) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(
      () => {
        updateAccessClock((value) => value + 1);
        if (manageAllowed.current) void query.refetch();
      },
      Math.min(delay + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [canManage, state?.binding.validUntil, query.refetch]);
  const dirty = draft !== null && JSON.stringify(draft.details) !== JSON.stringify(draft.original);
  const mutation = useMutation({
    mutationFn: async ({ action }: { action: Action }) => {
      if (!manageAllowed.current) throw new Error('Сначала проверьте доступ к профилю');
      if (!state) throw new Error('Сначала проверьте состояние профиля');
      if (action !== 'save' && dirty) throw new Error('Сначала сохраните изменения профиля');
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
      if (variables.action === 'save' && manageAllowed.current) {
        setDraft(null);
        setNotice('Профиль сохранён.');
      } else setNotice('');
      if (variables.action === 'publish' && manageAllowed.current) onPublished();
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
    if (previousReset.current === resetDraftVersion) return;
    previousReset.current = resetDraftVersion;
    setDraft(null);
    setNotice('');
    attempt.current = null;
    // FLAG: Discarding local input does not undo a write whose response was lost.
    if (mutation.isError && mutation.variables?.action === 'save') void query.refetch();
    mutation.reset();
  }, [resetDraftVersion, mutation.reset, mutation.isError, mutation.variables, query.refetch]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(mutation.isPending || linkBusy);
  }, [mutation.isPending, linkBusy, onBusyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
      onBusyChange(false);
    },
    [onDirtyChange, onBusyChange],
  );
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
    if (!canManage) {
      onRecheckAccess();
      return;
    }
    waitingAttempts.current = 0;
    void query.refetch();
  };
  const waiting =
    canManage &&
    (query.isPending ||
      isMarketplaceAccessPending(query.error) ||
      state?.binding.state === 'UNKNOWN');
  if (!state)
    return (
      <div className="marketplace-profile">
        <p role={waiting ? 'status' : 'alert'}>
          {!canManage
            ? manageUnavailableReason || 'Доступ к изменению профиля не подтверждён.'
            : waiting
              ? waitingAttempts.current >= 4
                ? 'Проверка задерживается. Попробуйте позже.'
                : 'Проверяем ваши права…'
              : query.error instanceof ApiRequestError && query.error.status === 403
                ? 'Проверьте права администратора и подключение бота.'
                : 'Не удалось загрузить профиль. Попробуйте ещё раз.'}
        </p>
        {(!canManage || !query.isPending) && (
          <button
            className="button button--ghost"
            disabled={query.isFetching || recheckingAccess}
            onClick={refresh}
          >
            Проверить снова
          </button>
        )}
      </div>
    );
  const view = marketplaceProfileView(state, canManage && !query.isError);
  const overview = marketplaceProfileOverview(state, canManage && !query.isError);
  const details = draft?.details ?? marketplaceDetails(state);
  const formId = `marketplace-profile-form-${profile}-${entityType}-${entityId}`;
  const conflict = draft !== null && draft.revision !== state.revision;
  const busy = mutation.isPending || linkBusy;
  const canSave =
    canManage &&
    view.canEdit &&
    marketplaceProfileAvailable(state) &&
    details.title.trim() &&
    details.topic &&
    details.region &&
    !busy &&
    !conflict &&
    (!state.listing || dirty);
  const edit = (key: keyof MarketplaceDetails, value: string) => {
    if (!canManage || details[key] === value) return;
    onDraftChange();
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
    if (!canManage || !target || busy) return;
    onRequestExternalNavigation(() => {
      if (!manageAllowed.current) return;
      setLinkBusy(true);
      setNotice('');
      void openMarketplace(api, target)
        .catch(() => setNotice('Не удалось открыть Биржик. Попробуйте ещё раз.'))
        .finally(() => setLinkBusy(false));
    });
  };
  const mainAction = overview.primary;
  const showMainAction =
    !!mainAction && !(mainAction.kind === 'refresh' && waiting && waitingAttempts.current < 4);
  const runMainAction = (opener?: HTMLElement) => {
    if (!mainAction || busy) return;
    if (mainAction.kind === 'profile') {
      onOpenProfile(opener);
    } else if (mainAction.kind === 'publish' && !dirty) mutation.mutate({ action: 'publish' });
    else if (mainAction.kind === 'refresh') refresh();
    else if ('url' in mainAction) openLink(mainAction.url);
  };
  return (
    <div className="marketplace-profile" data-marketplace-screen={screen}>
      <div className="marketplace-profile__hero">
        <EntityAvatar
          title={entityTitle || state.binding.metadata.title || details.title}
          entityType={entityType}
          avatarUrl={entityAvatarUrl ?? state.binding.metadata.imageUrl}
        />
        <div>
          <strong>
            {entityTitle || state.binding.metadata.title || details.title || 'Профиль площадки'}
          </strong>
          <small>{screen === 'overview' ? overview.status : view.title}</small>
        </div>
      </div>
      {!canManage && screen === 'profile' ? (
        <p className="marketplace-profile__notice" role="status">
          {manageUnavailableReason || 'Доступ к изменению профиля не подтверждён.'}
          {dirty && ' Ваш ввод сохранён.'}
        </p>
      ) : (
        screen === 'profile' &&
        (query.isError || !view.active) && (
          <p className="marketplace-profile__notice" role="status">
            {waiting
              ? 'Проверяем ваши права…'
              : query.isError
                ? 'Не удалось обновить профиль. Показаны прежние данные, изменения остались в форме.'
                : 'Проверьте права администратора и подключение бота.'}
          </p>
        )
      )}
      {canManage && screen === 'profile' && profileUnavailable && (
        <p className="marketplace-profile__notice" role="status">
          Профиль пока недоступен.
        </p>
      )}
      {screen === 'overview' ? (
        <>
          {mainAction?.kind === 'publish' && (
            <p className="marketplace-profile-card__intro">Профиль будет виден в Биржике.</p>
          )}
          {showMainAction && (
            <button
              type="button"
              className="button button--accent"
              data-marketplace-action="primary"
              disabled={
                busy ||
                (mainAction!.kind === 'publish' && dirty) ||
                (mainAction!.kind === 'refresh' && (query.isFetching || recheckingAccess))
              }
              onClick={(event) => runMainAction(event.currentTarget)}
            >
              {busy ? 'Подождите…' : mainAction!.label}
              {'url' in mainAction! && <AppIcon icon="ArrowUpRight" aria-hidden />}
            </button>
          )}
          {overview.placementNote && (
            <div className="marketplace-profile__placement">
              <p className="marketplace-profile__placement-note">{overview.placementNote}</p>
              {overview.placementAction && (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => openLink(overview.placementAction!.url)}
                >
                  {overview.placementAction.label}
                  <AppIcon icon="ArrowUpRight" aria-hidden />
                </button>
              )}
            </div>
          )}
          {(overview.showProfileSettings || overview.conditionsAction) && (
            <div className="marketplace-profile__navigation">
              {overview.showProfileSettings && (
                <button
                  type="button"
                  className="marketplace-profile__nav-row"
                  data-marketplace-action="profile"
                  disabled={busy}
                  onClick={(event) => onOpenProfile(event.currentTarget)}
                >
                  <AppIcon icon="EditPencil" aria-hidden />
                  <span>Настройки карточки</span>
                  <AppIcon icon="NavArrowRight" aria-hidden />
                </button>
              )}
              {overview.conditionsAction && (
                <button
                  type="button"
                  className="marketplace-profile__nav-row"
                  data-marketplace-action="conditions"
                  disabled={busy}
                  onClick={() => openLink(overview.conditionsAction!.url)}
                >
                  <AppIcon icon="Shop" aria-hidden />
                  <span>{overview.conditionsAction.label}</span>
                  <AppIcon icon="ArrowUpRight" aria-hidden />
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <form
            id={formId}
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
                data-marketplace-field="profile-title"
                value={details.title}
                maxLength={300}
                required
                readOnly={!canManage || !view.canEdit}
                disabled={busy}
                onChange={(event) => edit('title', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Описание</span>
              <textarea
                aria-label="Описание"
                data-marketplace-field="profile-description"
                value={details.description}
                maxLength={1500}
                readOnly={!canManage || !view.canEdit}
                disabled={busy}
                onChange={(event) => edit('description', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Тематика</span>
              <select
                aria-label="Тематика"
                data-marketplace-field="profile-topic"
                value={details.topic}
                required
                disabled={busy || !canManage || !view.canEdit}
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
                data-marketplace-field="profile-region"
                value={details.region}
                required
                disabled={busy || !canManage || !view.canEdit}
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
            {canManage && conflict && (
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
            {canManage && !view.active && (
              <p className="marketplace-profile-card__intro">
                Сохранение станет доступно после проверки прав.
              </p>
            )}
          </form>
          {(dirty || !state.listing) && (
            <MarketplaceEditorActions>
              <button
                className="button button--accent"
                disabled={!canSave}
                type="submit"
                form={formId}
              >
                {busy ? 'Сохраняем…' : state.listing ? 'Сохранить изменения' : 'Создать черновик'}
              </button>
            </MarketplaceEditorActions>
          )}
          {canManage && state.listing && !published && view.publicState !== 'REVIEW' && (
            <>
              <p className="marketplace-profile-card__intro">Профиль будет виден в Биржике.</p>
              <button
                className="button button--accent"
                disabled={!view.canPublish || busy || dirty}
                onClick={() => mutation.mutate({ action: 'publish' })}
              >
                {state.listing!.status === 'PAUSED' ? 'Опубликовать снова' : 'Опубликовать профиль'}
              </button>
              {!view.canPublish && (
                <p className="marketplace-profile-card__intro">
                  {profileUnavailable
                    ? 'Публикация пока недоступна. Проверьте состояние позже.'
                    : 'Проверьте состояние профиля перед публикацией.'}
                </p>
              )}
            </>
          )}
          {canManage && state.listing && view.active && (
            <details className="marketplace-profile__history">
              <summary>История аудитории</summary>
              <div className="marketplace-profile__section">
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
                    {new Intl.DateTimeFormat('ru-RU', {
                      dateStyle: 'medium',
                      timeZone: 'UTC',
                    }).format(new Date(stats.from))}{' '}
                    —{' '}
                    {new Intl.DateTimeFormat('ru-RU', {
                      dateStyle: 'medium',
                      timeZone: 'UTC',
                    }).format(new Date(stats.to))}
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
              </div>
            </details>
          )}
          {published && (
            <div className="marketplace-profile__actions">
              <button
                className="button button--ghost"
                disabled={busy || dirty || !view.canPause}
                onClick={() => mutation.mutate({ action: 'pause' })}
              >
                Скрыть профиль
              </button>
            </div>
          )}
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
      {screen === 'profile' &&
        (query.isError || !view.active || profileUnavailable || mutation.isError) && (
          <button
            type="button"
            className="button button--ghost"
            disabled={busy || query.isFetching || recheckingAccess}
            onClick={refresh}
          >
            {query.isError || mutation.isError ? 'Повторить' : 'Проверить доступ'}
          </button>
        )}
    </div>
  );
}
