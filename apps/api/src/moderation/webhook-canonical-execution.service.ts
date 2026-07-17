import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

import { Prisma, WebhookStatus, type WebhookEvent } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';

const WEBHOOK_CANONICAL_BUSINESS_LEASE_MS = 5 * 60_000;
export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED';
const WEBHOOK_EVENT_ERROR_MESSAGE_MAX_LENGTH = 500;

type WebhookExecutionClaimRecord = {
  id?: string;
  webhookEventId?: string;
  executionBotId?: string | null;
  enforced?: boolean;
  status?: string;
  completedAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
};

type WebhookExecutionClaimModel = {
  findFirst?: (args: unknown) => Promise<WebhookExecutionClaimRecord | null>;
  findUnique?: (args: unknown) => Promise<WebhookExecutionClaimRecord | null>;
  updateMany?: (args: unknown) => Promise<{ count?: number }>;
};

const WEBHOOK_EXECUTION_CLAIM_SELECT = {
  id: true,
  webhookEventId: true,
  executionBotId: true,
  enforced: true,
  status: true,
  completedAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
} as const;

export type WebhookCanonicalExecutionContext = {
  webhookEvent: WebhookEvent;
  update: MaxUpdate;
  activeBotId: string | null;
  businessLeaseToken: string | null;
};

@Injectable()
export class WebhookCanonicalExecutionService {
  private readonly logger = new Logger(WebhookCanonicalExecutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prepareExecution(
    webhookEventId: string,
    defaultBotId: string | null | undefined,
  ): Promise<WebhookCanonicalExecutionContext | null> {
    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });

    if (!webhookEvent) {
      return null;
    }
    if (
      webhookEvent.status === WebhookStatus.DUPLICATE ||
      webhookEvent.status === WebhookStatus.PROCESSED
    ) {
      return null;
    }
    if (this.isHotPathTimeoutQuarantined(webhookEvent)) {
      this.logger.warn(
        { webhookEventId: webhookEvent.id },
        'Skipped webhook execution that is quarantined after a hot-path timeout',
      );
      return null;
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const executionClaimModel = this.executionClaimModel;
    const semanticKey = buildWebhookSemanticEventKey(update);
    const semanticClaim =
      semanticKey && typeof executionClaimModel?.findUnique === 'function'
        ? await executionClaimModel.findUnique({
            where: {
              kind_semanticKey: {
                kind: 'EXECUTION',
                semanticKey,
              },
            },
            select: WEBHOOK_EXECUTION_CLAIM_SELECT,
          })
        : null;
    const executionClaim =
      semanticClaim ??
      (typeof executionClaimModel?.findFirst === 'function'
        ? await executionClaimModel.findFirst({
            where: {
              webhookEventId: webhookEvent.id,
              kind: 'EXECUTION',
            },
            select: WEBHOOK_EXECUTION_CLAIM_SELECT,
          })
        : null);

    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId &&
      executionClaim.webhookEventId !== webhookEvent.id
    ) {
      this.logger.warn(
        { webhookEventId: webhookEvent.id },
        'Skipped active non-canonical mirrored webhook job at the worker fence',
      );
      return null;
    }
    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId === webhookEvent.id &&
      executionClaim.status !== 'READY' &&
      executionClaim.status !== 'COMPLETED'
    ) {
      throw new Error(`Canonical webhook claim is not ready for ${webhookEvent.id}`);
    }
    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId === webhookEvent.id &&
      executionClaim.status === 'COMPLETED'
    ) {
      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEvent.id,
          status: { not: WebhookStatus.PROCESSED },
        },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: executionClaim.completedAt ?? new Date(),
          errorMessage: null,
          nextEnqueueAt: null,
        },
      });
      return null;
    }

    const businessLeaseToken = await this.acquireBusinessLease({
      webhookEventId: webhookEvent.id,
      executionClaim,
      executionClaimModel,
    });

    const context: WebhookCanonicalExecutionContext = {
      webhookEvent,
      update,
      activeBotId:
        this.normalizeBotId(executionClaim?.executionBotId) ??
        this.normalizeBotId(webhookEvent.botId) ??
        this.normalizeBotId(update.botId) ??
        this.normalizeBotId(defaultBotId),
      businessLeaseToken,
    };

    // Recheck after a fenced claim: another worker can have read this event before a timeout
    // quarantine was persisted, then win the claim after its original owner finishes.
    if (businessLeaseToken) {
      const latestWebhookEvent = await this.prisma.webhookEvent.findUnique({
        where: { id: webhookEvent.id },
      });
      if (
        !latestWebhookEvent ||
        latestWebhookEvent.status === WebhookStatus.DUPLICATE ||
        latestWebhookEvent.status === WebhookStatus.PROCESSED ||
        this.isHotPathTimeoutQuarantined(latestWebhookEvent)
      ) {
        await this.releaseBusinessLease(context);
        if (latestWebhookEvent && this.isHotPathTimeoutQuarantined(latestWebhookEvent)) {
          this.logger.warn(
            { webhookEventId: latestWebhookEvent.id },
            'Released a stale canonical claim after a hot-path timeout quarantine',
          );
        }
        return null;
      }
    }

    return context;
  }

  async completeExecution(context: WebhookCanonicalExecutionContext): Promise<void> {
    const executionClaimModel = this.executionClaimModel;
    if (typeof executionClaimModel?.updateMany === 'function') {
      const completion = await executionClaimModel.updateMany({
        where: {
          webhookEventId: context.webhookEvent.id,
          kind: 'EXECUTION',
          ...(context.businessLeaseToken ? { leaseToken: context.businessLeaseToken } : {}),
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (context.businessLeaseToken && completion?.count !== 1) {
        throw new Error(
          `Canonical webhook business lease was lost before completion for ${context.webhookEvent.id}`,
        );
      }
    }

    await this.prisma.webhookEvent.update({
      where: { id: context.webhookEvent.id },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        errorMessage: null,
        nextEnqueueAt: null,
      },
    });
  }

  async failExecution(
    context: WebhookCanonicalExecutionContext,
    params: { errorMessage: string; terminal: boolean; retryAfterMs?: number },
  ): Promise<void> {
    await this.releaseBusinessLease(context);

    const requestedRetryAfterMs = Math.trunc(params.retryAfterMs ?? 0);
    const retryAfterMs =
      Number.isFinite(requestedRetryAfterMs) && requestedRetryAfterMs > 0
        ? requestedRetryAfterMs
        : 15_000;

    const recoveredRawPayload =
      context.update.raw &&
      typeof context.update.raw === 'object' &&
      !Array.isArray(context.update.raw)
        ? (context.update.raw as Record<string, unknown>)
        : null;
    await this.prisma.webhookEvent.update({
      where: { id: context.webhookEvent.id },
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: params.errorMessage,
        nextEnqueueAt: params.terminal ? null : new Date(Date.now() + retryAfterMs),
        ...(recoveredRawPayload
          ? { rawPayload: recoveredRawPayload as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  // FLAG: A watchdog timeout can leave a MAX action in flight, so retain its lease and quarantine replay.
  async quarantineTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    params: { errorMessage: string },
  ): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: context.webhookEvent.id },
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: this.buildHotPathTimeoutQuarantineMessage(params.errorMessage),
        nextEnqueueAt: null,
      },
    });
  }

  async failTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    params: { errorMessage: string },
  ): Promise<void> {
    await this.quarantineTimedOutExecution(context, params);
    await this.releaseBusinessLease(context);
  }

  private get executionClaimModel(): WebhookExecutionClaimModel | undefined {
    return (
      this.prisma as PrismaService & {
        webhookExecutionClaim?: WebhookExecutionClaimModel;
      }
    ).webhookExecutionClaim;
  }

  private async acquireBusinessLease(params: {
    webhookEventId: string;
    executionClaim: WebhookExecutionClaimRecord | null;
    executionClaimModel: WebhookExecutionClaimModel | undefined;
  }): Promise<string | null> {
    const { webhookEventId, executionClaim, executionClaimModel } = params;
    if (
      executionClaim?.enforced !== true ||
      !executionClaim.id ||
      executionClaim.webhookEventId !== webhookEventId ||
      typeof executionClaimModel?.updateMany !== 'function'
    ) {
      return null;
    }

    const now = new Date();
    const businessLeaseToken = randomUUID();
    const leaseResult = await executionClaimModel.updateMany({
      where: {
        id: executionClaim.id,
        status: 'READY',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseToken: businessLeaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_CANONICAL_BUSINESS_LEASE_MS),
      },
    });
    if (leaseResult?.count === 0) {
      throw new Error(`Canonical webhook business lease is busy for ${webhookEventId}`);
    }
    return businessLeaseToken;
  }

  private async releaseBusinessLease(context: WebhookCanonicalExecutionContext): Promise<void> {
    const executionClaimModel = this.executionClaimModel;
    if (!context.businessLeaseToken || typeof executionClaimModel?.updateMany !== 'function') {
      return;
    }

    await executionClaimModel
      .updateMany({
        where: {
          webhookEventId: context.webhookEvent.id,
          kind: 'EXECUTION',
          leaseToken: context.businessLeaseToken,
          status: 'READY',
        },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      .catch(() => undefined);
  }

  private isHotPathTimeoutQuarantined(webhookEvent: WebhookEvent): boolean {
    return (
      webhookEvent.status === WebhookStatus.FAILED &&
      webhookEvent.nextEnqueueAt === null &&
      typeof webhookEvent.errorMessage === 'string' &&
      webhookEvent.errorMessage.startsWith(`${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`)
    );
  }

  private buildHotPathTimeoutQuarantineMessage(errorMessage: string): string {
    return `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}: ${errorMessage}`.slice(
      0,
      WEBHOOK_EVENT_ERROR_MESSAGE_MAX_LENGTH,
    );
  }

  private normalizeBotId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
