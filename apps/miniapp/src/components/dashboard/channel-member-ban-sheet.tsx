import type { MembershipActivityItem } from '@maxim/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { banChannelMember } from '../../lib/api/channel-stats-client';
import type { ApiTransport } from '../../lib/api/transport';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { useToast } from '../ui/toast';

export function ChannelMemberBanSheet({
  api,
  chatId,
  channelTitle,
  target,
  onClose,
  onApplied,
}: {
  api: ApiTransport;
  chatId: string;
  channelTitle: string;
  target: MembershipActivityItem;
  onClose: () => void;
  onApplied: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationFn: () => banChannelMember(api, chatId, target.userId),
    retry: false,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['channel-stats', chatId] });
      pushToast({ tone: 'success', title: result.message });
      if (mounted.current) {
        onApplied();
        onClose();
      }
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  return (
    <ActionConfirmSheet
      id="channel-member-ban"
      open
      role="alertdialog"
      title="Заблокировать участника?"
      summary={`Только в канале «${channelTitle}».`}
      previewTitle={target.userDisplayName.trim() || 'Участник'}
      previewMeta={
        mutation.error ? (
          <span role="alert">
            {describeUserFacingError(mutation.error, 'Не удалось заблокировать участника.')}
          </span>
        ) : (
          `ID: ${target.userId}`
        )
      }
      confirmLabel="Заблокировать"
      confirmBusyLabel="Блокируем..."
      isBusy={mutation.isPending}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      onConfirm={() => {
        if (submitting.current) return;
        submitting.current = true;
        mutation.mutate();
      }}
    />
  );
}
