import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  marketplaceEntryResponseSchema,
  type MarketplaceButtonModule,
} from '@maxim/contracts/marketplace-integration';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';
import MarketplaceButtonPolicy from './marketplace-button-policy';
import { marketplaceEntityPath } from '../lib/marketplace-button-policy';
import { useNativeBackHandler } from '../lib/native-back';
import './marketplace-profile-panel.css';

export default function MarketplaceModuleToggle(
  props: MarketplaceProfileCardProps & { module: MarketplaceButtonModule },
) {
  const { api, profile, entityType, entityId } = props;
  const [busy, setBusy] = useState(false);
  const entry = useQuery({
    queryKey: ['marketplace-entry', profile, entityType, entityId],
    queryFn: async () =>
      marketplaceEntryResponseSchema.parse(
        await api.request(marketplaceEntityPath(profile, entityType, entityId, 'entry')),
      ),
    retry: false,
    refetchOnWindowFocus: 'always',
    staleTime: 30_000,
  });
  const canEnable =
    !entry.isError &&
    entry.data?.publicState === 'PUBLIC' &&
    !!entry.data.validUntil &&
    Date.parse(entry.data.validUntil) > Date.now();
  useNativeBackHandler(() => busy && canEnable, { enabled: busy && canEnable, priority: 1000 });
  // The module has no advertising controls until this exact platform is public.
  if (!canEnable) return null;
  return (
    <div className="marketplace-module-toggle">
      <MarketplaceButtonPolicy {...props} canEnable onBusyChange={setBusy} />
    </div>
  );
}
