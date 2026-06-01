import type { QueueJobEnvelope } from '../common/queue-job-envelope';

export const ADMIN_SUPER_BAN_QUEUE = 'admin-super-ban';

type AdminSuperBanActor = {
  userId: string;
  username: string | null;
  displayName: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
};

export type AdminSuperBanJob = QueueJobEnvelope<{
  kind: 'developer_super_ban';
  jobId: string;
  sourceChatId: string;
  commandBotId?: string | null;
  targetUserId: string;
  targetSenderName?: string | null;
  targetMessageId?: string | null;
  commandMessageId: string;
  actor: AdminSuperBanActor;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
}>;
