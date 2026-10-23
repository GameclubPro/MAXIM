import { lazy, Suspense, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { notifyManager, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';
import { marketplaceProfileTitle, marketplaceQueryKey } from '../lib/marketplace-profile-summary';
import type { ApiTransport } from '../lib/api/transport';
import { SkeletonCard } from './ui/skeleton';
import { AppIcon } from './ui/app-icon';
import { useSmartphoneLayout } from '../lib/use-smartphone-layout';
import './marketplace-profile-card.css';

const Panel = lazy(() => import('./marketplace-profile-panel'));

export type MarketplaceProfileCardProps = {
  api: ApiTransport;
  entityId: string;
  entityType: 'chat' | 'channel';
  profile: 'moderation' | 'publisher';
};

export function MarketplaceProfileCard(props: MarketplaceProfileCardProps) {
  const smartphone = useSmartphoneLayout();
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const profileKey = useMemo(
    () => marketplaceQueryKey(props.profile, props.entityType, props.entityId),
    [props.profile, props.entityType, props.entityId],
  );
  const known = useSyncExternalStore(
    useCallback(
      (changed: () => void) =>
        cache.getQueryCache().subscribe(
          notifyManager.batchCalls((event) => {
            if (
              event.type === 'updated' &&
              JSON.stringify(event.query.queryKey) === JSON.stringify(profileKey)
            )
              changed();
          }),
        ),
      [cache, profileKey],
    ),
    useCallback(
      () => cache.getQueryState<MarketplaceProfileState>(profileKey),
      [cache, profileKey],
    ),
  );
  const capability = useQuery({
    queryKey: ['marketplace-profile-capability', props.profile],
    queryFn: async () => {
      const result = await props.api.request('/marketplace/capability');
      return (
        !!result && typeof result === 'object' && 'available' in result && result.available === true
      );
    },
    staleTime: 30_000,
    retry: false,
  });
  if (!capability.data || capability.isError) return null;
  const id = `marketplace-profile-${props.profile}-${props.entityType}`;
  return (
    <section
      className={
        'marketplace-profile-card channel-settings-card' +
        (smartphone ? ' settings-section settings-home-entry' : '')
      }
      style={{ order: 32 }}
    >
      {smartphone ? (
        <div className="settings-section__head">
          <button
            type="button"
            className="settings-section__toggle is-stateless"
            data-settings-navigation-entry="true"
            data-settings-search="Профиль на бирже"
            aria-label="Профиль на бирже"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(true)}
          >
            <span className="settings-section__icon-badge is-sky" aria-hidden>
              <AppIcon icon="Shop" />
            </span>
            <span className="settings-section__toggle-main">
              <span className="settings-section__title">Профиль на бирже</span>
            </span>
            <span className="settings-section__chevron" aria-hidden>
              <AppIcon icon="NavArrowRight" />
            </span>
          </button>
        </div>
      ) : (
        <button
          className="marketplace-profile-card__open"
          aria-label="Профиль на бирже"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          <span>
            <strong>Профиль на бирже</strong>
            <small>
              {known?.data
                ? marketplaceProfileTitle(known.data, known.status !== 'error')
                : 'Создайте профиль со статистикой'}
            </small>
          </span>
          <span aria-hidden>›</span>
        </button>
      )}
      {open && (
        <Suspense fallback={<SkeletonCard lines={5} />}>
          <Panel {...props} id={id} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}
