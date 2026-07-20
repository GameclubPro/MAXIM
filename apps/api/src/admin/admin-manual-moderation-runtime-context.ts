import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';

import type { AdminManualFanoutJob } from './admin-manual-fanout.queue';
import type { AdminSuperBanJob } from './admin-super-ban.queue';

export type ManualGroupMuteFollowUpInput = {
  sourceChatId: string;
  targetUserId: string;
  actor: AuthUser;
  rootIntentKey: string;
  muteDurationHours: number | null;
  muteExpiresAt: Date | null;
  mutePermanent: boolean;
  source: 'group_command';
};

export type AdminManualModerationRuntimeContext = {
  readonly logger: Logger;
  readonly adminSuperBanQueue?: Queue<AdminSuperBanJob>;
  enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean>;
  isKnownRuntimeBotUserId(userId: string | null | undefined): boolean;
  isSuperBanDeveloperUserId(userId: string | null | undefined): boolean;
  processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void>;
  resolveManualMuteCommandFollowUpSummaries(
    params: ManualGroupMuteFollowUpInput,
  ): Promise<unknown>;
  readTrimmedString(value: unknown): string | null;
};

type AdminManualModerationRuntimeContextTarget = {
  logger: Logger;
  adminSuperBanQueue?: Queue<AdminSuperBanJob>;
  enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean>;
  isKnownRuntimeBotUserId(userId: string | null | undefined): boolean;
  isSuperBanDeveloperUserId(userId: string | null | undefined): boolean;
  processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void>;
  resolveManualMuteCommandFollowUpSummaries(
    params: ManualGroupMuteFollowUpInput,
  ): Promise<unknown>;
  readTrimmedString(value: unknown): string | null;
};

export function createAdminManualModerationRuntimeContext(
  target: object,
): AdminManualModerationRuntimeContext {
  const typedTarget = target as AdminManualModerationRuntimeContextTarget;

  return {
    get logger(): Logger {
      return typedTarget.logger;
    },
    get adminSuperBanQueue(): Queue<AdminSuperBanJob> | undefined {
      return typedTarget.adminSuperBanQueue;
    },
    enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean> {
      return typedTarget.enqueueManualModerationFanout(job);
    },
    isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
      return typedTarget.isKnownRuntimeBotUserId(userId);
    },
    isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
      return typedTarget.isSuperBanDeveloperUserId(userId);
    },
    processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void> {
      return typedTarget.processDeveloperSuperBanJob(job);
    },
    resolveManualMuteCommandFollowUpSummaries(
      params: ManualGroupMuteFollowUpInput,
    ): Promise<unknown> {
      return typedTarget.resolveManualMuteCommandFollowUpSummaries(params);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
  };
}
