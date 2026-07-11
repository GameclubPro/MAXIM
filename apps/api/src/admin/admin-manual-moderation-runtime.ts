import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { AdminManualGroupModerationCommandJob } from './admin-manual-fanout.queue';
import type { AdminSuperBanJob } from './admin-super-ban.queue';
import type { AdminManualModerationRuntimeContext } from './admin-manual-moderation-runtime-context';
import { ADMIN_SUPER_BAN_QUEUE_PRIORITY } from './admin.service.support';

export class AdminManualModerationRuntime {
  constructor(private readonly context: AdminManualModerationRuntimeContext) {}

  private get adminSuperBanQueue() {
    return this.context.adminSuperBanQueue;
  }

  private get logger() {
    return this.context.logger;
  }

  private enqueueManualModerationFanout(
    job: Parameters<AdminManualModerationRuntimeContext['enqueueManualModerationFanout']>[0],
  ): Promise<boolean> {
    return this.context.enqueueManualModerationFanout(job);
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    return this.context.isKnownRuntimeBotUserId(userId);
  }

  private isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
    return this.context.isSuperBanDeveloperUserId(userId);
  }

  private processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void> {
    return this.context.processDeveloperSuperBanJob(job);
  }

  private readTrimmedString(value: unknown): string | null {
    return this.context.readTrimmedString(value);
  }

  async enqueueManualGroupModerationCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    const job = this.buildManualGroupModerationCommandJob(params);
    return this.enqueueManualModerationFanout(job);
  }

  async enqueueDeveloperSuperBanCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    if (!this.isSuperBanDeveloperUserId(params.actor.userId)) {
      throw new ForbiddenException(
        'Недостаточно прав: команду `супер бан` может запускать только разработчик бота.',
      );
    }

    if (this.isKnownRuntimeBotUserId(params.targetUserId)) {
      throw new BadRequestException(
        'Команда `супер бан` отклонена: настроенные боты MAX защищены от блокировки.',
      );
    }

    const job = this.buildDeveloperSuperBanCommandJob(params);
    if (!this.adminSuperBanQueue) {
      void this.processDeveloperSuperBanJob(job).catch((error: unknown) => {
        this.logger.warn(
          {
            jobId: job.jobId,
            sourceChatId: job.sourceChatId,
            targetUserId: job.targetUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to process developer super ban without queue',
        );
      });
      return true;
    }

    try {
      await this.adminSuperBanQueue.add('execute-admin-super-ban', job, {
        jobId: job.jobId,
        priority: ADMIN_SUPER_BAN_QUEUE_PRIORITY,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue developer super ban command',
      );
      return false;
    }
  }

  buildManualGroupModerationCommandJob(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): AdminManualGroupModerationCommandJob {
    return {
      kind: 'manual_group_moderation_command',
      jobId: this.buildManualGroupModerationCommandJobId(
        params.sourceChatId,
        params.commandMessageId,
        params.targetUserId,
        params.action,
        params.fanoutAllChats,
      ),
      sourceChatId: params.sourceChatId,
      commandBotId: this.readTrimmedString(params.commandBotId),
      targetUserId: params.targetUserId,
      targetSenderName: params.targetSenderName ?? null,
      targetMessageId: params.targetMessageId ?? null,
      commandMessageId: params.commandMessageId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      action: params.action,
      fanoutAllChats: params.fanoutAllChats === true,
      muteDurationHours: params.muteDurationHours ?? null,
      mutePermanent: params.mutePermanent === true,
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
    };
  }

  buildDeveloperSuperBanCommandJob(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): AdminSuperBanJob {
    return {
      kind: 'developer_super_ban',
      jobId: this.buildDeveloperSuperBanCommandJobId(
        params.sourceChatId,
        params.commandMessageId,
        params.targetUserId,
      ),
      sourceChatId: params.sourceChatId,
      commandBotId: this.readTrimmedString(params.commandBotId),
      targetUserId: params.targetUserId,
      targetSenderName: params.targetSenderName ?? null,
      targetMessageId: params.targetMessageId ?? null,
      commandMessageId: params.commandMessageId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
      retryPolicyName: 'manual-fanout',
      createdAt: new Date().toISOString(),
    };
  }

  buildManualGroupModerationCommandJobId(
    sourceChatId: string,
    commandMessageId: string,
    targetUserId: string,
    action: 'BAN' | 'MUTE',
    fanoutAllChats?: boolean,
  ): string {
    const digest = createHash('sha256')
      .update(
        `${sourceChatId}\n${commandMessageId}\n${targetUserId}\n${action}\n${
          fanoutAllChats === true ? 'all' : 'local'
        }`,
      )
      .digest('hex')
      .slice(0, 32);
    return `manual_group_moderation_command__${digest}`;
  }

  buildDeveloperSuperBanCommandJobId(
    sourceChatId: string,
    commandMessageId: string,
    targetUserId: string,
  ): string {
    const digest = createHash('sha256')
      .update(`${sourceChatId}\n${commandMessageId}\n${targetUserId}\ndeveloper_super_ban`)
      .digest('hex')
      .slice(0, 32);
    return `developer_super_ban__${digest}`;
  }
}
