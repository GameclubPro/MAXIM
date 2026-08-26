import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { getPublisherEntity } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
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
}): { error: unknown | null; pending: boolean } {
  const { api, hydrated, publisherProfile, searchParams, setDraft, sourcesReady, targets } =
    options;
  const appliedRef = useRef(false);
  const entityType =
    normalizeRouteEntityType(searchParams.get('entityType')) ??
    normalizeRouteEntityType(searchParams.get('sourceType'));
  const entityId = searchParams.get('entityId') ?? searchParams.get('sourceId') ?? '';
  const targetInPages = targets.find(
    (target) => target.id === entityId && (!entityType || target.entityType === entityType),
  );
  const directEntityQueryEnabled = shouldFetchInitialPublisherTarget({
    publisherProfile,
    hydrated,
    routeApplied: appliedRef.current,
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
    if (!hydrated || appliedRef.current) {
      return;
    }
    if (!entityId) {
      appliedRef.current = true;
      return;
    }

    const routeTarget =
      targetInPages ??
      (publisherProfile && directEntityQuery.data
        ? publisherEntityToPublicationTarget(directEntityQuery.data)
        : undefined);
    if (routeTarget) {
      appliedRef.current = true;
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
        appliedRef.current = true;
      }
      return;
    }
    if (sourcesReady) {
      appliedRef.current = true;
    }
  }, [
    directEntityQuery.data,
    directEntityQuery.isError,
    directEntityQuery.isFetching,
    directEntityQueryEnabled,
    entityId,
    entityType,
    hydrated,
    publisherProfile,
    setDraft,
    sourcesReady,
    targetInPages,
  ]);

  return {
    error:
      directEntityQueryEnabled && directEntityQuery.isError ? directEntityQuery.error : null,
    pending: directEntityQueryEnabled && directEntityQuery.isFetching,
  };
}
