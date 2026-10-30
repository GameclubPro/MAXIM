import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { marketplaceEntryResponseSchema } from '@maxim/contracts/marketplace-integration';
import { marketplaceEntityPath } from '../lib/marketplace-button-policy';
import { openMarketplace } from '../lib/marketplace-launch';
import {
  isMarketplaceAccessPending,
  marketplaceQueryKey,
  marketplaceRetryInterval,
} from '../lib/marketplace-profile-view';
import { ApiRequestError } from '../lib/api-request-error';
import MarketplaceProfileWorkspace from './marketplace-profile-workspace';
import MarketplaceEditorialWorkspace from './marketplace-editorial-workspace';
import MarketplaceButtonPolicy from './marketplace-button-policy';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';
import type { MarketplaceDrafts, MarketplaceScreen } from './marketplace-profile-panel';
import { AppIcon } from './ui/app-icon';
import { EntityAvatar } from './ui/entity-avatar';
import { SkeletonCard } from './ui/skeleton';

export default function MarketplaceEntryWorkspace({
  onBusyChange,
  onDraftsChange,
  onDraftChange,
  resetDraftVersion,
  onRequestExternalNavigation,
  screen,
  onScreenChange,
  ...props
}: MarketplaceProfileCardProps & {
  onBusyChange: (busy: boolean) => void;
  onDraftsChange: (drafts: MarketplaceDrafts) => void;
  onDraftChange: (screen: Exclude<MarketplaceScreen, 'overview'>) => void;
  resetDraftVersion: number;
  onRequestExternalNavigation: (navigate: () => void) => void;
  screen: MarketplaceScreen;
  onScreenChange: (screen: MarketplaceScreen, opener?: HTMLElement) => void;
}) {
  const { api, entityId, entityType, profile } = props;
  const [profileDirty, setProfileDirty] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [editorialDirty, setEditorialDirty] = useState(false);
  const [editorialBusy, setEditorialBusy] = useState(false);
  const [editorialVisited, setEditorialVisited] = useState(false);
  useEffect(
    () =>
      onDraftsChange({ profile: profileDirty, buttons: policyDirty, editorial: editorialDirty }),
    [profileDirty, policyDirty, editorialDirty, onDraftsChange],
  );
  const [profileBusy, setProfileBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [policyVisited, setPolicyVisited] = useState(false);
  const [ownerVisited, setOwnerVisited] = useState(false);
  const [, updateAccessClock] = useState(0);
  const attempts = useRef(0);
  const cache = useQueryClient();
  useEffect(() => {
    onBusyChange(profileBusy || policyBusy || editorialBusy || linkBusy);
  }, [profileBusy, policyBusy, editorialBusy, linkBusy, onBusyChange]);
  useEffect(
    () => () => {
      onBusyChange(false);
      onDraftsChange({ profile: false, buttons: false, editorial: false });
    },
    [onBusyChange, onDraftsChange],
  );
  useEffect(() => {
    let frame: number | null = null;
    const refresh = () => {
      if (document.visibilityState === 'hidden' || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        attempts.current = 0;
        for (const queryKey of [
          ['marketplace-entry', profile, entityType, entityId],
          ['marketplace-editorial', profile, entityType, entityId],
          marketplaceQueryKey(profile, entityType, entityId),
          ['marketplace-button-policy', profile, entityType, entityId],
        ])
          void cache.invalidateQueries({ queryKey });
      });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [cache, profile, entityType, entityId]);
  const query = useQuery({
    queryKey: ['marketplace-entry', profile, entityType, entityId],
    queryFn: async () => {
      try {
        const result = marketplaceEntryResponseSchema.parse(
          await api.request(marketplaceEntityPath(profile, entityType, entityId, 'entry')),
        );
        attempts.current = 0;
        return result;
      } catch (error) {
        attempts.current++;
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) =>
      q.state.error instanceof ApiRequestError && q.state.error.status === 403
        ? false
        : marketplaceRetryInterval(attempts.current, q.state.error !== null),
  });
  const state = query.data;
  const owner = !!state && (state.isOwner || state.canCreate);
  const entryUnexpired = !state?.validUntil || Date.parse(state.validUntil) > Date.now();
  const canManage = owner && !query.isError && entryUnexpired;
  useEffect(() => {
    if (owner) setOwnerVisited(true);
  }, [owner]);
  useEffect(() => {
    if (!state?.validUntil) return;
    const delay = Date.parse(state.validUntil) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(
      () => {
        updateAccessClock((value) => value + 1);
        void query.refetch();
      },
      Math.min(delay + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [state?.validUntil, query.refetch]);
  const waiting = query.isPending || isMarketplaceAccessPending(query.error);
  if (!state)
    return (
      <div className="marketplace-profile">
        {query.isPending ? (
          <div role="status" aria-label="Загрузка профиля">
            <SkeletonCard lines={3} />
          </div>
        ) : (
          <p role={waiting ? 'status' : 'alert'}>
            {waiting
              ? attempts.current >= 4
                ? 'Проверка задерживается. Попробуйте позже.'
                : 'Проверяем ваши права…'
              : query.error instanceof ApiRequestError && query.error.status === 403
                ? 'Доступ не подтверждён. Проверьте права администратора и подключение бота.'
                : 'Не удалось получить профиль. Проверьте соединение и повторите.'}
          </p>
        )}
        {!query.isPending && (
          <button
            className="button button--ghost"
            disabled={query.isFetching}
            onClick={() => {
              attempts.current = 0;
              void query.refetch();
            }}
          >
            Проверить снова
          </button>
        )}
      </div>
    );
  const publicNow =
    !query.isError &&
    entryUnexpired &&
    state.publicState === 'PUBLIC' &&
    !!state.listing?.publicUrl;
  const entryUnavailableReason = query.isError
    ? isMarketplaceAccessPending(query.error)
      ? 'Проверяем доступ к профилю.'
      : query.error instanceof ApiRequestError && [401, 403].includes(query.error.status)
        ? 'Проверьте права администратора и подключение бота.'
        : 'Не удалось проверить профиль. Повторите проверку.'
    : !entryUnexpired
      ? 'Состояние профиля устарело. Проверьте доступ.'
      : state.publicState === 'ACCESS_REQUIRED'
        ? 'Проверьте права администратора и подключение бота.'
        : undefined;
  const recheckEntry = () => {
    attempts.current = 0;
    void query.refetch();
  };
  return (
    <div className="marketplace-entry" data-marketplace-screen={screen}>
      <div
        className="marketplace-entry__overview"
        hidden={screen === 'buttons' || screen === 'editorial'}
      >
        {(owner || ownerVisited) && (
          <div hidden={!owner && screen !== 'profile'}>
            <MarketplaceProfileWorkspace
              {...props}
              canManage={canManage}
              manageUnavailableReason={
                owner ? entryUnavailableReason : 'Профилем управляет другой владелец.'
              }
              onRecheckAccess={recheckEntry}
              recheckingAccess={query.isFetching}
              screen={screen === 'profile' ? 'profile' : 'overview'}
              onOpenProfile={(opener) => onScreenChange('profile', opener)}
              onBusyChange={setProfileBusy}
              onDirtyChange={setProfileDirty}
              onDraftChange={() => onDraftChange('profile')}
              resetDraftVersion={resetDraftVersion}
              onPublished={() => onScreenChange('overview')}
              onRequestExternalNavigation={onRequestExternalNavigation}
            />
          </div>
        )}
        {!owner && screen !== 'profile' && (
          <div className="marketplace-profile">
            <div className="marketplace-profile__hero">
              <EntityAvatar
                title={props.entityTitle || state.listing?.title || 'Площадка'}
                entityType={entityType}
                avatarUrl={props.entityAvatarUrl}
              />
              <div>
                <strong>{props.entityTitle || state.listing?.title || 'Площадка'}</strong>
                <small>{publicNow ? 'Профиль опубликован' : 'Профиль недоступен'}</small>
              </div>
            </div>
            {publicNow && state.listing && (
              <button
                type="button"
                className="button button--accent"
                disabled={linkBusy}
                onClick={() => {
                  onRequestExternalNavigation(() => {
                    setLinkError(false);
                    setLinkBusy(true);
                    void openMarketplace(api, {
                      target: 'listing',
                      kind: state.kind,
                      entityId: state.entityId,
                      listingId: state.listing!.id,
                    })
                      .catch(() => setLinkError(true))
                      .finally(() => setLinkBusy(false));
                  });
                }}
              >
                Посмотреть профиль <AppIcon icon="ArrowUpRight" aria-hidden />
              </button>
            )}
            {!publicNow && !query.isError && (
              <p className="marketplace-profile-card__intro">Карточка скрыта от посетителей.</p>
            )}
            {linkError && <p role="alert">Не удалось открыть Биржик. Повторите переход.</p>}
          </div>
        )}
        {query.isError && !owner && screen !== 'profile' && (
          <div role="alert" className="marketplace-profile__notice">
            <p>Не удалось обновить профиль.</p>
            <button
              type="button"
              className="button button--ghost"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Повторить
            </button>
          </div>
        )}
        {screen === 'overview' && (
          <div className="marketplace-profile__navigation">
            {!state.canCreate && (
              <button
                type="button"
                className="marketplace-profile__nav-row"
                data-marketplace-action="editorial"
                disabled={query.isError || !entryUnexpired}
                onClick={(event) => {
                  setEditorialVisited(true);
                  onScreenChange('editorial', event.currentTarget);
                }}
              >
                <AppIcon icon="EditPencil" aria-hidden />
                <span>Изменить описание</span>
                <AppIcon icon="NavArrowRight" aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="marketplace-profile__nav-row"
              data-marketplace-action="buttons"
              onClick={(event) => {
                setPolicyVisited(true);
                onScreenChange('buttons', event.currentTarget);
              }}
            >
              <AppIcon icon="Link" aria-hidden />
              <span>Кнопка в сообщениях</span>
              <AppIcon icon="NavArrowRight" aria-hidden />
            </button>
          </div>
        )}
      </div>
      {editorialVisited && (
        <MarketplaceEditorialWorkspace
          {...props}
          active={screen === 'editorial'}
          expectedEntityId={state.entityId}
          canAccess={!query.isError && entryUnexpired && !state.canCreate}
          resetDraftVersion={resetDraftVersion}
          onDirtyChange={setEditorialDirty}
          onBusyChange={setEditorialBusy}
          onDraftChange={() => onDraftChange('editorial')}
        />
      )}
      {policyVisited && (
        <div hidden={screen !== 'buttons'}>
          <div className="marketplace-workspace-identity">
            <EntityAvatar
              title={props.entityTitle || state.listing?.title || 'Площадка'}
              entityType={entityType}
              avatarUrl={props.entityAvatarUrl}
            />
            <strong>{props.entityTitle || state.listing?.title || 'Площадка'}</strong>
          </div>
          <MarketplaceButtonPolicy
            {...props}
            canEnable={publicNow}
            enableUnavailableReason={entryUnavailableReason}
            onRecheckProfile={entryUnavailableReason ? recheckEntry : undefined}
            recheckingProfile={query.isFetching}
            onBusyChange={setPolicyBusy}
            onDirtyChange={setPolicyDirty}
            onDraftChange={() => onDraftChange('buttons')}
            resetDraftVersion={resetDraftVersion}
            active={screen === 'buttons'}
            onOpenProfile={canManage ? () => onScreenChange('profile') : undefined}
          />
        </div>
      )}
    </div>
  );
}
