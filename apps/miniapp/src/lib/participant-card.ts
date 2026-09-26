import type { ChatParticipantItem, LogsDashboardRange } from '@maxim/contracts';

export type ParticipantCardTarget = Pick<ChatParticipantItem, 'userId' | 'userDisplayName'> & {
  chatId: string;
  avatarUrl?: string | null;
  username?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
  origin?: { title: string; date?: string; reason?: string | null };
};

export const participantDetailsKey = (
  chatId: string,
  userId: string,
  range?: LogsDashboardRange,
) =>
  range ? ['participant-details', chatId, userId, range] : ['participant-details', chatId, userId];
