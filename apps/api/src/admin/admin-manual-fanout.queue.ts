import type { AdminActionSource, ManualModerationFanoutSource } from './admin.service.support';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const ADMIN_MANUAL_FANOUT_QUEUE = 'admin-manual-fanout';

type ManualFanoutQueueMetadata = {
  retryPolicyName?: Extract<QueueRetryPolicyName, 'manual-fanout'>;
};

type AdminManualFanoutActor = {
  userId: string;
  username: string | null;
  displayName: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
};

export type AdminManualMuteFanoutJob = QueueJobEnvelope<
  {
    kind: 'manual_mute_fanout';
    jobId: string;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    cleanupSourceChatMessages?: boolean;
    actor: AdminManualFanoutActor;
    muteDurationHours: number | null;
    muteExpiresAt: string | null;
    mutePermanent?: boolean;
    source: ManualModerationFanoutSource;
  },
  ManualFanoutQueueMetadata
>;

export type AdminManualBanFanoutJob = QueueJobEnvelope<
  {
    kind: 'manual_ban_fanout';
    jobId: string;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    actor: AdminManualFanoutActor;
    source: Extract<AdminActionSource, 'miniapp' | 'group_command' | 'private_command'>;
  },
  ManualFanoutQueueMetadata
>;

export type AdminManualBanSourceCleanupJob = QueueJobEnvelope<
  {
    kind: 'manual_ban_source_cleanup';
    jobId: string;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    actor: AdminManualFanoutActor;
    source: Extract<AdminActionSource, 'miniapp' | 'group_command' | 'private_command'>;
    botId?: string | null;
  },
  ManualFanoutQueueMetadata
>;

export type AdminManualGroupModerationCommandJob = QueueJobEnvelope<
  {
    kind: 'manual_group_moderation_command';
    jobId: string;
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AdminManualFanoutActor;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  },
  ManualFanoutQueueMetadata
>;

export type AdminManualFanoutJob =
  | AdminManualMuteFanoutJob
  | AdminManualBanFanoutJob
  | AdminManualBanSourceCleanupJob
  | AdminManualGroupModerationCommandJob;
