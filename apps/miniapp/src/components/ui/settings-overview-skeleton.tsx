import { useSmartphoneLayout } from '../../lib/use-smartphone-layout';
import { GlassCard } from './glass-card';
import { Skeleton, SkeletonCard } from './skeleton';

function SettingsOverviewSkeletonRow() {
  return (
    <div
      className="settings-overview-skeleton"
      aria-hidden
      style={{
        display: 'grid',
        gridTemplateColumns: '38px minmax(0, 1fr)',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
        padding: '12px 16px',
      }}
    >
      <Skeleton className="settings-section__icon-badge" />
      <Skeleton className="skeleton-card__title" />
    </div>
  );
}

export function SettingsOverviewSkeleton() {
  return useSmartphoneLayout() ? <SettingsOverviewSkeletonRow /> : <SkeletonCard lines={2} />;
}

export function SettingsOverviewLoading({ desktopLines }: { desktopLines: number }) {
  return useSmartphoneLayout() ? (
    <div className="settings-overview-group" role="status" aria-label="Загрузка настроек">
      <div className="settings-overview-group__entries">
        {Array.from({ length: 4 }, (_, index) => (
          <section
            className="settings-section settings-home-entry channel-settings-card"
            key={index}
          >
            <SettingsOverviewSkeletonRow />
          </section>
        ))}
      </div>
    </div>
  ) : (
    <GlassCard className="settings-section">
      <SkeletonCard lines={desktopLines} />
    </GlassCard>
  );
}
