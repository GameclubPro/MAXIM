import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { MaxActionLedgerStatus, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { MaxActionJob, MaxActionType } from './max-client.service';

const IRREVERSIBLE_ACTION_TYPES: ReadonlySet<MaxActionType> = new Set([
  'SEND_MESSAGE',
  'KICK_MEMBER',
  'BAN_MEMBER',
]);

type MaxActionLedgerMutation = {
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  enqueuedAt?: Date | null;
  firstAttemptAt?: Date | null;
  lastAttemptAt?: Date | null;
  completedAt?: Date | null;
  lastStatusCode?: number | null;
  lastErrorCode?: string | null;
  lastError?: string | null;
  incrementAttempt?: boolean;
};

type MaxActionLedgerFailureOptions = {
  exhausted?: boolean;
};

@Injectable()
export class MaxActionLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  isIrreversibleAction(actionType: MaxActionType): boolean {
    return IRREVERSIBLE_ACTION_TYPES.has(actionType);
  }

  async assertCanEnqueue(job: MaxActionJob): Promise<void> {
    if (!this.isIrreversibleAction(job.actionType)) {
      return;
    }

    const row = await this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId: job.idempotencyKey,
      },
      select: {
        status: true,
        ambiguous: true,
        terminal: true,
        lastError: true,
      },
    });

    if (!row?.ambiguous || !row.terminal || row.status !== MaxActionLedgerStatus.AMBIGUOUS) {
      return;
    }

    throw new UnrecoverableError(
      `Retained ambiguous MAX ${job.actionType} ledger entry ${job.idempotencyKey} requires manual review before retry`,
    );
  }

  async recordEnqueued(job: MaxActionJob): Promise<void> {
    await this.upsert(job, {
      status: MaxActionLedgerStatus.ENQUEUED,
      ambiguous: false,
      terminal: false,
      enqueuedAt: new Date(),
      completedAt: null,
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    });
  }

  async recordStarted(job: MaxActionJob): Promise<void> {
    const now = new Date();
    await this.upsert(job, {
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      firstAttemptAt: now,
      lastAttemptAt: now,
      completedAt: null,
      incrementAttempt: true,
    });
  }

  async recordSucceeded(job: MaxActionJob): Promise<void> {
    await this.upsert(job, {
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date(),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    });
  }

  async recordSkipped(job: MaxActionJob, reason: string): Promise<void> {
    await this.upsert(job, {
      status: MaxActionLedgerStatus.SKIPPED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date(),
      lastError: this.truncate(reason),
    });
  }

  async recordFailed(
    job: MaxActionJob,
    error: unknown,
    options: MaxActionLedgerFailureOptions = {},
  ): Promise<void> {
    const ambiguous = this.isAmbiguousFailure(error);
    const terminal = ambiguous || error instanceof UnrecoverableError || options.exhausted === true;
    await this.upsert(job, {
      status: ambiguous
        ? MaxActionLedgerStatus.AMBIGUOUS
        : terminal
          ? error instanceof UnrecoverableError
            ? MaxActionLedgerStatus.FAILED_TERMINAL
            : MaxActionLedgerStatus.FAILED_RETRYABLE
          : MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous,
      terminal,
      completedAt: terminal ? new Date() : null,
      lastStatusCode: this.extractStatusCode(error),
      lastErrorCode: this.extractErrorCode(error),
      lastError: this.extractErrorMessage(error),
    });
  }

  private async upsert(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    const create = this.buildCreateInput(job);
    await this.prisma.maxActionLedgerEntry.upsert({
      where: {
        jobId: job.idempotencyKey,
      },
      create: {
        ...create,
        ...this.buildPlainMutationInput(mutation),
        attemptCount: mutation.incrementAttempt ? Math.max(1, job.attempt) : create.attemptCount,
      },
      update: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
        ...(mutation.incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      },
    });
  }

  private buildPlainMutationInput(
    mutation: MaxActionLedgerMutation,
  ): Omit<Prisma.MaxActionLedgerEntryCreateInput, 'id' | 'jobId' | 'actionType' | 'chatId'> {
    return {
      status: mutation.status,
      ambiguous: mutation.ambiguous,
      terminal: mutation.terminal,
      ...(mutation.enqueuedAt !== undefined ? { enqueuedAt: mutation.enqueuedAt } : {}),
      ...(mutation.firstAttemptAt !== undefined
        ? { firstAttemptAt: mutation.firstAttemptAt }
        : {}),
      ...(mutation.lastAttemptAt !== undefined ? { lastAttemptAt: mutation.lastAttemptAt } : {}),
      ...(mutation.completedAt !== undefined ? { completedAt: mutation.completedAt } : {}),
      ...(mutation.lastStatusCode !== undefined
        ? { lastStatusCode: mutation.lastStatusCode }
        : {}),
      ...(mutation.lastErrorCode !== undefined ? { lastErrorCode: mutation.lastErrorCode } : {}),
      ...(mutation.lastError !== undefined ? { lastError: mutation.lastError } : {}),
    };
  }

  private buildCreateInput(job: MaxActionJob): Prisma.MaxActionLedgerEntryCreateInput {
    return {
      jobId: job.idempotencyKey,
      actionType: job.actionType,
      chatId: job.chatId,
      botId: this.nullableString(job.botId),
      messageId: this.nullableString(job.messageId),
      userId: this.nullableString(job.userId),
      sourceTag: this.nullableString(job.sourceTag),
      trafficClass: this.nullableString(job.trafficClass),
      actionHealthLane: this.nullableString(job.actionHealthLane),
      attemptCount: 0,
      metadata: this.buildMetadata(job),
    };
  }

  private buildUpdateInput(job: MaxActionJob): Prisma.MaxActionLedgerEntryUpdateInput {
    return {
      actionType: job.actionType,
      chatId: job.chatId,
      botId: this.nullableString(job.botId),
      messageId: this.nullableString(job.messageId),
      userId: this.nullableString(job.userId),
      sourceTag: this.nullableString(job.sourceTag),
      trafficClass: this.nullableString(job.trafficClass),
      actionHealthLane: this.nullableString(job.actionHealthLane),
      metadata: this.buildMetadata(job),
    };
  }

  private buildMetadata(job: MaxActionJob): Prisma.InputJsonObject {
    return {
      createdAt: job.createdAt,
      hasText: typeof job.text === 'string',
      textLength: typeof job.text === 'string' ? job.text.length : 0,
      hasOptions: Boolean(job.options),
      optionKeys:
        job.options && typeof job.options === 'object'
          ? Object.keys(job.options).sort().slice(0, 20)
          : [],
      autoDeleteDelayMs:
        typeof job.autoDeleteDelayMs === 'number' && Number.isFinite(job.autoDeleteDelayMs)
          ? Math.trunc(job.autoDeleteDelayMs)
          : null,
      ignoreFailureMetricStatuses: Array.isArray(job.ignoreFailureMetricStatuses)
        ? job.ignoreFailureMetricStatuses
        : [],
    };
  }

  private isAmbiguousFailure(error: unknown): boolean {
    return this.extractErrorMessage(error).includes('ambiguous max');
  }

  private extractStatusCode(error: unknown): number | null {
    const value = (error as { response?: { status?: unknown } })?.response?.status;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }

  private extractErrorCode(error: unknown): string | null {
    const value = (error as { response?: { data?: { code?: unknown } }; code?: unknown })?.response
      ?.data?.code;
    if (typeof value === 'string' && value.trim().length > 0) {
      return this.truncate(value.trim().toLowerCase(), 128);
    }

    const directCode = (error as { code?: unknown })?.code;
    return typeof directCode === 'string' && directCode.trim().length > 0
      ? this.truncate(directCode.trim().toLowerCase(), 128)
      : null;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return this.truncate(responseMessage.trim().toLowerCase());
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return this.truncate(error.message.trim().toLowerCase());
    }

    return this.truncate(String(error).trim().toLowerCase());
  }

  private nullableString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private truncate(value: string, maxLength = 2_000): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
