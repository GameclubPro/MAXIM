import type {
  PublisherEntitiesSummary,
  PublisherEntity,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import { isInvalidPublisherEntitiesCursorError } from '../lib/api/publisher-client';

export type PublisherEntityView = 'chat' | 'channel';
export type PublisherEntityReadinessFilter = 'all' | 'ready' | 'attention';
export type PublisherHomeViewResolution = {
  view: PublisherEntityView;
  shouldReplace: boolean;
};

export const PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS = [
  750, 1_250, 2_500, 4_500, 7_500, 10_500,
] as const;
const PUBLISHER_ENTITY_REFRESH_MAX_CONSECUTIVE_READ_FAILURES = 2;

export type PublisherEntityRefreshPollResult =
  | { status: 'updated'; entity: PublisherEntity; attempts: number }
  | { status: 'timed_out'; entity: PublisherEntity; attempts: number }
  | { status: 'read_failed'; entity: PublisherEntity; attempts: number; error: unknown }
  | { status: 'cancelled'; entity: PublisherEntity; attempts: number };

export async function retryPublisherEntitiesNextPage(options: {
  fetchNextPage: () => Promise<{ isError: boolean; error: unknown }>;
  resetInvalidCursor: () => Promise<unknown>;
}): Promise<'retried' | 'reset'> {
  const result = await options.fetchNextPage();
  if (!result.isError || !isInvalidPublisherEntitiesCursorError(result.error)) {
    return 'retried';
  }

  await options.resetInvalidCursor();
  return 'reset';
}

export function shouldLoadPublisherEntitiesNextPage(options: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold: number;
}): boolean {
  return options.scrollHeight - options.scrollTop - options.clientHeight <= options.threshold;
}

const RECHECK_BY_BLOCKER: Record<PublisherReadinessBlockerCode, boolean> = {
  policy_disabled: false,
  bot_not_connected: true,
  bot_access_unconfirmed: true,
  bot_access_expired: true,
  bot_not_admin: true,
  write_permission_missing: true,
  route_quarantined: false,
  publisher_runtime_unavailable: false,
  module_disabled: false,
};

export function normalizePublisherEntityView(value: string | null): PublisherEntityView {
  return value === 'channel' ? 'channel' : 'chat';
}

export function resolvePublisherHomeView(
  requestedView: string | null,
  summary: Pick<PublisherEntitiesSummary, 'chat' | 'channel'>,
): PublisherHomeViewResolution {
  if (requestedView === 'chat' || requestedView === 'channel') {
    return { view: requestedView, shouldReplace: false };
  }

  return summary.chat === 0 && summary.channel > 0
    ? { view: 'channel', shouldReplace: true }
    : { view: 'chat', shouldReplace: false };
}

export function buildPublisherEntityViewRoute(
  view: PublisherEntityView,
  currentSearch = '',
): string {
  const search = new URLSearchParams(currentSearch.replace(/^\?/u, ''));
  search.set('view', view);
  return `/?${search.toString()}`;
}

export function fingerprintPublisherEntities(entities: readonly PublisherEntity[]): string {
  return entities
    .map((entity) =>
      [
        entity.entityType,
        entity.id,
        entity.readiness.state,
        entity.readiness.blockerCode ?? '',
        entity.readiness.checkedAt ?? '',
      ].join('\0'),
    )
    .sort()
    .join('\n');
}

export function waitForPublisherRefresh(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = () => {
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    timeoutId = globalThis.setTimeout(finish, delayMs);
  });
}

export function normalizePublisherReadinessFilter(
  value: string | null,
): PublisherEntityReadinessFilter {
  return value === 'ready' || value === 'attention' ? value : 'all';
}

export function buildPublisherCreateRoute(
  entity: Pick<PublisherEntity, 'entityType' | 'id'>,
): string {
  return `/publications?create=1&entityType=${entity.entityType}&entityId=${encodeURIComponent(
    entity.id,
  )}`;
}

export function shouldOfferPublisherRecheck(entity: Pick<PublisherEntity, 'readiness'>): boolean {
  const blockerCode = entity.readiness.blockerCode;
  return blockerCode ? RECHECK_BY_BLOCKER[blockerCode] : false;
}

export function isPublisherEntityRefreshObserved(
  initialEntity: Pick<PublisherEntity, 'readiness'>,
  currentEntity: Pick<PublisherEntity, 'readiness'>,
): boolean {
  const currentCheckedAt = currentEntity.readiness.checkedAt;
  if (currentCheckedAt === null) {
    return false;
  }
  const currentCheckedAtMs = Date.parse(currentCheckedAt);
  const initialCheckedAtMs = Date.parse(initialEntity.readiness.checkedAt ?? '');
  return (
    Number.isFinite(currentCheckedAtMs) &&
    (!Number.isFinite(initialCheckedAtMs) || currentCheckedAtMs > initialCheckedAtMs)
  );
}

export async function pollPublisherEntityRefresh(options: {
  initialEntity: PublisherEntity;
  readEntity: () => Promise<PublisherEntity>;
  wait: (delayMs: number) => Promise<void>;
  delaysMs?: readonly number[];
  isCancelled?: () => boolean;
}): Promise<PublisherEntityRefreshPollResult> {
  const delaysMs = options.delaysMs ?? PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS;
  let lastEntity = options.initialEntity;
  let lastReadError: unknown = null;
  let lastReadFailed = false;
  let consecutiveReadFailures = 0;
  let attempts = 0;

  for (const delayMs of delaysMs) {
    await options.wait(delayMs);
    if (options.isCancelled?.()) {
      return { status: 'cancelled', entity: lastEntity, attempts };
    }

    attempts += 1;
    try {
      const currentEntity = await options.readEntity();
      lastEntity = currentEntity;
      lastReadFailed = false;
      consecutiveReadFailures = 0;
      if (isPublisherEntityRefreshObserved(options.initialEntity, currentEntity)) {
        return { status: 'updated', entity: currentEntity, attempts };
      }
    } catch (error: unknown) {
      if (options.isCancelled?.()) {
        return { status: 'cancelled', entity: lastEntity, attempts };
      }
      lastReadError = error;
      lastReadFailed = true;
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= PUBLISHER_ENTITY_REFRESH_MAX_CONSECUTIVE_READ_FAILURES) {
        return { status: 'read_failed', entity: lastEntity, attempts, error: lastReadError };
      }
    }
  }

  return lastReadFailed
    ? { status: 'read_failed', entity: lastEntity, attempts, error: lastReadError }
    : { status: 'timed_out', entity: lastEntity, attempts };
}
