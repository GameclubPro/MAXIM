import type {
  ChatParticipantDetails,
  ChatParticipantImmunityUpdateRequest,
  ChatSanctionItem,
  LogsDashboardRange,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ComponentProps } from 'react';
import { NavArrowLeft } from 'iconoir-react';
import { getChatParticipantDetails } from '../../lib/api/participant-details-client';
import { updateChatParticipantImmunity } from '../../lib/api/events-client';
import { getChatSanctions } from '../../lib/api/chat-sanctions-client';
import type { ApiTransport } from '../../lib/api/transport';
import { participantDetailsKey, type ParticipantCardTarget } from '../../lib/participant-card';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { useNativeBackHandler } from '../../lib/native-back';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import { ChatParticipantSheet } from './chat-participant-sheet';
import { ChatSanctionsWorkspace } from './chat-sanctions-workspace';
import { useToast } from '../ui/toast';

type Props = Omit<
  ComponentProps<typeof ChatParticipantSheet>,
  'item' | 'onSanctionsActivate' | 'isSavingImmunity' | 'onSaveImmunity' | 'onClearImmunity'
> & {
  api: ApiTransport;
  target: ParticipantCardTarget;
  range: LogsDashboardRange;
  chatTitle: string;
  onRelease: (item: ChatSanctionItem) => Promise<string>;
  describeReason: (item: ChatSanctionItem) => string;
  onImmunityChanged?: () => void;
  onSanctionsChanged?: () => void;
};

export function ChatParticipantCard({
  api,
  target,
  range,
  chatTitle,
  onRelease,
  describeReason,
  onImmunityChanged,
  onSanctionsChanged,
  ...props
}: Props) {
  const [sanctionsOpen, setSanctionsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const immunityLock = useRef(false);
  const [immunitySavedVersion, setImmunitySavedVersion] = useState(0);
  const immunity = useMutation({
    retry: false,
    mutationFn: (payload: ChatParticipantImmunityUpdateRequest) =>
      updateChatParticipantImmunity(api, target.chatId, target.userId, payload),
    onSuccess: (result, payload) => {
      queryClient.setQueriesData<ChatParticipantDetails>(
        { queryKey: participantDetailsKey(target.chatId, target.userId) },
        (current) => (current ? { ...current, immunity: result.immunity } : current),
      );
      setImmunitySavedVersion((value) => value + 1);
      pushToast({ tone: 'success', title: payload.enabled ? 'Защита сохранена' : 'Защита снята' });
      onImmunityChanged?.();
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: 'Не удалось изменить защиту',
        description: describeUserFacingError(error, 'Повторите попытку.'),
      }),
    onSettled: () => {
      immunityLock.current = false;
    },
  });
  const saveImmunity = (payload: ChatParticipantImmunityUpdateRequest) => {
    if (immunityLock.current) return;
    immunityLock.current = true;
    immunity.mutate(payload);
  };
  const details = useQuery({
    queryKey: participantDetailsKey(target.chatId, target.userId, range),
    queryFn: ({ signal }) =>
      getChatParticipantDetails(api, target.chatId, target.userId, range, signal),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const sanctions = useQuery({
    queryKey: ['chat-sanctions', target.chatId, 'participant-summary', target.userId],
    queryFn: ({ signal }) =>
      getChatSanctions(
        api,
        target.chatId,
        { userId: target.userId, status: 'active', action: 'all', limit: 50 },
        signal,
      ),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useNativeBackHandler(
    () => {
      setSanctionsOpen(false);
      return true;
    },
    { enabled: sanctionsOpen, priority: 610 },
  );
  const item: ChatParticipantDetails = details.data ?? {
    userId: target.userId,
    userDisplayName: target.userDisplayName,
    avatarUrl: target.avatarUrl ?? null,
    username: target.username ?? null,
    profileUrl: target.profileUrl ?? null,
    profileHandoffUrl: target.profileHandoffUrl ?? null,
    violationCount: 0,
    immunity: null,
    role: null,
    isBot: false,
    membershipStatus: 'unknown',
    canManage: false,
  };
  const presentedItem = {
    ...item,
    userDisplayName:
      item.userDisplayName === 'Участник' ? target.userDisplayName : item.userDisplayName,
    avatarUrl: item.avatarUrl ?? target.avatarUrl ?? null,
  };
  if (sanctionsOpen)
    return (
      <SettingsDrilldownPanel
        id="participant-sanctions"
        open
        title="Ограничения"
        summary={presentedItem.userDisplayName}
        className="participant-card-sanctions"
        onClose={() => setSanctionsOpen(false)}
        headerAction={
          <button
            type="button"
            className="participant-card__back"
            aria-label="К участнику"
            onClick={() => setSanctionsOpen(false)}
          >
            <NavArrowLeft aria-hidden />
          </button>
        }
      >
        <ChatSanctionsWorkspace
          api={api}
          chatId={target.chatId}
          chatTitle={chatTitle}
          initialUserId={target.userId}
          lockedUserId={target.userId}
          onProfileActivate={props.onProfileActivate}
          isOpeningProfile={props.isOpeningProfile}
          onRelease={onRelease}
          describeReason={describeReason}
          onChanged={() => {
            void queryClient.invalidateQueries({
              queryKey: participantDetailsKey(target.chatId, target.userId),
            });
            onSanctionsChanged?.();
          }}
        />
      </SettingsDrilldownPanel>
    );
  return (
    <ChatParticipantSheet
      {...props}
      savedVersion={(props.savedVersion ?? 0) + immunitySavedVersion}
      isSavingImmunity={immunity.isPending}
      onSaveImmunity={(payload) => saveImmunity({ enabled: true, ...payload })}
      onClearImmunity={() => saveImmunity({ enabled: false })}
      item={presentedItem}
      chatTitle={chatTitle}
      origin={target.origin}
      detailsReady={Boolean(details.data) && !details.isError}
      loadError={
        details.isError
          ? describeUserFacingError(details.error, 'Не удалось загрузить настройки участника.')
          : null
      }
      onRetry={() => {
        void details.refetch();
        void sanctions.refetch();
      }}
      sanctions={sanctions.isError ? null : (sanctions.data ?? null)}
      sanctionsError={sanctions.isError}
      onSanctionsActivate={() => setSanctionsOpen(true)}
    />
  );
}
