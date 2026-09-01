import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/ui/toast';
import { refreshPublicationTargets } from '../../lib/api/publication-client';
import type { ApiTransport } from '../../lib/api/transport';
import { describeUserFacingError } from '../../lib/user-facing-error';

type PublicationTargetRecheckToast = (toast: { tone: 'danger'; title: string }) => void;

export function runPublicationTargetRecheck(
  recheck: () => Promise<void>,
  pushToast: PublicationTargetRecheckToast,
): void {
  void recheck().catch((error) =>
    pushToast({
      tone: 'danger',
      title: describeUserFacingError(error, 'Не удалось перепроверить подключения'),
    }),
  );
}

const PUBLICATION_TARGET_RECHECK_SETTLE_MS = 15_500;

export function usePublicationTargetRecheck(api: ApiTransport) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [settlingPublicationId, setSettlingPublicationId] = useState<string | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
    },
    [],
  );

  const mutation = useMutation({
    mutationFn: (publicationId: string) => refreshPublicationTargets(api, publicationId),
    onSuccess: (result, publicationId) => {
      setSettlingPublicationId(publicationId);
      settleTimerRef.current = window.setTimeout(
        () => {
          void Promise.all([
            queryClient.invalidateQueries({
              queryKey: ['publications', 'details', publicationId],
            }),
            queryClient.invalidateQueries({ queryKey: ['publications', 'list'] }),
            queryClient.invalidateQueries({ queryKey: ['publications', 'sources', 'publisher'] }),
            queryClient.invalidateQueries({ queryKey: ['publisher', 'entity'] }),
          ]).finally(() =>
            setSettlingPublicationId((current) => (current === publicationId ? null : current)),
          );
        },
        result.queuedCount > 0 ? PUBLICATION_TARGET_RECHECK_SETTLE_MS : 0,
      );
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось перепроверить получателей'),
      }),
  });

  return {
    isBusy: mutation.isPending || settlingPublicationId !== null,
    isRechecking(publicationId: string) {
      return (mutation.isPending ? mutation.variables : settlingPublicationId) === publicationId;
    },
    recheck(publicationId: string) {
      if (mutation.isPending || settlingPublicationId !== null) {
        return;
      }
      mutation.mutate(publicationId);
    },
  };
}
