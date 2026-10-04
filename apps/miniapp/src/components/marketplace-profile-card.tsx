import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiTransport } from '../lib/api/transport';
import { SkeletonCard } from './ui/skeleton';
import './marketplace-profile-card.css';

const Panel = lazy(() => import('./marketplace-profile-panel'));

export type MarketplaceProfileCardProps = {
  api: ApiTransport;
  entityId: string;
  entityType: 'chat' | 'channel';
  profile: 'moderation' | 'publisher';
};

export function MarketplaceProfileCard(props: MarketplaceProfileCardProps) {
  const [open, setOpen] = useState(false);
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
    <section className="marketplace-profile-card channel-settings-card" style={{ order: 32 }}>
      <button
        className="marketplace-profile-card__open"
        aria-label="Профиль на бирже"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(true)}
      >
        <span>
          <strong>Профиль на бирже</strong>
          <small>Статистика и ссылка в публикациях</small>
        </span>
        <span aria-hidden>↗</span>
      </button>
      {open && (
        <Suspense fallback={<SkeletonCard lines={5} />}>
          <Panel {...props} id={id} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}
