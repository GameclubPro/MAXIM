import { lazy, Suspense, type ComponentProps } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SkeletonCard } from '../../components/ui/skeleton';

const LazyAdminContactToggle = lazy(() =>
  import('../../components/admin-contact-toggle').then((module) => ({
    default: module.AdminContactToggle,
  })),
);
const LazyBroadcastPublishBar = lazy(() => import('../../components/broadcast-publish-bar'));
const LazyPublisherPolicyCard = lazy(() =>
  import('../../components/publisher-policy-card').then((module) => ({
    default: module.PublisherPolicyCard,
  })),
);
const LazySettingsLoadErrorState = lazy(() =>
  import('../../components/settings-load-error-state').then((module) => ({
    default: module.SettingsLoadErrorState,
  })),
);
const LazySettingsStorefrontSection = lazy(() =>
  import('./settings-storefront-section').then((module) => ({
    default: module.SettingsStorefrontSection,
  })),
);

export function AdminContactToggle(props: ComponentProps<typeof LazyAdminContactToggle>) {
  return (
    <Suspense fallback={null}>
      <LazyAdminContactToggle {...props} />
    </Suspense>
  );
}

export function BroadcastPublishBar(props: ComponentProps<typeof LazyBroadcastPublishBar>) {
  return (
    <Suspense fallback={null}>
      <LazyBroadcastPublishBar {...props} />
    </Suspense>
  );
}

export function PublisherPolicyCard(props: ComponentProps<typeof LazyPublisherPolicyCard>) {
  return (
    <Suspense fallback={<SkeletonCard lines={2} />}>
      <LazyPublisherPolicyCard {...props} />
    </Suspense>
  );
}

export function SettingsLoadErrorState(props: ComponentProps<typeof LazySettingsLoadErrorState>) {
  return (
    <Suspense fallback={<SkeletonCard lines={3} />}>
      <LazySettingsLoadErrorState {...props} />
    </Suspense>
  );
}

export function SettingsStorefrontSection(
  props: ComponentProps<typeof LazySettingsStorefrontSection>,
) {
  return (
    <Suspense
      fallback={
        <GlassCard className="settings-section settings-home-entry" style={{ order: 31 }}>
          <SkeletonCard lines={2} />
        </GlassCard>
      }
    >
      <LazySettingsStorefrontSection {...props} />
    </Suspense>
  );
}
