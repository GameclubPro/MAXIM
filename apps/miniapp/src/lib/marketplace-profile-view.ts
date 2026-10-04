import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';
import { ApiRequestError } from './api-request-error';
import { marketplaceProfileTitle } from './marketplace-profile-summary';
export { marketplaceQueryKey } from './marketplace-profile-summary';

export type MarketplaceDetails = {
  title: string;
  description: string;
  topic: string;
  region: string;
};
export function marketplaceDetails(state: MarketplaceProfileState): MarketplaceDetails {
  return {
    title: state.listing?.title ?? state.binding.metadata.title,
    description: state.listing?.description ?? state.binding.metadata.description.slice(0, 1500),
    topic: state.listing?.topic ?? '',
    region: state.listing?.region ?? '',
  };
}
export function marketplaceProfilePath(profile: string, entityType: string, entityId: string) {
  return `/marketplace/entities/${entityType === 'channel' ? 'CHANNEL' : 'CHAT'}/${encodeURIComponent(entityId)}/profile?profile=${profile}&view=2`;
}
export function isMarketplaceAccessPending(error: unknown) {
  return error instanceof ApiRequestError && error.code === 'MARKETPLACE_ACCESS_PENDING';
}
export function marketplaceRetryInterval(attempts: number, waiting: boolean): number | false {
  if (!waiting) return 60_000;
  return attempts < 4 ? Math.min(5000 * 2 ** attempts, 30_000) : false;
}
export function marketplaceProfileView(state: MarketplaceProfileState, fresh = true) {
  const active = fresh && state.binding.state === 'ACTIVE';
  const consent = state.binding.statisticsConsent;
  const caps = state.capabilities;
  const publicState =
    caps?.publicState ??
    (state.listing?.status === 'PAUSED'
      ? 'HIDDEN'
      : state.listing?.status === 'PUBLISHED'
        ? 'ACCESS_REQUIRED'
        : 'DRAFT');
  const publicNow = active && publicState === 'PUBLIC' && !!state.listing?.publicUrl;
  return {
    title: marketplaceProfileTitle(state, fresh),
    active,
    publicNow,
    canEdit: active && (caps?.canEdit ?? true),
    canPublish: active && consent && !!caps?.canPublish,
    canPause: active && !!caps?.canPause,
    canAppend: active && consent && publicNow,
    placement:
      caps?.placementState ?? (state.listing?.profileOnly ? 'BOT_REQUIRED' : 'UNAVAILABLE'),
    publicState,
  };
}

export function mergeMarketplaceMutationState(
  result: MarketplaceProfileState,
  previous?: MarketplaceProfileState,
): MarketplaceProfileState {
  if (
    !previous ||
    previous.bindingId !== result.bindingId ||
    previous.entityId !== result.entityId ||
    previous.kind !== result.kind
  )
    return result;
  // Durable policy replies keep the legacy shape; fresh binding/consent still govern every action.
  return {
    ...result,
    capabilities: result.capabilities ?? previous.capabilities,
    statistics: result.statistics ?? previous.statistics,
  };
}
