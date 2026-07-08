import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import {
  ManagedEntityAccessLossService,
  type ManagedEntityAccessLossOperation,
} from './managed-entity-access-loss.service';

type TerminalManagedEntityOutcome =
  | {
      kind: 'failed';
      error: UnrecoverableError;
    }
  | {
      kind: 'skipped';
      reason: string;
    };

type MaxActionDispatchExecutionOptions = {
  finalAttempt?: boolean;
};

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

  async execute(job: MaxActionJob, options: MaxActionDispatchExecutionOptions = {}): Promise<void> {
    await this.actionLedgerService?.recordStarted(job);

    try {
      await this.maxClient.executeActionJob(job);
      await this.recordLedgerSucceeded(job);
    } catch (error: unknown) {
      const terminalManagedEntityOutcome = await this.resolveTerminalManagedEntityOutcome(
        job,
        error,
      );
      if (terminalManagedEntityOutcome?.kind === 'skipped') {
        await this.recordLedgerSkipped(job, terminalManagedEntityOutcome.reason);
        return;
      }
      if (terminalManagedEntityOutcome?.kind === 'failed') {
        await this.recordLedgerFailed(job, terminalManagedEntityOutcome.error);
        throw terminalManagedEntityOutcome.error;
      }
      await this.recordLedgerFailed(job, error, {
        exhausted: options.finalAttempt === true,
      });
      throw error;
    }
  }

  private async resolveTerminalManagedEntityOutcome(
    job: MaxActionJob,
    error: unknown,
  ): Promise<TerminalManagedEntityOutcome | null> {
    if (!this.managedEntityAccessLossService) {
      return null;
    }

    const operation = this.resolveAccessLossOperation(job);
    if (!operation) {
      return null;
    }

    const result = await this.managedEntityAccessLossService.recordIfManagedEntityAccessLost({
      chatId: job.chatId,
      botId: job.botId,
      operation,
      source: `max_action:${job.actionType.toLowerCase()}`,
      error,
    });

    if (!result) {
      return null;
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
      return {
        kind: 'skipped',
        reason: this.extractErrorMessage(error),
      };
    }

    if (result.reason) {
      return {
        kind: 'failed',
        error: this.createTerminalManagedEntityError(job, result.reason, error),
      };
    }

    return null;
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

  private async recordLedgerFailed(
    job: MaxActionJob,
    error: unknown,
    options: { exhausted?: boolean } = {},
  ): Promise<void> {
    try {
      if (options.exhausted === undefined) {
        await this.actionLedgerService?.recordFailed(job, error);
      } else {
        await this.actionLedgerService?.recordFailed(job, error, options);
      }
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

  private createTerminalManagedEntityError(
    job: MaxActionJob,
    reason: string,
    error: unknown,
  ): UnrecoverableError {
    const terminalError = new UnrecoverableError(
      `MAX ${job.actionType} cannot be retried for chat ${job.chatId}: ${reason}`,
    );
    const response = (error as { response?: unknown })?.response;
    if (response !== undefined) {
      (terminalError as UnrecoverableError & { response?: unknown }).response = response;
    }
    const code = (error as { code?: unknown })?.code;
    if (code !== undefined) {
      (terminalError as UnrecoverableError & { code?: unknown }).code = code;
    }
    return terminalError;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return String(error).trim();
  }
}
