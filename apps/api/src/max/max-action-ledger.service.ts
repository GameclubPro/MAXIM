import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
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

export type MaxSendDispatchClaim =
  | {
      kind: 'claimed';
      dispatchToken: string;
    }
  | {
      kind: 'recovered';
      remoteMessageId: string;
    };

export type MaxCompletedSendDispatch = {
  remoteMessageId: string;
  dispatchBotId: string | null;
};

type MaxSendDispatchLedgerFinalizedError = Error & {
  maxSendDispatchLedgerFinalized?: boolean;
};

export function markMaxSendDispatchLedgerFinalized<T extends Error>(error: T): T {
  (error as T & MaxSendDispatchLedgerFinalizedError).maxSendDispatchLedgerFinalized = true;
  return error;
}

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
        dispatchToken: true,
        dispatchStartedAt: true,
        remoteMessageId: true,
      },
    });

    if (row?.remoteMessageId) {
      return;
    }

    if (row?.dispatchToken || row?.dispatchStartedAt) {
      throw new UnrecoverableError(
        `Retained unresolved MAX ${job.actionType} dispatch ${job.idempotencyKey} requires manual review before retry`,
      );
    }

    if (job.actionType === 'SEND_MESSAGE' && row?.terminal) {
      throw new UnrecoverableError(
        `Retained terminal MAX SEND_MESSAGE ledger entry ${job.idempotencyKey} has no recoverable remote message id`,
      );
    }

    if (!row?.ambiguous || !row.terminal || row.status !== MaxActionLedgerStatus.AMBIGUOUS) {
      return;
    }

    throw new UnrecoverableError(
      `Retained ambiguous MAX ${job.actionType} ledger entry ${job.idempotencyKey} requires manual review before retry`,
    );
  }

  async recordEnqueued(job: MaxActionJob): Promise<void> {
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.ENQUEUED,
      ambiguous: false,
      terminal: false,
      enqueuedAt: new Date(),
      completedAt: null,
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.recordProtectedSendTransition(job, mutation);
      return;
    }
    await this.upsert(job, mutation);
  }

  async recordStarted(job: MaxActionJob): Promise<void> {
    const now = new Date();
    const mutation: MaxActionLedgerMutation = {
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      firstAttemptAt: now,
      lastAttemptAt: now,
      completedAt: null,
      incrementAttempt: true,
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.recordProtectedSendTransition(job, mutation);
      return;
    }
    await this.upsert(job, mutation);
  }

  async recordPrepared(job: MaxActionJob): Promise<void> {
    this.assertSendAction(job);
    const prepared = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: this.buildUpdateInput(job),
    });
    if (prepared.count === 1) {
      return;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (row?.remoteMessageId) {
      return;
    }

    throw new UnrecoverableError(
      `MAX SEND_MESSAGE ledger context could not be persisted before dispatch ${job.idempotencyKey}`,
    );
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

  async claimSendDispatch(job: MaxActionJob, botId: string): Promise<MaxSendDispatchClaim> {
    this.assertSendAction(job);
    const normalizedBotId = this.nullableString(botId);
    if (!normalizedBotId) {
      throw new Error(`botId is required to claim MAX SEND_MESSAGE dispatch ${job.idempotencyKey}`);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const dispatchToken = randomUUID();
      const claimed = await this.prisma.maxActionLedgerEntry.updateMany({
        where: {
          jobId: job.idempotencyKey,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        },
        data: {
          dispatchToken,
          dispatchStartedAt: new Date(),
          dispatchBotId: normalizedBotId,
        },
      });
      if (claimed.count === 1) {
        return {
          kind: 'claimed',
          dispatchToken,
        };
      }

      const row = await this.readSendDispatchState(job.idempotencyKey);
      if (row?.remoteMessageId) {
        return {
          kind: 'recovered',
          remoteMessageId: row.remoteMessageId,
        };
      }

      const error = new UnrecoverableError(
        `Ambiguous MAX SEND_MESSAGE dispatch fence for job ${job.idempotencyKey} requires manual review before retry`,
      );
      if (row?.dispatchToken) {
        const quarantined = await this.recordAmbiguousSendDispatch(job, row.dispatchToken, error);
        if (quarantined) {
          throw markMaxSendDispatchLedgerFinalized(error);
        }
        continue;
      }

      if (row?.ambiguous && row.terminal) {
        throw markMaxSendDispatchLedgerFinalized(error);
      }

      throw error;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (row?.remoteMessageId) {
      return {
        kind: 'recovered',
        remoteMessageId: row.remoteMessageId,
      };
    }
    throw new UnrecoverableError(
      `Ambiguous MAX SEND_MESSAGE dispatch fence race for job ${job.idempotencyKey} requires manual review`,
    );
  }

  async completeSendDispatch(
    job: MaxActionJob,
    dispatchToken: string,
    remoteMessageId: string,
  ): Promise<void> {
    this.assertSendAction(job);
    const normalizedToken = this.requireDispatchToken(dispatchToken);
    const normalizedRemoteMessageId = this.nullableString(remoteMessageId);
    if (!normalizedRemoteMessageId) {
      throw new Error(
        `remoteMessageId is required to complete MAX SEND_MESSAGE ${job.idempotencyKey}`,
      );
    }

    let completed: { count: number };
    try {
      completed = await this.prisma.maxActionLedgerEntry.updateMany({
        where: {
          jobId: job.idempotencyKey,
          dispatchToken: normalizedToken,
          remoteMessageId: null,
        },
        data: {
          remoteMessageId: normalizedRemoteMessageId,
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          completedAt: new Date(),
          lastStatusCode: null,
          lastErrorCode: null,
          lastError: null,
        },
      });
    } catch (error: unknown) {
      const recovered = await this.getCompletedSendDispatch(job).catch(() => null);
      if (recovered === normalizedRemoteMessageId) {
        return;
      }
      throw error;
    }
    if (completed.count === 1) {
      return;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (row?.remoteMessageId === normalizedRemoteMessageId) {
      return;
    }

    throw new UnrecoverableError(
      `Ambiguous MAX SEND_MESSAGE completion fence for job ${job.idempotencyKey}: remote message id was not persisted`,
    );
  }

  async getCompletedSendDispatch(job: MaxActionJob): Promise<string | null> {
    return (await this.getCompletedSendDispatchResult(job))?.remoteMessageId ?? null;
  }

  async getCompletedSendDispatchResult(
    job: MaxActionJob,
  ): Promise<MaxCompletedSendDispatch | null> {
    if (job.actionType !== 'SEND_MESSAGE') {
      return null;
    }
    const state = await this.readSendDispatchState(job.idempotencyKey);
    if (!state?.remoteMessageId) {
      return null;
    }
    return {
      remoteMessageId: state.remoteMessageId,
      dispatchBotId: this.nullableString(state.dispatchBotId),
    };
  }

  async releaseSendDispatch(job: MaxActionJob, dispatchToken: string): Promise<void> {
    this.assertSendAction(job);
    const normalizedToken = this.requireDispatchToken(dispatchToken);
    const released = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: normalizedToken,
        remoteMessageId: null,
      },
      data: {
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        completedAt: null,
      },
    });
    if (released.count === 1) {
      return;
    }

    const row = await this.readSendDispatchState(job.idempotencyKey);
    if (row?.remoteMessageId || !row?.dispatchToken) {
      return;
    }

    throw new Error(
      `MAX SEND_MESSAGE dispatch fence changed before release for ${job.idempotencyKey}`,
    );
  }

  async recordAmbiguousSendDispatch(
    job: MaxActionJob,
    dispatchToken: string,
    error: unknown,
  ): Promise<boolean> {
    this.assertSendAction(job);
    const quarantined = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: this.requireDispatchToken(dispatchToken),
        remoteMessageId: null,
      },
      data: {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        completedAt: new Date(),
        lastStatusCode: this.extractStatusCode(error),
        lastErrorCode: this.extractErrorCode(error),
        lastError: this.extractErrorMessage(error),
      },
    });
    return quarantined.count === 1;
  }

  async recordFailed(
    job: MaxActionJob,
    error: unknown,
    options: MaxActionLedgerFailureOptions = {},
  ): Promise<void> {
    if (this.isSendDispatchLedgerFinalizedError(error)) {
      return;
    }
    const ambiguous = this.isAmbiguousFailure(error);
    const terminal = ambiguous || error instanceof UnrecoverableError || options.exhausted === true;
    const mutation: MaxActionLedgerMutation = {
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
    };
    if (job.actionType === 'SEND_MESSAGE') {
      await this.recordProtectedSendFailure(job, mutation);
      return;
    }
    await this.upsert(job, mutation);
  }

  private async upsert(job: MaxActionJob, mutation: MaxActionLedgerMutation): Promise<void> {
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

  private async recordProtectedSendTransition(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    await this.prisma.maxActionLedgerEntry.upsert({
      where: {
        jobId: job.idempotencyKey,
      },
      create: this.buildCreateInput(job),
      update: {},
    });
    await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
        ...(mutation.incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      },
    });
  }

  private async recordProtectedSendFailure(
    job: MaxActionJob,
    mutation: MaxActionLedgerMutation,
  ): Promise<void> {
    await this.prisma.maxActionLedgerEntry.upsert({
      where: {
        jobId: job.idempotencyKey,
      },
      create: {
        ...this.buildCreateInput(job),
        ...this.buildPlainMutationInput(mutation),
      },
      update: {},
    });
    await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        jobId: job.idempotencyKey,
        remoteMessageId: null,
      },
      data: {
        ...this.buildUpdateInput(job),
        ...this.buildPlainMutationInput(mutation),
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
      ...(mutation.firstAttemptAt !== undefined ? { firstAttemptAt: mutation.firstAttemptAt } : {}),
      ...(mutation.lastAttemptAt !== undefined ? { lastAttemptAt: mutation.lastAttemptAt } : {}),
      ...(mutation.completedAt !== undefined ? { completedAt: mutation.completedAt } : {}),
      ...(mutation.lastStatusCode !== undefined ? { lastStatusCode: mutation.lastStatusCode } : {}),
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

  private buildUpdateInput(job: MaxActionJob): Prisma.MaxActionLedgerEntryUpdateManyMutationInput {
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
      candidateBotIds: Array.isArray(job.candidateBotIds) ? job.candidateBotIds : [],
      attemptedBotIds: Array.isArray(job.attemptedBotIds) ? job.attemptedBotIds : [],
      routing: job.routing
        ? {
            purpose: job.routing.purpose,
            primaryBotId: job.routing.primaryBotId ?? null,
            reason: job.routing.reason ?? null,
            action: job.routing.action ?? null,
            routingVersion: job.routing.routingVersion ?? null,
          }
        : null,
      ledgerContext: job.ledgerContext ?? null,
    };
  }

  private isAmbiguousFailure(error: unknown): boolean {
    return this.extractErrorMessage(error).includes('ambiguous max');
  }

  private isSendDispatchLedgerFinalizedError(error: unknown): boolean {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as MaxSendDispatchLedgerFinalizedError).maxSendDispatchLedgerFinalized === true
    );
  }

  private assertSendAction(job: MaxActionJob): void {
    if (job.actionType !== 'SEND_MESSAGE') {
      throw new Error(`Dispatch fence is only valid for SEND_MESSAGE, received ${job.actionType}`);
    }
  }

  private requireDispatchToken(value: string): string {
    const normalized = this.nullableString(value);
    if (!normalized) {
      throw new Error('dispatchToken is required for MAX SEND_MESSAGE dispatch fence');
    }
    return normalized;
  }

  private async readSendDispatchState(jobId: string) {
    return this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId,
      },
      select: {
        status: true,
        ambiguous: true,
        terminal: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
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
