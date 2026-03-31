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
  actor: AdminManualFanoutActor;
  muteDurationHours: number;
  muteExpiresAt: string;
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

export type AdminManualFanoutJob = AdminManualMuteFanoutJob | AdminManualBanFanoutJob;
