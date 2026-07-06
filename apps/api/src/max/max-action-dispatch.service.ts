import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import {
  ManagedEntityAccessLossService,
  type ManagedEntityAccessLossOperation,
} from './managed-entity-access-loss.service';

@Injectable()
export class MaxActionDispatchService {
  private readonly logger = new Logger(MaxActionDispatchService.name);

  constructor(
    private readonly maxClient: MaxClientService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {}

  async execute(job: MaxActionJob): Promise<void> {
    try {
      await this.maxClient.executeActionJob(job);
    } catch (error: unknown) {
      if (await this.handleTerminalManagedEntityError(job, error)) {
        return;
      }
      throw error;
    }
  }

  private async handleTerminalManagedEntityError(
    job: MaxActionJob,
    error: unknown,
  ): Promise<boolean> {
    if (!this.managedEntityAccessLossService) {
      return false;
    }

    const operation = this.resolveAccessLossOperation(job);
    if (!operation) {
      return false;
    }

    const result = await this.managedEntityAccessLossService.recordIfManagedEntityAccessLost({
      chatId: job.chatId,
      botId: job.botId,
      operation,
      source: `max_action:${job.actionType.toLowerCase()}`,
      error,
    });

    if (!result) {
      return false;
    }

    if (result.classification.kind === 'message_not_found' && job.actionType === 'DELETE_MESSAGE') {
      this.logger.debug(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          actionType: job.actionType,
          code: result.classification.code,
        },
        'Skipped queued MAX delete for already missing message',
      );
      return true;
    }

    if (result.reason) {
      throw new UnrecoverableError(
        `MAX ${job.actionType} cannot be retried for chat ${job.chatId}: ${result.reason}`,
      );
    }

    return false;
  }

  private resolveAccessLossOperation(job: MaxActionJob): ManagedEntityAccessLossOperation | null {
    switch (job.actionType) {
      case 'DELETE_MESSAGE':
        return 'delete';
      case 'SEND_MESSAGE':
      case 'NOTIFY_MODERATORS':
        return 'send';
      case 'KICK_MEMBER':
      case 'BAN_MEMBER':
      case 'UNBAN_MEMBER':
        return 'member_moderation';
      default:
        return null;
    }
  }
}
