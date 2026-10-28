import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { marketplaceEntryResponseSchema } from '@maxim/contracts/marketplace-integration';
import { marketplaceEntityPath } from '../lib/marketplace-button-policy';
import { openMarketplace } from '../lib/marketplace-launch';
import { isMarketplaceAccessPending } from '../lib/marketplace-profile-view';
import { ApiRequestError } from '../lib/api-request-error';
import MarketplaceProfileWorkspace from './marketplace-profile-workspace';
import MarketplaceButtonPolicy from './marketplace-button-policy';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

export default function MarketplaceEntryWorkspace({
  onBusyChange,
  onDirtyChange,
  ...props
}: MarketplaceProfileCardProps & {
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { api, entityId, entityType, profile } = props;
  const [profileBusy, setProfileBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [linkError, setLinkError] = useState(false);
  useEffect(() => {
    onBusyChange(profileBusy || policyBusy);
  }, [profileBusy, policyBusy, onBusyChange]);
  const query = useQuery({
    queryKey: ['marketplace-entry', profile, entityType, entityId],
    queryFn: async () =>
      marketplaceEntryResponseSchema.parse(
        await api.request(marketplaceEntityPath(profile, entityType, entityId, 'entry')),
      ),
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: 60_000,
  });
  const state = query.data;
  const waiting = query.isPending || isMarketplaceAccessPending(query.error);
  if (!state)
    return (
      <div className="marketplace-profile">
        <p role={waiting ? 'status' : 'alert'}>
          {waiting
            ? 'Проверяем ваши права…'
            : query.error instanceof ApiRequestError && query.error.status === 403
              ? 'Доступ не подтверждён. Проверьте права администратора и подключение бота.'
              : 'Не удалось получить профиль. Проверьте соединение и повторите.'}
        </p>
        {!query.isPending && (
          <button
            className="button button--ghost"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Проверить снова
          </button>
        )}
      </div>
    );
  const owner = state.isOwner || state.canCreate;
  const publicNow = !query.isError && state.publicState === 'PUBLIC' && !!state.listing?.publicUrl;
  return (
    <div className="marketplace-entry">
      {owner ? (
        <MarketplaceProfileWorkspace
          {...props}
          onBusyChange={setProfileBusy}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <div className="marketplace-profile">
          <div className="marketplace-profile__hero">
            <div>
              <strong>{state.listing?.title || 'Профиль площадки'}</strong>
              <small>{publicNow ? 'Профиль опубликован' : 'Профиль пока недоступен'}</small>
            </div>
          </div>
          {publicNow && state.listing && (
            <button
              type="button"
              className="button button--accent"
              onClick={() => {
                setLinkError(false);
                void openMarketplace(api, {
                  target: 'listing',
                  kind: state.kind,
                  entityId: state.entityId,
                  listingId: state.listing!.id,
                }).catch(() => setLinkError(true));
              }}
            >
              Открыть профиль
            </button>
          )}
          <p className="marketplace-profile-card__intro">
            Профиль и условия размещений изменяет его владелец.
          </p>
          {linkError && <p role="alert">Не удалось открыть Биржик. Повторите переход.</p>}
        </div>
      )}
      {query.isError && <p role="alert">Не удалось обновить профиль. Проверьте соединение.</p>}
      <MarketplaceButtonPolicy {...props} canEnable={publicNow} onBusyChange={setPolicyBusy} />
    </div>
  );
}
