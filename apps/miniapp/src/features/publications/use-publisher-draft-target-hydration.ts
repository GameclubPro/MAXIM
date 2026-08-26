import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { resolvePublisherEntities } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getPublicationTargetKey,
  hasSamePublicationTargetMetadata,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';
import { publisherEntityToPublicationTarget } from './use-publication-target-sources';

export function mergePublisherResolvedTargets(
  currentTargets: PublicationTarget[],
  requestedTargets: readonly Pick<PublicationTarget, 'id' | 'entityType'>[],
  resolvedTargets: PublicationTarget[],
): PublicationTarget[] {
  const requestedKeys = new Set(requestedTargets.map(getPublicationTargetKey));
  const resolvedByKey = new Map(
    resolvedTargets.map((target) => [getPublicationTargetKey(target), target]),
  );
  return currentTargets.map((target) => {
    const key = getPublicationTargetKey(target);
    if (!requestedKeys.has(key)) {
      return target;
    }
    const resolved = resolvedByKey.get(key);
    const next = resolved ?? { ...target, readiness: null };
    return hasSamePublicationTargetMetadata(target, next) ? target : next;
  });
}

export function getPublisherDraftTargetsNeedingHydration(
  targets: readonly PublicationTarget[],
  initialTargetKeys: ReadonlySet<string>,
  attemptedTargetKeys: ReadonlySet<string>,
): PublicationTarget[] {
  return targets.filter((target) => {
    const key = getPublicationTargetKey(target);
    return initialTargetKeys.has(key) && !attemptedTargetKeys.has(key);
  });
}

export function hasUnavailablePublisherDraftTargets(options: {
  selectedTargets: readonly PublicationTarget[];
  currentTargets: readonly PublicationTarget[];
  hydrationFailed: boolean;
}): boolean {
  if (options.hydrationFailed) {
    return true;
  }
  return options.selectedTargets.some((selected) => {
    const current = options.currentTargets.find(
      (target) => getPublicationTargetKey(target) === getPublicationTargetKey(selected),
    );
    return !(current ?? selected).readiness?.canPublish;
  });
}

export function usePublisherDraftTargetHydration(options: {
  api: ApiTransport;
  enabled: boolean;
  targets: PublicationTarget[];
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
}) {
  const { api, enabled, setDraft, targets: draftTargets } = options;
  const [initialTargetKeys, setInitialTargetKeys] = useState<ReadonlySet<string> | null>(null);
  const [attemptedTargetKeys, setAttemptedTargetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const initialKeysForRender =
    enabled && initialTargetKeys === null
      ? new Set(draftTargets.map((target) => getPublicationTargetKey(target)))
      : initialTargetKeys;
  const targetsToHydrate = initialKeysForRender
    ? getPublisherDraftTargetsNeedingHydration(
        draftTargets,
        initialKeysForRender,
        attemptedTargetKeys,
      )
    : [];
  const targetKeys = targetsToHydrate
    .map((target) => getPublicationTargetKey(target))
    .sort((left, right) => left.localeCompare(right));
  const canHydrate = enabled && targetsToHydrate.length > 0;

  useEffect(() => {
    if (!enabled) {
      setInitialTargetKeys(null);
      setAttemptedTargetKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }
    if (initialTargetKeys === null && initialKeysForRender) {
      setInitialTargetKeys(initialKeysForRender);
    }
  }, [enabled, initialKeysForRender, initialTargetKeys]);

  const query = useQuery({
    queryKey: ['publisher', 'draft-targets', targetKeys],
    queryFn: async ({ signal }) => ({
      response: await resolvePublisherEntities(
        api,
        {
          targets: targetsToHydrate.map((target) => ({
            id: target.id,
            entityType: target.entityType,
          })),
        },
        { signal },
      ),
      requestedTargets: targetsToHydrate,
    }),
    enabled: canHydrate,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!query.data) {
      return;
    }
    setAttemptedTargetKeys((current) => {
      const next = new Set(current);
      let changed = false;
      for (const target of query.data.requestedTargets) {
        const key = getPublicationTargetKey(target);
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    const resolvedTargets = query.data.response.items.map(publisherEntityToPublicationTarget);
    setDraft((current) => {
      const targets = mergePublisherResolvedTargets(
        current.targets,
        query.data.requestedTargets,
        resolvedTargets,
      );
      return targets.every((target, index) => target === current.targets[index])
        ? current
        : { ...current, targets };
    });
  }, [query.data, setDraft]);

  return {
    error: canHydrate ? query.error : null,
    isError: canHydrate && query.isError,
    isPending: canHydrate && query.isFetching,
    refetch: query.refetch,
  };
}
