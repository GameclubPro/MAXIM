import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiTransport } from '../../lib/api/transport';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { SkeletonCard } from '../../components/ui/skeleton';
import { SettingsAdvertisingSoonSection } from './settings-advertising-soon-section';

const Workspace = lazy(() => import('./settings-advertising-workspace'));

export function SettingsAdvertisingSection({
  api,
  chatId,
  userId,
}: {
  api: ApiTransport;
  chatId: string;
  userId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const capability = useQuery({
    queryKey: ['advertising-placement-capability', userId],
    queryFn: async () => {
      const response = await api.request('/advertising-placement/capability');
      return {
        available:
          typeof response === 'object' &&
          response !== null &&
          'available' in response &&
          response.available === true,
      };
    },
    enabled: Boolean(userId),
    staleTime: 30_000,
    retry: false,
  });
  if (!capability.data?.available || capability.isError) return <SettingsAdvertisingSoonSection />;
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ order: 32 }}
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Рекламная площадка"
          icon="ads"
          tone="sky"
          open={open}
          controls="settings-advertising-content"
          onClick={() => setOpen(true)}
        />
      </div>
      <SettingsDrilldownPanel
        id="settings-advertising-content"
        open={open}
        title="Рекламная площадка"
        variant="screen"
        onClose={() => setOpen(false)}
      >
        <Suspense fallback={<SkeletonCard lines={4} />}>
          {open ? <Workspace api={api} chatId={chatId} userId={userId!} /> : null}
        </Suspense>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
