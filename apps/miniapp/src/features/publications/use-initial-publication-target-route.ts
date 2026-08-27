import { useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { getPublisherEntity } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import { isTerminalApiClientError } from '../../lib/api-retry';
import {
  getPublicationTargetKey,
  hasSamePublicationTargetMetadata,
  isPublicationDraftEmpty,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';
import { publisherEntityToPublicationTarget } from './use-publication-target-sources';

function normalizeRouteEntityType(value: string | null): 'chat' | 'channel' | null {
  return value === 'chat' || value === 'channel' ? value : null;
}

export type InitialPublicationTargetRouteFailure = {
  kind: 'unavailable' | 'retryable';
  reason: 'not_ready' | 'request_failed';
  error: unknown;
};

export type RouteBoundInitialPublicationTargetFailure = {
  routeKey: string;
  failure: InitialPublicationTargetRouteFailure;
};

export type InitialPublicationTargetRouteResult = {
  error: unknown | null;
  failure: InitialPublicationTargetRouteFailure | null;
  pending: boolean;
  retry: (() => void) | null;
};

export function classifyInitialPublicationTargetRequestError(
  error: unknown,
): InitialPublicationTargetRouteFailure['kind'] {
  return isTerminalApiClientError(error) ? 'unavailable' : 'retryable';
}

export function canSelectInitialPublicationRouteTarget(
  publisherProfile: boolean,
  target: Pick<PublicationTarget, 'readiness'>,
): boolean {
  return !publisherProfile || target.readiness?.canPublish === true;
}

export function getRouteBoundInitialPublicationTargetFailure(
  routeFailure: RouteBoundInitialPublicationTargetFailure | null,
  routeKey: string,
): InitialPublicationTargetRouteFailure | null {
  return routeFailure?.routeKey === routeKey ? routeFailure.failure : null;
}

function createNotReadyTargetFailure(): InitialPublicationTargetRouteFailure {
  return {
    kind: 'unavailable',
    reason: 'not_ready',
    error: new Error('Publisher target is not ready for publication'),
  };
}

export function shouldFetchInitialPublisherTarget(options: {
  publisherProfile: boolean;
  hydrated: boolean;
  routeApplied: boolean;
  entityType: 'chat' | 'channel' | null;
  entityId: string;
  targetInPages: boolean;
}): boolean {
  return (
    options.publisherProfile &&
    options.hydrated &&
    !options.routeApplied &&
    Boolean(options.entityType && options.entityId) &&
    !options.targetInPages
  );
}

export function useInitialPublicationTargetRoute(options: {
  api: ApiTransport;
  hydrated: boolean;
  publisherProfile: boolean;
  searchParams: URLSearchParams;
  targets: PublicationTarget[];
  sourcesReady: boolean;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
}): InitialPublicationTargetRouteResult {
  const { api, hydrated, publisherProfile, searchParams, setDraft, sourcesReady, targets } =
    options;
  const appliedRouteRef = useRef<string | null>(null);
  const [routeFailure, setRouteFailure] =
    useState<RouteBoundInitialPublicationTargetFailure | null>(null);
  const entityType =
    normalizeRouteEntityType(searchParams.get('entityType')) ??
    normalizeRouteEntityType(searchParams.get('sourceType'));
  const entityId = searchParams.get('entityId') ?? searchParams.get('sourceId') ?? '';
  const routeKey = `${entityType ?? 'unknown'}:${entityId}`;
  const activeRouteKeyRef = useRef(routeKey);
  if (activeRouteKeyRef.current !== routeKey) {
    activeRouteKeyRef.current = routeKey;
    appliedRouteRef.current = null;
  }
  const targetInPages = targets.find(
    (target) => target.id === entityId && (!entityType || target.entityType === entityType),
  );
  const directEntityQueryEnabled = shouldFetchInitialPublisherTarget({
    publisherProfile,
    hydrated,
    routeApplied: appliedRouteRef.current === routeKey,
    entityType,
    entityId,
    targetInPages: Boolean(targetInPages),
  });
  const directEntityQuery = useQuery({
    queryKey: ['publisher', 'entity', entityType, entityId],
    queryFn: ({ signal }) => {
      if (!entityType || !entityId) {
        throw new Error('Publisher entity route is incomplete');
      }
      return getPublisherEntity(api, entityType, entityId, { signal });
    },
    enabled: directEntityQueryEnabled,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!hydrated || appliedRouteRef.current === routeKey) {
      return;
    }
    if (!entityId) {
      appliedRouteRef.current = routeKey;
      return;
    }

    const routeTarget =
      targetInPages ??
      (publisherProfile && directEntityQuery.data
        ? publisherEntityToPublicationTarget(directEntityQuery.data)
        : undefined);
    if (routeTarget) {
      appliedRouteRef.current = routeKey;
      if (!canSelectInitialPublicationRouteTarget(publisherProfile, routeTarget)) {
        setRouteFailure({ routeKey, failure: createNotReadyTargetFailure() });
        return;
      }
      setRouteFailure(null);
      setDraft((current) => {
        const existingIndex = current.targets.findIndex(
          (target) => getPublicationTargetKey(target) === getPublicationTargetKey(routeTarget),
        );
        if (existingIndex >= 0) {
          const existing = current.targets[existingIndex];
          if (!existing || hasSamePublicationTargetMetadata(existing, routeTarget)) {
            return current;
          }
          return {
            ...current,
            targets: current.targets.map((target, index) =>
              index === existingIndex ? routeTarget : target,
            ),
          };
        }
        return {
          ...current,
          targets: isPublicationDraftEmpty(current)
            ? [routeTarget]
            : [...current.targets, routeTarget],
        };
      });
      return;
    }
    if (publisherProfile && entityType) {
      if (directEntityQueryEnabled && directEntityQuery.isFetching) {
        return;
      }
      if (directEntityQuery.isError) {
        const kind = classifyInitialPublicationTargetRequestError(directEntityQuery.error);
        if (kind === 'unavailable') {
          appliedRouteRef.current = routeKey;
        }
        setRouteFailure({
          routeKey,
          failure: {
            kind,
            reason: 'request_failed',
            error: directEntityQuery.error,
          },
        });
      }
      return;
    }
    if (sourcesReady) {
      appliedRouteRef.current = routeKey;
    }
  }, [
    directEntityQuery.data,
    directEntityQuery.error,
    directEntityQuery.isError,
    directEntityQuery.isFetching,
    directEntityQueryEnabled,
    entityId,
    entityType,
    hydrated,
    publisherProfile,
    routeKey,
    setDraft,
    sourcesReady,
    targetInPages,
  ]);

  const currentFailure = getRouteBoundInitialPublicationTargetFailure(routeFailure, routeKey);
  const retry = useCallback(() => {
    if (currentFailure?.kind !== 'retryable') {
      return;
    }
    setRouteFailure((current) => (current?.routeKey === routeKey ? null : current));
    void directEntityQuery.refetch();
  }, [currentFailure?.kind, directEntityQuery.refetch, routeKey]);

  return {
    error: currentFailure?.error ?? null,
    failure: currentFailure,
    pending: directEntityQueryEnabled && directEntityQuery.isFetching,
    retry: currentFailure?.kind === 'retryable' ? retry : null,
  };
}
