import type { AdminActionSource } from './admin.service';

export const ADMIN_MANUAL_FANOUT_QUEUE = 'admin-manual-fanout';

type AdminManualFanoutActor = {
  userId: string;
  username: string | null;
  displayName: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
};

export type AdminManualMuteFanoutJob = {
  kind: 'manual_mute_fanout';
  jobId: string;
  sourceChatId: string;
  targetUserId: string;
  cleanupSourceChatMessages?: boolean;
  actor: AdminManualFanoutActor;
  muteDurationHours: number | null;
  muteExpiresAt: string | null;
  mutePermanent?: boolean;
  source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
};

export type AdminManualBanFanoutJob = {
  kind: 'manual_ban_fanout';
  jobId: string;
  sourceChatId: string;
  targetUserId: string;
  actor: AdminManualFanoutActor;
  source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
};

export type AdminManualGroupModerationCommandJob = {
  kind: 'manual_group_moderation_command';
  jobId: string;
  sourceChatId: string;
  targetUserId: string;
  targetSenderName?: string | null;
  targetMessageId?: string | null;
  commandMessageId: string;
  actor: AdminManualFanoutActor;
  action: 'BAN' | 'MUTE';
  muteDurationHours?: number | null;
  mutePermanent?: boolean;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
};

export type AdminManualFanoutJob =
  | AdminManualMuteFanoutJob
  | AdminManualBanFanoutJob
  | AdminManualGroupModerationCommandJob;
