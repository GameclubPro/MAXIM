import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useToast } from '../../components/ui/toast';
import { refreshPublicationTargets } from '../../lib/api/publication-client';
import { runOrResumePublisherRefresh } from '../../lib/api/publisher-client';
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

export function usePublicationTargetRecheck(api: ApiTransport) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const refreshAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      refreshAbort.current?.abort();
    },
    [api],
  );

  const mutation = useMutation({
    mutationFn: async (publicationId: string) => {
      const controller = new AbortController();
      refreshAbort.current = controller;
      await runOrResumePublisherRefresh(
        api,
        `publication:${publicationId}`,
        () => refreshPublicationTargets(api, publicationId),
        controller.signal,
      );
    },
    onSettled: (_data, _error, publicationId) => {
      if (
        refreshAbort.current?.signal.aborted ||
        (_error instanceof Error && _error.name === 'AbortError')
      )
        return;
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['publications', 'details', publicationId],
        }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'list'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'sources', 'publisher'] }),
        queryClient.invalidateQueries({ queryKey: ['publisher', 'entity'] }),
      ]);
    },
    onError: (error) => {
      if (
        refreshAbort.current?.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      )
        return;
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось перепроверить получателей'),
      });
    },
  });

  return {
    isBusy: mutation.isPending,
    isRechecking(publicationId: string) {
      return mutation.isPending && mutation.variables === publicationId;
    },
    recheck(publicationId: string) {
      if (mutation.isPending) {
        return;
      }
      mutation.mutate(publicationId);
    },
  };
}
