import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { MaxActionLedgerService } from './max-action-ledger.service';
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
    @Optional()
    private readonly actionLedgerService?: MaxActionLedgerService,
  ) {}

  async execute(job: MaxActionJob): Promise<void> {
    await this.actionLedgerService?.recordStarted(job);

    try {
      await this.maxClient.executeActionJob(job);
      await this.recordLedgerSucceeded(job);
    } catch (error: unknown) {
      if (await this.handleTerminalManagedEntityError(job, error)) {
        await this.recordLedgerSkipped(job, this.extractErrorMessage(error));
        return;
      }
      await this.recordLedgerFailed(job, error);
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

  private async recordLedgerSucceeded(job: MaxActionJob): Promise<void> {
    try {
      await this.actionLedgerService?.recordSucceeded(job);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record successful MAX action ledger outcome',
      );
    }
  }

  private async recordLedgerSkipped(job: MaxActionJob, reason: string): Promise<void> {
    try {
      await this.actionLedgerService?.recordSkipped(job, reason);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record skipped MAX action ledger outcome',
      );
    }
  }

  private async recordLedgerFailed(job: MaxActionJob, error: unknown): Promise<void> {
    try {
      await this.actionLedgerService?.recordFailed(job, error);
    } catch (ledgerError: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(ledgerError),
          originalError: this.extractErrorMessage(error),
        },
        'Failed to record failed MAX action ledger outcome',
      );
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return String(error).trim();
  }
}
